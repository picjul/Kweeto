"""How Pixel learns from the teacher: training examples, the probe, size priors, and the track record.

Where the examples come from (all of it human-confirmed: rule 1, no feedback loop):
- positives:  every confirmed box (its own crop), plus the ingest candidate region that matches it
              (IoU >= 0.6). The latter is on exactly the same footing as the regions Pixel will score.
- background: on VERIFIED images only (finished in a Lesson), the candidate regions the teacher did not
              box: parts of an object, groups of objects, clutter. This is how Pixel learns *granularity*
              (one tomato, not the pile; the whole pipe, not its pieces). Explicit rejections count too.

The probe is re-fitted on all the examples after every teaching gesture (warm-started, so it costs
milliseconds): it can forget a deleted example, it does not depend on the order of the clicks.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import engine as eng
from .config import settings
from .models import Box, Negative, Outcome, Region, Verification

POS_IOU = 0.6
_cache: dict = {"key": None, "probe": None}


def _inside(a, b) -> float:
    """Fraction of box a that lies inside box b."""
    ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    area = a[2] * a[3]
    return ix * iy / area if area > 0 else 0.0


@dataclass
class Examples:
    positives: list[tuple[int, int]] = field(default_factory=list)   # (region_id, class_id)
    background: list[tuple[int, float]] = field(default_factory=list)  # (region_id, weight)
    geoms_by_class: dict[int, list[tuple]] = field(default_factory=lambda: defaultdict(list))
    counts: dict[str, int] = field(default_factory=dict)


def examples(db: Session) -> Examples:
    ex = Examples()
    st = eng.store
    boxes = db.execute(select(Box.id, Box.image_id, Box.class_id, Box.x, Box.y, Box.w, Box.h)).all()
    box_region = dict(db.execute(select(Region.box_id, Region.id).where(Region.kind == "box")).all())
    verified = set(db.scalars(select(Verification.image_id)))
    rejected = set(db.scalars(select(Negative.region_id)))

    by_img: dict[int, list] = defaultdict(list)
    for bid, iid, cid, x, y, w, h in boxes:
        g = (x, y, w, h)
        by_img[iid].append((g, cid, box_region.get(bid)))
        ex.geoms_by_class[cid].append(g)
        if bid in box_region:
            ex.positives.append((box_region[bid], cid))

    with st.lock:
        n = st.n
        rel = set(by_img) | verified
        rows = np.nonzero(st.active[:n] & (st.kind[:n] == eng.KIND_WINDOW) & np.isin(st.image_id[:n], list(rel)))[0]
        cands: dict[int, list] = defaultdict(list)
        for r in rows:
            cands[int(st.image_id[r])].append((int(st.region_id[r]), tuple(float(v) for v in st.geom[r]), int(r)))
        box_rows = {rid: st.row_of.get(rid) for _g, _c, rid in (b for bs in by_img.values() for b in bs) if rid}

        n_match = n_part = n_group = n_clutter = 0
        positive_regions: set[int] = set()
        for iid, cs in cands.items():
            bs = by_img.get(iid, [])
            for rid, g, row in cs:
                ious = [eng.iou(g, bg) for bg, _c, _r in bs]
                best = int(np.argmax(ious)) if ious else -1
                if best >= 0 and ious[best] >= POS_IOU:
                    _bg, cid, brid = bs[best]
                    brow = box_rows.get(brid)
                    if brow is None or not np.array_equal(st.vec[row], st.vec[brow]):  # skip accepted-proposal duplicates
                        ex.positives.append((rid, cid))
                        n_match += 1
                    positive_regions.add(rid)
                    continue
                if iid not in verified:
                    continue
                best_iou = ious[best] if ious else 0.0
                holds = sum(_inside(bg, g) >= 0.8 for bg, _c, _r in bs)
                if holds >= 2:
                    ex.background.append((rid, 1.0))   # a group of objects is not an object
                    n_group += 1
                elif best_iou < 0.5 and (best_iou >= 0.2 or any(_inside(g, bg) >= 0.8 for bg, _c, _r in bs)):
                    ex.background.append((rid, 1.0))   # a piece of an object, or a box around it + its shadow
                    n_part += 1
                elif best_iou < 0.2:
                    ex.background.append((rid, 0.5))   # clutter (weaker: it might be an unboxed object)
                    n_clutter += 1
                # 0.5 <= IoU < 0.6: almost the object, ambiguous -> not used

    # explicit "no": strong on verified images, weaker elsewhere (it may be an object of another class)
    seen = {r for r, _w in ex.background}
    for rid in rejected:
        if rid in positive_regions or rid in seen:
            continue
        row = st.row_of.get(rid)
        if row is None:
            continue
        ex.background.append((rid, 1.0 if int(st.image_id[row]) in verified else 0.5))

    # keep the background from swamping training time: all the strong ones, a fixed sample of the rest
    cap = max(300, 8 * len(ex.positives))
    if len(ex.background) > cap:
        strong = [b for b in ex.background if b[1] >= 1.0]
        weak = [b for b in ex.background if b[1] < 1.0]
        rng = np.random.default_rng(0)
        keep = max(0, cap - len(strong))
        if len(weak) > keep:
            weak = [weak[i] for i in sorted(rng.choice(len(weak), keep, replace=False))]
        ex.background = strong[:cap] + weak
    ex.counts = {"boxes": len(boxes), "matched": n_match, "parts": n_part, "groups": n_group,
                 "clutter": n_clutter, "verified": len(verified), "background": len(ex.background)}
    return ex


def probe_for(ex: Examples) -> tuple[eng.LinearProbe | None, float]:
    """Fits (or reuses) the probe for these examples. Returns (probe, class-blend weight)."""
    if not settings.use_probe or not ex.positives:
        _cache.update(key=None, probe=None)
        return None, 0.0
    pos = [(r, c) for r, c in ex.positives if r in eng.store.row_of]
    bg = [(r, w) for r, w in ex.background if r in eng.store.row_of] if settings.use_background else []
    key = (settings.probe, hash(tuple(sorted(pos))), hash(tuple(sorted(bg))))
    if _cache["key"] != key:
        rids = [r for r, _ in pos] + [r for r, _ in bg]
        y = np.array([c for _, c in pos] + [eng.BG] * len(bg), np.int64)
        sw = np.array([1.0] * len(pos) + [w for _, w in bg], np.float32)
        with eng.store.lock:
            rows = np.array([eng.store.row_of[r] for r in rids], np.int64)
            X = eng.features(eng.store, rows, use_geometry=True)
        from .plugins import PROBES

        trainer = PROBES.get(settings.probe)()  # always refitted on ALL the examples (rule 8), warm-started
        probe = trainer.fit(X, y, sw, init=_cache["probe"])
        if probe is not None:
            probe.use_geometry = True
        _cache.update(key=key, probe=probe)
    probe = _cache["probe"]
    n_cls = len({c for _, c in pos})
    ramp = min(1.0, len(pos) / max(1, n_cls * settings.probe_ramp))
    return probe, settings.probe_weight * ramp


def priors(ex: Examples) -> dict:
    return eng.size_priors(ex.geoms_by_class)


def describe(probe: eng.LinearProbe | None, weight: float, ex: Examples) -> dict | None:
    if probe is None:
        return None
    return {"kind": settings.probe, "examples": probe.n, "classes": int((probe.classes != eng.BG).sum()), "background": probe.has_bg,
            "train_acc": round(probe.train_acc, 3), "weight": round(weight, 2), "steps": probe.steps,
            "sources": ex.counts}


# ---------- track record (honest confidence) ----------

LEVELS = (("sure", 0.75), ("fair", 0.5), ("unsure", 0.0))
TRACK_WINDOW = 300


def level_of(conf: float) -> str:
    return next(name for name, lo in LEVELS if conf >= lo)


def record(db: Session, confidence: float, correct: bool, class_id: int | None, source: str) -> None:
    db.add(Outcome(confidence=float(confidence), correct=bool(correct), class_id=class_id, source=source))


def track_record(db: Session) -> dict[str, dict]:
    """How often Pixel's recent guesses were right, per confidence level."""
    rows = db.execute(select(Outcome.confidence, Outcome.correct).order_by(Outcome.id.desc())
                      .limit(TRACK_WINDOW)).all()
    out = {name: {"right": 0, "total": 0} for name, _ in LEVELS}
    for conf, ok in rows:
        t = out[level_of(conf)]
        t["total"] += 1
        t["right"] += int(bool(ok))
    return out


def learning_curve(db: Session, block: int = 50) -> dict | None:
    """Accuracy of Pixel's first judged guesses vs the latest ones: the proof that it learned."""
    oks = [bool(o) for o in db.scalars(select(Outcome.correct).order_by(Outcome.id))]
    if len(oks) < 20:
        return None
    b = min(block, len(oks) // 2)
    return {"total": len(oks), "block": b,
            "first": {"right": sum(oks[:b]), "total": b}, "recent": {"right": sum(oks[-b:]), "total": b}}


def reset_cache() -> None:
    _cache.update(key=None, probe=None)

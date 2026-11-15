"""Shared logic: proposal recomputation (propagation), lesson queue, serialisation."""
from __future__ import annotations

import random
import threading
from collections import defaultdict

import numpy as np
from sqlalchemy import delete, func, insert, select
from sqlalchemy.orm import Session

from . import engine as eng
from . import learning, profiles
from .config import QUEUE_SEED, settings
from .models import Box, Detection, DetectorScan, Event, ImageItem, LabelClass, Negative, Proposal, Region

_recompute_lock = threading.Lock()
effective: dict = {"sim_min": settings.sim_min, "sim_high": settings.sim_high, "calibrated": False, "profile": None,
                   "probe": None, "detector": None}

PALETTE = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c",
           "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#65a30d"]


# ---------- serialisation ----------

def image_out(img: ImageItem, box_count: int = 0) -> dict:
    return {
        "id": img.id, "filename": img.filename,
        "url": f"/files/images/{img.stored_name}", "thumb_url": f"/files/thumbs/{img.thumb_name}",
        "width": img.width, "height": img.height, "status": img.status, "box_count": box_count,
    }


def box_out(b: Box) -> dict:
    return {"id": b.id, "class_id": b.class_id, "x": b.x, "y": b.y, "w": b.w, "h": b.h, "source": b.source}


def proposal_out(p: Proposal, track: dict | None = None) -> dict:
    """`level` is a coarse confidence word; `track` is how often guesses of that level were right lately."""
    level = learning.level_of(p.confidence)
    return {"id": p.id, "region_id": p.region_id, "class_id": p.class_id, "second_class_id": p.second_class_id,
            "confidence": p.confidence, "margin": p.margin, "nn_sim": p.nn_sim,
            "level": level, "track": (track or {}).get(level),
            "x": p.x, "y": p.y, "w": p.w, "h": p.h}


def add_detector_opinion(db: Session, image_id: int, proposals: list[dict]) -> None:
    """When Pixel uses the detector: what it said about each guess (`detector`), so the UI can say it plainly.

    {"class_id", "score"} of the detector box matching the guess (IoU >= 0.5), {"class_id": None} when it looked
    at the image and saw nothing there; no key when the detector is not in use or has not seen the image yet.
    """
    run = detector_run()
    if run is None or not proposals:
        return
    dets = detections(db, run, [image_id])
    if dets is None or image_id not in dets:
        return
    cls, score, _scanned = eng.detector_evidence(
        np.full(len(proposals), image_id, np.int64),
        np.array([[p["x"], p["y"], p["w"], p["h"]] for p in proposals], np.float32), {image_id: dets[image_id]})
    for p, c, s in zip(proposals, cls, score):
        p["detector"] = {"class_id": int(c), "score": round(float(s), 2)} if c >= 0 else {"class_id": None, "score": 0.0}


def classes_out(db: Session) -> list[dict]:
    counts = dict(db.execute(select(Box.class_id, func.count(Box.id)).group_by(Box.class_id)).all())
    return [{"id": c.id, "name": c.name, "color": c.color, "box_count": counts.get(c.id, 0)}
            for c in db.scalars(select(LabelClass).order_by(LabelClass.id))]


def box_counts(db: Session, image_ids) -> dict[int, int]:
    if not image_ids:
        return {}
    return dict(db.execute(select(Box.image_id, func.count(Box.id))
                           .where(Box.image_id.in_(list(image_ids))).group_by(Box.image_id)).all())


def vec_of(region: Region) -> np.ndarray:
    return np.frombuffer(region.embedding, dtype=np.float32)


def add_image(db: Session, filename: str, data: bytes, known: set[str]) -> str:
    """Stores one uploaded image (file + thumbnail + row, status "pending": the worker scans it).

    `known` = content hashes already in the project (updated). Returns "uploaded", "duplicate" or "rejected".
    The caller commits.
    """
    out = store_image(db, filename, data, known)
    return out if isinstance(out, str) else "uploaded"


def store_image(db: Session, filename: str, data: bytes, known: set[str]) -> "ImageItem | str":
    """Like add_image, but returns the new (added, not yet flushed) row; "duplicate" / "rejected" otherwise."""
    import hashlib
    import io
    import uuid
    from pathlib import Path

    from PIL import Image, ImageOps

    from . import workspace
    from .config import ALLOWED_EXT, THUMB_SIZE

    name = Path(filename or "image").name
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        return "rejected"
    digest = hashlib.sha1(data).hexdigest()
    if digest in known:
        return "duplicate"
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception:
        return "rejected"
    known.add(digest)
    stem = uuid.uuid4().hex
    (workspace.images_dir() / f"{stem}{ext}").write_bytes(data)
    thumb = img.copy()
    thumb.thumbnail((THUMB_SIZE, THUMB_SIZE))
    thumb.save(workspace.thumbs_dir() / f"{stem}.jpg", "JPEG", quality=85)
    item = ImageItem(filename=name, stored_name=f"{stem}{ext}", width=img.width, height=img.height,
                     content_hash=digest, status="pending")
    db.add(item)
    return item


# ---------- engine ----------

def label_pairs(db: Session) -> list[tuple[int, int]]:
    return [(r, c) for r, c in db.execute(
        select(Region.id, Box.class_id).join(Box, Region.box_id == Box.id)).all()]


def _calibrate(labels) -> None:
    effective.update(sim_min=settings.sim_min, sim_high=settings.sim_high, calibrated=False, profile=None)
    if not settings.auto_calibrate:
        return
    prof = eng.similarity_profile(eng.store, labels)
    effective["profile"] = prof
    if prof and prof["same"] > prof["other"] + 0.02:
        lo = prof["other"]
        effective.update(sim_min=lo, sim_high=lo + 0.6 * (prof["same"] - lo), calibrated=True)


def _params(probe_weight: float) -> eng.Params:
    return eng.Params(sim_min=effective["sim_min"], sim_high=effective["sim_high"],
                      propose_min=settings.propose_min, knn_k=settings.knn_k,
                      temperature=settings.temperature, max_per_image=settings.max_per_image,
                      probe_weight=probe_weight, detector_weight=settings.detector_weight,
                      detector_veto=settings.detector_veto)


def detector_run() -> str | None:
    """The active detector, when Pixel is allowed to use it."""
    if not settings.use_detector:
        return None
    from . import detector_infer
    try:
        return detector_infer.active_id()
    except Exception:  # no project / no training folder
        return None


def detections(db: Session, run: str | None, image_ids: list[int] | None = None) -> dict[int, list] | None:
    """{image_id: [(class_id, score, (x, y, w, h))]} for the images this detector already looked at."""
    if run is None:
        return None
    sq = select(DetectorScan.image_id).where(DetectorScan.run == run)
    dq = select(Detection.image_id, Detection.class_id, Detection.score, Detection.x, Detection.y, Detection.w,
                Detection.h).where(Detection.run == run)
    if image_ids is not None:
        sq = sq.where(DetectorScan.image_id.in_(image_ids))
        dq = dq.where(Detection.image_id.in_(image_ids))
    out: dict[int, list] = {i: [] for i in db.scalars(sq)}
    for iid, cid, sc, x, y, w, h in db.execute(dq).all():
        if iid in out:
            out[iid].append((cid, sc, (x, y, w, h)))
    return out


def recompute(db: Session, origin_event_id: int | None = None) -> int:
    """Re-learns from everything taught so far and recomputes ALL proposals.

    The delta against the previous state is the propagation: images whose proposals changed are
    attributed to the originating event. Returns the number of changed images (the ⚡ counter).
    """
    with _recompute_lock:
        ex = learning.examples(db)
        labels = ex.positives
        negatives = [(r, c) for r, c in db.execute(select(Negative.region_id, Negative.class_id)).all()]
        targets = set(db.scalars(select(ImageItem.id).where(ImageItem.status == "embedded")).all())
        _calibrate(labels)
        probe, weight = learning.probe_for(ex)
        effective["probe"] = learning.describe(probe, weight, ex)
        priors = learning.priors(ex)

        old_sig: dict[int, set] = defaultdict(set)
        old_origin: dict[int, int | None] = {}
        for img_id, cls_id, reg_id, origin in db.execute(
                select(Proposal.image_id, Proposal.class_id, Proposal.region_id, Proposal.origin_event_id)
                .where(Proposal.is_control.is_(False))).all():
            old_sig[img_id].add((cls_id, reg_id))
            old_origin[img_id] = origin

        dets = detections(db, detector_run())
        effective["detector"] = None if dets is None else {"run": detector_run(), "images": len(dets)}
        new = eng.predict(eng.store, labels, negatives, targets, _params(weight), probe=probe, priors=priors,
                          detections=dets)
        db.execute(delete(Proposal).where(Proposal.is_control.is_(False)))

        by_img: dict[int, list] = defaultdict(list)
        for p in new:
            by_img[p["image_id"]].append(p)
        rows, delta = [], 0
        for img_id, props in by_img.items():
            sig = {(p["class_id"], p["region_id"]) for p in props}
            if sig != old_sig.get(img_id, set()):
                origin = origin_event_id
                delta += 1
            else:
                origin = old_origin.get(img_id)
            for p in props:
                rows.append({**p, "origin_event_id": origin, "is_control": False})
        if rows:
            db.execute(insert(Proposal), rows)
        if origin_event_id is not None:
            ev = db.get(Event, origin_event_id)
            if ev is not None:
                ev.delta_count = delta
        db.commit()
        return delta


def box_from_region(db: Session, region_id: int, class_id: int, source: str) -> Box | None:
    """Confirms a region as a box. Reuses the already computed embedding (no inference)."""
    reg = db.get(Region, region_id)
    if reg is None:
        return None
    b = Box(image_id=reg.image_id, class_id=class_id, x=reg.x, y=reg.y, w=reg.w, h=reg.h, source=source)
    db.add(b)
    db.flush()
    nr = Region(image_id=reg.image_id, kind="box", box_id=b.id, x=reg.x, y=reg.y, w=reg.w, h=reg.h,
                is_full=False, embedding=reg.embedding)
    db.add(nr)
    db.flush()
    eng.store.add([(nr.id, nr.image_id, eng.KIND_BOX, (nr.x, nr.y, nr.w, nr.h), False, vec_of(nr))])
    img = db.get(ImageItem, reg.image_id)
    if img is not None and img.status == "embedded":
        img.status = "annotated"
    return b


def reindex(db: Session, embeddings_changed: bool) -> None:
    """Drops what the current models can no longer use; the worker rebuilds it in the background.

    Always: the candidate regions (and the rejections/proposals pointing at them).
    If the embedding space changed: also the vectors of your boxes (the boxes themselves, verifications
    and the track record are kept; the worker re-embeds every box from its crop).
    """
    windows = select(Region.id).where(Region.kind.in_(["window", "detect"]))
    db.execute(delete(Negative).where(Negative.region_id.in_(windows)))
    db.execute(delete(Detection))      # the detector looks at the images again (its extra regions are dropped too)
    db.execute(delete(DetectorScan))
    if embeddings_changed:
        db.execute(delete(Proposal))
        db.execute(delete(Negative))
        db.execute(delete(Region))
        db.commit()
        eng.store.clear()
    else:
        old = list(db.scalars(windows))
        db.execute(delete(Proposal).where(Proposal.is_control.is_(False)))
        db.execute(delete(Region).where(Region.kind.in_(["window", "detect"])))
        db.commit()
        eng.store.remove(old)
    learning.reset_cache()


def sync_engine(db: Session) -> dict:
    """Makes the stored data match the active profile. Returns what had to be redone."""
    cfg = profiles.active
    had = profiles.stored()
    has_data = db.scalar(select(func.count(Region.id))) or 0
    data_sig = had.get("data_signature") or (profiles.LEGACY_SIGNATURE if has_data else None)
    scan_sig = had.get("scan_signature")
    embeddings_changed = bool(has_data) and data_sig != cfg.signature
    scan_changed = bool(has_data) and scan_sig != cfg.scan_signature
    if embeddings_changed or scan_changed:
        reindex(db, embeddings_changed)
    profiles.record(cfg)
    return {"embeddings_changed": embeddings_changed, "rescan": embeddings_changed or scan_changed}


def delete_images(db: Session, image_ids: list[int]) -> int:
    """Deletes images and everything attached to them (boxes, regions, rejections, proposals,
    verifications), their vectors and their files. The track record and the event log are kept."""
    from . import workspace
    from .models import Verification

    imgs = list(db.scalars(select(ImageItem).where(ImageItem.id.in_(image_ids))))
    if not imgs:
        return 0
    ids = [i.id for i in imgs]
    region_ids = list(db.scalars(select(Region.id).where(Region.image_id.in_(ids))))
    db.execute(delete(Negative).where(Negative.region_id.in_(region_ids)))
    db.execute(delete(Proposal).where(Proposal.image_id.in_(ids) | Proposal.region_id.in_(region_ids)))
    db.execute(delete(Verification).where(Verification.image_id.in_(ids)))
    db.execute(delete(Detection).where(Detection.image_id.in_(ids)))
    db.execute(delete(DetectorScan).where(DetectorScan.image_id.in_(ids)))
    db.execute(delete(Region).where(Region.image_id.in_(ids)))
    db.execute(delete(Box).where(Box.image_id.in_(ids)))
    files = [(workspace.images_dir() / i.stored_name, workspace.thumbs_dir() / i.thumb_name) for i in imgs]
    db.execute(delete(ImageItem).where(ImageItem.id.in_(ids)))
    db.commit()
    eng.store.remove(region_ids)
    learning.reset_cache()
    for pair in files:
        for f in pair:
            try:
                f.unlink(missing_ok=True)
            except OSError:  # pragma: no cover - a file still open somewhere: harmless leftover
                pass
    return len(ids)


def judge(db: Session, image_id: int, region_id: int, correct: bool, source: str) -> None:
    """Records the outcome of the (non-control) proposal currently shown for this region."""
    p = db.scalar(select(Proposal).where(Proposal.image_id == image_id, Proposal.region_id == region_id,
                                         Proposal.is_control.is_(False)).limit(1))
    if p is not None:
        learning.record(db, p.confidence, correct, p.class_id, source)


def add_negative(db: Session, region_id: int, class_id: int) -> None:
    if db.get(Region, region_id) is None:
        return
    exists = db.scalar(select(Negative.id).where(Negative.region_id == region_id, Negative.class_id == class_id))
    if not exists:
        db.add(Negative(region_id=region_id, class_id=class_id))


def pick_origin(events: list[Event]) -> Event | None:
    for t in ("correct", "label", "accept", "question", "batch_review", "reject"):
        for e in events:
            if e.type == t:
                return e
    return None


# ---------- lesson queue ----------

def next_image(db: Session, position: int, exclude: list[int]) -> tuple[int | None, str]:
    """Pacing: 3 hard cases + 1 easy one. Without labels: random exploration.

    No image ready: "waiting" while some are still being scanned (the Lesson waits for them), else "done"."""
    q = select(ImageItem.id).where(ImageItem.status == "embedded")
    if exclude:
        q = q.where(ImageItem.id.not_in(exclude))
    eligible = set(db.scalars(q).all())
    if not eligible:
        # images still being scanned are not ready yet: "waiting", not "done" (Pixel must not say it has nothing left)
        scanning = db.scalar(select(func.count(ImageItem.id)).where(ImageItem.status == "pending")) or 0
        return None, "waiting" if scanning else "done"
    rng = random.Random(f"{QUEUE_SEED}:{position}") if QUEUE_SEED else random.Random()
    if (db.scalar(select(func.count(Box.id))) or 0) == 0:
        return rng.choice(sorted(eligible)), "explore"

    best = {i: c for i, c in db.execute(
        select(Proposal.image_id, func.max(Proposal.confidence))
        .where(Proposal.is_control.is_(False)).group_by(Proposal.image_id)).all() if i in eligible}

    if position % 4 == 3:
        easy = [i for i, c in best.items() if c >= 0.8]
        if easy:
            return rng.choice(easy), "easy"
    hard = sorted((abs(c - 0.55), i) for i, c in best.items() if c < 0.8)
    if hard:
        return rng.choice(hard[:10])[1], "hard"
    unknown = sorted(eligible - set(best))
    if unknown:
        return rng.choice(unknown), "explore"
    return rng.choice(sorted(best)), "easy"

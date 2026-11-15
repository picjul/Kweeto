"""Apprentice Questions: concept-level questions, generated only from real signals."""
from __future__ import annotations

from collections import defaultdict

import numpy as np
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from . import engine as eng
from . import pixel, services
from .models import Box, Event, ImageItem, LabelClass, Proposal, Question, Region

FEW_EXAMPLES = 5
NOVELTY_MIN = 10
CONFUSION_MARGIN = 0.25
CONFUSION_MIN = 5


def _thumbs(db: Session, image_ids: list[int]) -> list[dict]:
    imgs = {i.id: i for i in db.scalars(select(ImageItem).where(ImageItem.id.in_(image_ids)))}
    return [{"image_id": i, "thumb_url": f"/files/thumbs/{imgs[i].thumb_name}"} for i in image_ids if i in imgs]


def generate(db: Session) -> list[Question]:
    db.execute(delete(Question).where(Question.status == "open"))
    dismissed = set(db.scalars(select(Question.signature).where(Question.status == "dismissed")))
    classes = {c.id: c for c in db.scalars(select(LabelClass))}
    counts = dict(db.execute(select(Box.class_id, func.count(Box.id)).group_by(Box.class_id)).all())
    embedded = list(db.scalars(select(ImageItem.id).where(ImageItem.status == "embedded")))
    out: list[Question] = []

    def add(qtype: str, sig: str, text: str, payload: dict) -> None:
        if sig in dismissed:
            return
        q = Question(type=qtype, signature=sig, text=text, payload=payload, status="open")
        db.add(q)
        out.append(q)

    if not embedded:
        db.commit()
        return out

    # 1) Few examples: ask to teach the class, starting from images where Pixel suspects it
    for c in classes.values():
        n = counts.get(c.id, 0)
        if n >= FEW_EXAMPLES:
            continue
        ids = list(db.scalars(select(Proposal.image_id).where(Proposal.class_id == c.id, Proposal.is_control.is_(False))
                              .order_by(Proposal.confidence.desc()).limit(12)))
        ids = list(dict.fromkeys(ids))
        if len(ids) < 12:
            extra = db.scalars(select(ImageItem.id).where(ImageItem.status == "embedded", ImageItem.id.not_in(ids))
                               .order_by(func.random()).limit(12 - len(ids)))
            ids += list(extra)
        add("few_examples", f"few:{c.id}:{n}", pixel.q_few_examples(c.name, n),
            {"class_id": c.id, "class_name": c.name, "count": n, "image_ids": ids, "samples": _thumbs(db, ids[:8])})

    labels = services.label_pairs(db)
    P = eng.label_matrix(eng.store, labels)

    # 2) Novelty: groups of images far from everything taught so far
    if P is not None:
        ids, vecs = eng.full_vectors(eng.store, embedded)
        if len(ids):
            sims, _ = eng.topk_ip(P, vecs, 1)
            low = sims[:, 0] < services.effective["sim_min"]
            if low.sum() >= NOVELTY_MIN:
                lid, lvec = ids[low], vecs[low]
                k = int(min(5, max(1, low.sum() // 15)))
                assign = eng.kmeans(lvec, k)
                for c in range(k):
                    members = np.nonzero(assign == c)[0]
                    if len(members) < NOVELTY_MIN:
                        continue
                    centroid = lvec[members].mean(axis=0)
                    order = members[np.argsort(-(lvec[members] @ centroid))]
                    mids = [int(i) for i in lid[order]]
                    add("novelty", f"novelty:{mids[0]}:{len(mids) // 10}", pixel.q_novelty(len(mids)),
                        {"count": len(mids), "image_ids": mids[:200], "samples": _thumbs(db, mids[:8])})

    # 3) Confusion: class pairs with a low margin on many proposals
    pairs: dict[tuple[int, int], list[Proposal]] = defaultdict(list)
    for p in db.scalars(select(Proposal).where(Proposal.is_control.is_(False), Proposal.second_class_id.is_not(None),
                                               Proposal.margin < CONFUSION_MARGIN)):
        key = tuple(sorted((p.class_id, p.second_class_id)))
        pairs[key].append(p)
    ranked = sorted(pairs.items(), key=lambda kv: -len(kv[1]))
    for (a, b), props in ranked[:2]:
        if len(props) < CONFUSION_MIN or a not in classes or b not in classes:
            continue
        props = sorted(props, key=lambda p: p.margin)[:10]
        thumbs = {t["image_id"]: t["thumb_url"] for t in _thumbs(db, [p.image_id for p in props])}
        items = [{"region_id": p.region_id, "image_id": p.image_id, "thumb_url": thumbs.get(p.image_id),
                  "proposed_class_id": p.class_id, "confidence": p.confidence,
                  "x": p.x, "y": p.y, "w": p.w, "h": p.h} for p in props]
        add("confusion", f"confusion:{a}:{b}:{len(pairs[(a, b)]) // 10}",
            pixel.q_confusion(classes[a].name, classes[b].name),
            {"class_a": a, "class_b": b, "name_a": classes[a].name, "name_b": classes[b].name, "items": items})

    db.commit()
    return out


def question_out(q: Question) -> dict:
    return {"id": q.id, "type": q.type, "text": q.text, "status": q.status, "payload": q.payload}


def answer(db: Session, q: Question, action: str, assignments) -> dict:
    payload = q.payload or {}
    result: dict = {"message": "Thanks.", "queue": [], "delta_count": 0}

    if q.type in ("few_examples", "novelty") and action == "annotate":
        result["queue"] = payload.get("image_ids", [])[:20]
        result["message"] = "Great, I'll show you those images."
        q.status = "answered"
        db.commit()
        return result

    if q.type == "novelty" and action == "ignore":
        ids = payload.get("image_ids", [])
        for img in db.scalars(select(ImageItem).where(ImageItem.id.in_(ids), ImageItem.status == "embedded")):
            img.status = "ignored"
        ev = Event(type="question", payload={"question": q.type, "action": "ignore", "count": len(ids)})
        db.add(ev)
        q.status = "answered"
        db.commit()
        services.recompute(db, ev.id)
        result["message"] = f"OK, I'll ignore those {len(ids)} images."
        return result

    if q.type == "confusion":
        ev = Event(type="question", payload={"question": "confusion", "class_a": payload.get("class_a"),
                                             "class_b": payload.get("class_b")})
        db.add(ev)
        db.flush()
        labeled = rejected = 0
        for a in assignments:
            reg = db.get(Region, a.region_id)
            if reg is not None:
                services.judge(db, reg.image_id, a.region_id, a.class_id == a.proposed_class_id, "question")
            if a.class_id is None:
                for cid in (payload.get("class_a"), payload.get("class_b")):
                    if cid is not None:
                        services.add_negative(db, a.region_id, cid)
                rejected += 1
            else:
                if a.class_id != a.proposed_class_id:
                    services.add_negative(db, a.region_id, a.proposed_class_id)
                if services.box_from_region(db, a.region_id, a.class_id, "question"):
                    labeled += 1
        q.status = "answered"
        db.commit()
        delta = services.recompute(db, ev.id)
        result.update(delta_count=delta,
                      message=f"Thanks, now I see the difference better. {labeled} new examples, {rejected} discarded"
                              + (f", and I changed my mind on {delta} images." if delta else "."))
        return result

    q.status = "answered"
    db.commit()
    return result

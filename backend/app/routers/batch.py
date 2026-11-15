"""Batch Review ("Harvest"): confident proposals grouped by originating lesson + hidden control checks."""
from __future__ import annotations

import random
from collections import Counter, defaultdict
from statistics import median

from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .. import learning, pixel, services
from ..config import MAX_GROUP_ITEMS, settings
from ..db import get_db
from ..models import Box, Event, ImageItem, LabelClass, Proposal, Region
from ..schemas import BatchReviewIn

router = APIRouter(prefix="/api/batch", tags=["batch"])
CONTROL_MIN_GROUP = 8


def _item(p: Proposal, img: ImageItem) -> dict:
    return {"proposal_id": p.id, "region_id": p.region_id, "image_id": p.image_id,
            "thumb_url": f"/files/thumbs/{img.thumb_name}", "class_id": p.class_id,
            "confidence": p.confidence, "level": learning.level_of(p.confidence),
            "x": p.x, "y": p.y, "w": p.w, "h": p.h}


def _make_control(db: Session, group_class: int, conf: float, origin: int | None) -> Proposal | None:
    """A confirmed box of another class, shown with the wrong label."""
    candidates = list(db.execute(
        select(Box, Region.id).join(Region, Region.box_id == Box.id).where(Box.class_id != group_class)
        .limit(200)).all())
    if not candidates:
        return None
    box, region_id = random.choice(candidates)
    p = Proposal(image_id=box.image_id, region_id=region_id, class_id=group_class, second_class_id=None,
                 confidence=conf, margin=0.5, nn_sim=0.0, x=box.x, y=box.y, w=box.w, h=box.h,
                 origin_event_id=origin, is_control=True)
    db.add(p)
    return p


@router.get("")
def get_batch(db: Session = Depends(get_db)):
    db.execute(delete(Proposal).where(Proposal.is_control.is_(True)))
    db.commit()
    props = list(db.scalars(select(Proposal).where(Proposal.is_control.is_(False),
                                                   Proposal.confidence >= settings.batch_min)
                            .order_by(Proposal.confidence.desc())))
    groups: dict[int | None, list[Proposal]] = defaultdict(list)
    for p in props:
        groups[p.origin_event_id].append(p)
    ev_ids = [k for k in groups if k is not None]
    events = {e.id: e for e in db.scalars(select(Event).where(Event.id.in_(ev_ids)))}
    classes = {c.id: c for c in db.scalars(select(LabelClass))}
    imgs = {i.id: i for i in db.scalars(select(ImageItem).where(ImageItem.id.in_({p.image_id for p in props})))}

    out = []
    rng = random.Random()
    for key, items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        shown = items[:MAX_GROUP_ITEMS]
        payload = [_item(p, imgs[p.image_id]) for p in shown if p.image_id in imgs]
        if len(shown) >= CONTROL_MIN_GROUP:
            dominant = Counter(p.class_id for p in shown).most_common(1)[0][0]
            ctrl = _make_control(db, dominant, median(p.confidence for p in shown), key)
            if ctrl is not None:
                db.flush()
                cimg = db.get(ImageItem, ctrl.image_id)
                if cimg is not None:
                    payload.insert(rng.randrange(len(payload) + 1), _item(ctrl, cimg))
        out.append({"id": key or 0, "title": pixel.origin_title(events.get(key), classes),
                    "total": len(items), "items": payload})
    db.commit()
    return {"groups": out, "total": len(props), "message": pixel.batch_intro(len(props))}


@router.post("/review")
def review(body: BatchReviewIn, db: Session = Depends(get_db)):
    ids = [it.proposal_id for it in body.accept + body.reject + body.correct]
    controls = {p.id: p for p in db.scalars(select(Proposal).where(Proposal.id.in_(ids), Proposal.is_control.is_(True)))}
    # controls always point to "box" regions (already confirmed); real proposals to "window" regions
    region_ids = [it.region_id for it in body.accept + body.reject + body.correct]
    box_regions = set(db.scalars(select(Region.id).where(Region.id.in_(region_ids), Region.kind == "box")))
    for it in body.accept + body.reject + body.correct:
        if it.region_id in box_regions:
            controls.setdefault(it.proposal_id, None)
    accepted = rejected = corrected = found = missed = 0
    # track record: how the real (non-control) guesses fared
    shown = {p.id: p for p in db.scalars(select(Proposal).where(Proposal.id.in_(ids), Proposal.is_control.is_(False)))}
    for items, ok in ((body.accept, True), (body.reject, False), (body.correct, False)):
        for it in items:
            p = shown.get(it.proposal_id)
            if p is not None and it.proposal_id not in controls:
                learning.record(db, p.confidence, ok, p.class_id, "harvest")
    review_ev = Event(type="batch_review")
    db.add(review_ev)
    db.flush()
    corrections: list[Event] = []

    for it in body.accept:
        if it.proposal_id in controls:
            missed += 1
            continue
        if services.box_from_region(db, it.region_id, it.class_id, "batch"):
            accepted += 1
    for it in body.reject:
        if it.proposal_id in controls:
            found += 1
            continue
        services.add_negative(db, it.region_id, it.class_id)
        rejected += 1
    for it in body.correct:
        if it.proposal_id in controls:
            found += 1
            continue
        wrong = it.from_class_id
        if wrong is not None:
            services.add_negative(db, it.region_id, wrong)
        b = services.box_from_region(db, it.region_id, it.class_id, "batch")
        if b is not None:
            ev = Event(type="correct", image_id=b.image_id, class_id=it.class_id, from_class_id=wrong)
            db.add(ev)
            corrections.append(ev)
            corrected += 1

    for p in controls.values():
        if p is not None:
            db.delete(p)
    review_ev.payload = {"accepted": accepted, "rejected": rejected, "corrected": corrected,
                         "controls_found": found, "controls_missed": missed}
    db.commit()
    origin = corrections[0] if corrections else review_ev
    delta = services.recompute(db, origin.id)
    return {"accepted": accepted, "rejected": rejected, "corrected": corrected,
            "controls_found": found, "controls_missed": missed, "delta_count": delta,
            "message": pixel.after_review(accepted, rejected, corrected, found, missed, delta)}

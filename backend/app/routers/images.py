"""Upload, gallery, detail, deletion, similarity search, lesson queue and annotation saving."""
from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import embedder, learning, pixel, segmenter, services, workspace
from .. import engine as eng
from ..config import BOX_PAD
from ..db import get_db
from ..models import Box, Event, ImageItem, LabelClass, Proposal, Region, Verification
from ..schemas import AnnotationSave, ImageIdsIn, SegmentIn
from ..worker import worker

router = APIRouter(prefix="/api", tags=["images"])


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, float(v)))


@router.post("/images/upload")
def upload_images(files: list[UploadFile] = File(...), db: Session = Depends(get_db)):
    counts = {"uploaded": 0, "duplicate": 0, "rejected": 0}
    known = set(db.scalars(select(ImageItem.content_hash)))
    for f in files:
        counts[services.add_image(db, f.filename or "image", f.file.read(), known)] += 1
    db.commit()
    uploaded, duplicates, rejected = counts["uploaded"], counts["duplicate"], counts["rejected"]
    worker.wake()
    return {"uploaded": uploaded, "duplicates": duplicates, "rejected": rejected}


@router.get("/images")
def list_images(status: str | None = None, offset: int = 0, limit: int = Query(60, ge=1, le=500),
                q: str | None = Query(None, max_length=200), db: Session = Depends(get_db)):
    """Images of the project; `q` = part of the file name (case-insensitive), e.g. for the command palette."""
    text = (q or "").strip()
    q = select(ImageItem)
    if status:
        q = q.where(ImageItem.status == status)
    if text:  # literal match: % and _ in the text are not wildcards
        like = text.replace("!", "!!").replace("%", "!%").replace("_", "!_")
        q = q.where(ImageItem.filename.ilike(f"%{like}%", escape="!"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    imgs = list(db.scalars(q.order_by(ImageItem.id).offset(offset).limit(limit)))
    counts = services.box_counts(db, [i.id for i in imgs])
    return {"total": total, "items": [services.image_out(i, counts.get(i.id, 0)) for i in imgs]}


@router.get("/images/{image_id}")
def get_image(image_id: int, db: Session = Depends(get_db)):
    img = db.get(ImageItem, image_id)
    if img is None:
        raise HTTPException(404, "Image not found")
    boxes = list(db.scalars(select(Box).where(Box.image_id == image_id).order_by(Box.id)))
    props = list(db.scalars(select(Proposal).where(Proposal.image_id == image_id, Proposal.is_control.is_(False))
                            .order_by(Proposal.confidence.desc())))
    track = learning.track_record(db) if props else {}
    out = [services.proposal_out(p, track) for p in props]
    services.add_detector_opinion(db, image_id, out)
    return {**services.image_out(img, len(boxes)),
            "verified": db.get(Verification, image_id) is not None,
            "boxes": [services.box_out(b) for b in boxes],
            "proposals": out,
            "track_line": pixel.track_line(out[0]["level"], out[0]["track"]) if out else None}


@router.delete("/images/{image_id}")
def delete_image(image_id: int, db: Session = Depends(get_db)):
    """Deletes one image with its boxes and regions (the files too). Proposals are recomputed."""
    if not services.delete_images(db, [image_id]):
        raise HTTPException(404, "Image not found")
    services.recompute(db)
    return {"deleted": 1}


@router.post("/images/delete")
def delete_images(body: ImageIdsIn, db: Session = Depends(get_db)):
    """Bulk deletion (Gallery selection)."""
    n = services.delete_images(db, body.ids)
    if n:
        services.recompute(db)
    return {"deleted": n}


@router.get("/images/{image_id}/similar")
def similar(image_id: int, k: int = Query(12, ge=1, le=100), db: Session = Depends(get_db)):
    res = eng.similar_images(eng.store, image_id, k)
    ids = [i for i, _ in res]
    imgs = {i.id: i for i in db.scalars(select(ImageItem).where(ImageItem.id.in_(ids)))}
    classes_by_img: dict[int, list[int]] = {}
    for iid, cid in db.execute(select(Box.image_id, Box.class_id).where(Box.image_id.in_(ids))).all():
        classes_by_img.setdefault(iid, []).append(cid)
    out = []
    for iid, sim in res:
        if iid not in imgs:
            continue
        img = imgs[iid]
        out.append({"image_id": iid, "similarity": sim, "thumb_url": f"/files/thumbs/{img.thumb_name}",
                    "status": img.status, "box_count": len(classes_by_img.get(iid, [])),
                    "classes": sorted(set(classes_by_img.get(iid, [])))})
    return out


@router.get("/images/{image_id}/detector")
def detector_view(image_id: int, db: Session = Depends(get_db)):
    """The project's active trained detector on this image ({"run": null} when there is none)."""
    from .. import detector_infer

    try:
        return detector_infer.detect(db, image_id)
    except KeyError as e:
        raise HTTPException(404, "Image not found") from e
    except Exception as e:  # a broken model must not break the page
        raise HTTPException(500, f"The detector failed: {type(e).__name__}: {e}") from e


@router.post("/images/{image_id}/segment/prepare")
def prepare_segment(image_id: int, background: BackgroundTasks, db: Session = Depends(get_db)):
    """Warms the segmenter for this image in the background (SAM's encoder takes seconds on CPU)."""
    img = db.get(ImageItem, image_id)
    if img is None:
        raise HTTPException(404, "Image not found")
    path = workspace.images_dir() / img.stored_name

    def _warm() -> None:
        try:
            segmenter.prepare(str(path), embedder.load_image(path))
        except Exception:  # pragma: no cover - a failed warm-up only means a slower first click
            logging.getLogger("kweeto.segmenter").exception("prepare failed for image %s", image_id)

    background.add_task(_warm)
    return {"ok": True}


@router.post("/images/{image_id}/segment")
def segment_image(image_id: int, body: SegmentIn, db: Session = Depends(get_db)):
    """Click-to-box / box snapping: returns a tight box around the indicated object (normalised)."""
    img = db.get(ImageItem, image_id)
    if img is None:
        raise HTTPException(404, "Image not found")
    path = workspace.images_dir() / img.stored_name
    try:
        box, score = segmenter.segment(str(path), embedder.load_image(path),
                                       points=[tuple(p) for p in body.points], box=body.box)
    except Exception as e:  # model missing, out of memory, ...
        raise HTTPException(503, f"Segmenter unavailable: {e}") from e
    return {"box": None if box is None else {"x": box[0], "y": box[1], "w": box[2], "h": box[3]},
            "score": score, "segmenter": segmenter.name()}


@router.get("/queue/next")
def next_in_queue(position: int = 0, exclude: str = "", db: Session = Depends(get_db)):
    ex = [int(x) for x in exclude.split(",") if x.strip().isdigit()]
    image_id, reason = services.next_image(db, position, ex)
    return {"image_id": image_id, "reason": reason}


@router.put("/images/{image_id}/annotations")
def save_annotations(image_id: int, body: AnnotationSave, db: Session = Depends(get_db)):
    img = db.get(ImageItem, image_id)
    if img is None:
        raise HTTPException(404, "Image not found")
    if img.status in ("pending", "error"):
        raise HTTPException(409, "Pixel has not analysed this image yet")
    classes = {c.id: c for c in db.scalars(select(LabelClass))}
    existing = {b.id: b for b in db.scalars(select(Box).where(Box.image_id == image_id))}
    events: list[Event] = []
    keep: set[int] = set()
    manual: list[Box] = []

    for bi in body.boxes:
        if bi.class_id not in classes:
            raise HTTPException(400, f"Class {bi.class_id} does not exist")
        if bi.id is not None and bi.id in existing:
            b = existing[bi.id]
            keep.add(b.id)
            if b.class_id != bi.class_id:
                events.append(Event(type="correct", image_id=image_id, class_id=bi.class_id, from_class_id=b.class_id))
                b.class_id = bi.class_id
            continue

        x, y = _clamp01(bi.x), _clamp01(bi.y)
        w, h = max(0.002, min(bi.w, 1 - x)), max(0.002, min(bi.h, 1 - y))
        reg = db.get(Region, bi.proposal_region_id) if bi.proposal_region_id else None
        if reg is not None and reg.image_id == image_id:
            # accepted proposal (possibly with a changed class): reuse the window's embedding
            services.judge(db, image_id, reg.id, bi.proposal_class_id in (None, bi.class_id), "lesson")
            b = services.box_from_region(db, reg.id, bi.class_id, "proposal")
            if bi.proposal_class_id is not None and bi.proposal_class_id != bi.class_id:
                services.add_negative(db, reg.id, bi.proposal_class_id)
                events.append(Event(type="correct", image_id=image_id, class_id=bi.class_id,
                                    from_class_id=bi.proposal_class_id))
            else:
                events.append(Event(type="accept", image_id=image_id, class_id=bi.class_id))
            continue

        b = Box(image_id=image_id, class_id=bi.class_id, x=x, y=y, w=w, h=h, source="manual")
        db.add(b)
        manual.append(b)
        over = next((r for r in body.rejected if eng.iou((x, y, w, h), (r.x, r.y, r.w, r.h)) > 0.4), None)
        if over is not None and over.class_id != bi.class_id:
            events.append(Event(type="correct", image_id=image_id, class_id=bi.class_id, from_class_id=over.class_id))
        else:
            events.append(Event(type="label", image_id=image_id, class_id=bi.class_id))

    # boxes removed by the user
    for bid, b in existing.items():
        if bid not in keep:
            rids = list(db.scalars(select(Region.id).where(Region.box_id == bid)))
            eng.store.remove(rids)
            for r in db.scalars(select(Region).where(Region.box_id == bid)):
                db.delete(r)
            db.delete(b)

    # embeddings for hand-drawn boxes
    db.flush()
    if manual:
        pil = embedder.load_image(workspace.images_dir() / img.stored_name)
        vecs = embedder.embed_images([embedder.crop_norm(pil, b.x, b.y, b.w, b.h, pad=BOX_PAD) for b in manual])
        regs = [Region(image_id=image_id, kind="box", box_id=b.id, x=b.x, y=b.y, w=b.w, h=b.h, is_full=False,
                       embedding=v.astype("float32").tobytes()) for b, v in zip(manual, vecs)]
        db.add_all(regs)
        db.flush()
        eng.store.add([(r.id, image_id, eng.KIND_BOX, (r.x, r.y, r.w, r.h), False, services.vec_of(r)) for r in regs])

    # proposals shown but not accepted = negatives
    accepted_regions = {bi.proposal_region_id for bi in body.boxes if bi.proposal_region_id}
    for r in body.rejected:
        if r.region_id in accepted_regions:
            continue
        services.judge(db, image_id, r.region_id, False, "lesson")
        services.add_negative(db, r.region_id, r.class_id)
        events.append(Event(type="reject", image_id=image_id, class_id=r.class_id))

    if body.done:
        # "every object is boxed": the rest of the image becomes background Pixel can learn from
        if db.get(Verification, image_id) is None:
            db.add(Verification(image_id=image_id))
        if img.status == "embedded":
            img.status = "annotated"
    db.add_all(events)
    db.commit()

    origin = services.pick_origin(events)
    delta = services.recompute(db, origin.id if origin else None)
    to_name = classes[origin.class_id].name if origin and origin.class_id in classes else None
    from_name = classes[origin.from_class_id].name if origin and origin.from_class_id in classes else None
    return {"delta_count": delta, "status": img.status,
            "message": pixel.after_save(origin.type if origin else None, delta, to_name, from_name)}

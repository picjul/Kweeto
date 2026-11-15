"""Stats, engine settings and profiles, reset, re-scan."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .. import detector, embedder, learning, pixel, profiles, runtime, segmenter, services, workspace
from .. import engine as eng
from ..config import PROPOSER, settings
from ..db import get_db
from ..models import (Box, Event, HealthDismissal, ImageItem, LessonSession, Negative, Outcome, Proposal, Question,
                      Region, Verification)
from ..schemas import ProfileIn, SettingsIn
from ..worker import worker

router = APIRouter(prefix="/api", tags=["system"])
HUMAN_EVENTS = ("label", "accept", "correct", "reject", "batch_review", "question")


@router.get("/stats")
def stats(db: Session = Depends(get_db)):
    counts = dict(db.execute(select(ImageItem.status, func.count(ImageItem.id)).group_by(ImageItem.status)).all())
    images = {s: counts.get(s, 0) for s in ("pending", "embedded", "annotated", "ignored", "error")}
    images["total"] = sum(images.values())
    s = {
        "images": images,
        "classes": services.classes_out(db),
        "boxes": db.scalar(select(func.count(Box.id))) or 0,
        "proposals": db.scalar(select(func.count(Proposal.id)).where(Proposal.is_control.is_(False))) or 0,
        "batch_ready": db.scalar(select(func.count(Proposal.id)).where(
            Proposal.is_control.is_(False), Proposal.confidence >= settings.batch_min)) or 0,
        "gestures": db.scalar(select(func.count(Event.id)).where(Event.type.in_(HUMAN_EVENTS))) or 0,
        "propagated": db.scalar(select(func.coalesce(func.sum(Event.delta_count), 0))) or 0,
        "verified": db.scalar(select(func.count(Verification.image_id))) or 0,
        "track": learning.track_record(db),
        "learning": learning.learning_curve(db),
        "worker": dict(worker.progress),
        "engine": {"profile": profiles.active.profile, "embedder": profiles.active.embedder,
                   "model": profiles.active.model, "device": embedder.device(),
                   "segmenter_device": segmenter.device(), "runtime": runtime.info(),
                   "faiss": eng.HAS_FAISS, "vectors": eng.store.size(),
                   "segmenter": segmenter.name(), "proposer": PROPOSER,
                   "probe": services.effective.get("probe")},
    }
    s["project"] = {"id": workspace.current.id, "name": workspace.current.name}
    s["pixel_name"] = workspace.current.pixel.name
    s["detector"] = _detector_state(db)
    try:
        s["suggestion"] = detector.suggestion(db)
    except Exception:  # never let the advice break the stats
        s["suggestion"] = None
    s["pixel_message"] = pixel.home_message(s)
    return s


def _detector_state(db: Session) -> dict | None:
    """The project's active detector as Pixel's extra evidence: is it used, how many images it looked at."""
    from .. import detector_infer
    from ..models import Detection, DetectorScan
    from ..worker import _detector_todo

    try:
        run = detector_infer.active_id()
    except Exception:
        return None
    if run is None:
        return None
    return {"run": run, "used": settings.use_detector,
            "scanned": db.scalar(select(func.count()).select_from(DetectorScan).where(DetectorScan.run == run)) or 0,
            "todo": len(_detector_todo(db, run)),
            "boxes": db.scalar(select(func.count()).select_from(Detection).where(Detection.run == run)) or 0,
            "regions": db.scalar(select(func.count(Region.id)).where(Region.kind == "detect")) or 0}


@router.get("/settings")
def get_settings():
    return {"settings": settings.as_dict(), "effective": services.effective}


@router.put("/settings")
def put_settings(body: SettingsIn, db: Session = Depends(get_db)):
    changes = body.model_dump(exclude_none=True)
    if "probe" in changes:
        from ..plugins import PROBES

        if changes["probe"] not in PROBES:
            raise HTTPException(400, f"Unknown probe {changes['probe']!r}: choose one of {', '.join(PROBES.ids())}")
    for k, v in changes.items():
        setattr(settings, k, v)
    services.recompute(db)
    return {"settings": settings.as_dict(), "effective": services.effective}


@router.post("/reset")
def reset_annotations(db: Session = Depends(get_db)):
    """Deletes everything the user has taught (images and embeddings are kept)."""
    box_regions = list(db.scalars(select(Region.id).where(Region.kind == "box")))
    db.execute(delete(Negative))
    db.execute(delete(Proposal))
    db.execute(delete(Region).where(Region.kind == "box"))
    db.execute(delete(Box))
    db.execute(delete(Event))
    db.execute(delete(Question))
    db.execute(delete(Outcome))
    db.execute(delete(Verification))
    db.execute(delete(LessonSession))
    db.execute(delete(HealthDismissal))
    db.execute(update(ImageItem).where(ImageItem.status.in_(["annotated", "ignored"])).values(status="embedded"))
    db.commit()
    eng.store.remove(box_regions)
    learning.reset_cache()
    services.recompute(db)
    return {"ok": True}


@router.post("/rescan")
def rescan(db: Session = Depends(get_db)):
    """Re-runs the visual scan (candidate regions) on every image, keeping everything taught.

    Rejections pointing at the old regions are dropped (those regions no longer exist); boxes,
    verifications and the track record are kept.
    """
    services.reindex(db, embeddings_changed=False)
    worker.wake()
    return {"ok": True, "images": db.scalar(select(func.count(ImageItem.id))) or 0}


def _engine_out() -> dict:
    from .. import plugins

    return {"active": profiles.active.describe(),
            "profiles": [profiles.resolve(n).describe() for n in profiles.PROFILES],
            "overrides": profiles.overrides(), "runtime": runtime.info(),
            "components": plugins.describe()}


@router.get("/engine")
def get_engine():
    return _engine_out()


@router.put("/engine")
def put_engine(body: ProfileIn, db: Session = Depends(get_db)):
    """Switches engine profile. Re-scans the images (and re-embeds your boxes if the embedder changes)
    in the background; everything you taught is kept."""
    try:
        cfg = profiles.resolve(body.profile, body.custom.model_dump() if body.custom else None)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    profiles.set_active(cfg)
    embedder.unload()
    segmenter.unload()
    redo = services.sync_engine(db)
    services.recompute(db)
    worker.wake()
    return {**_engine_out(), **redo}

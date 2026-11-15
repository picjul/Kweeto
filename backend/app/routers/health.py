"""Dataset health (balance, near-duplicates, suspicious boxes), quick fixes on single boxes, lesson sessions."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import health, sessions
from ..db import get_db
from ..models import LessonSession
from ..schemas import BoxPatch, DismissIn

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/dataset-health")
def get_health(db: Session = Depends(get_db)):
    return health.report(db)


@router.post("/dataset-health/dismiss")
def dismiss(body: DismissIn, db: Session = Depends(get_db)):
    """'It's right': this finding is not shown again."""
    health.dismiss(db, body.key)
    return {"ok": True}


@router.post("/dataset-health/restore")
def restore(db: Session = Depends(get_db)):
    return {"restored": health.restore(db)}


@router.patch("/boxes/{box_id}")
def relabel_box(box_id: int, body: BoxPatch, db: Session = Depends(get_db)):
    try:
        return health.relabel(db, box_id, body.class_id)
    except KeyError as e:
        raise HTTPException(404, "Box not found") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/boxes/{box_id}")
def delete_box(box_id: int, db: Session = Depends(get_db)):
    try:
        return health.delete_box(db, box_id)
    except KeyError as e:
        raise HTTPException(404, "Box not found") from e


# ---------- lesson sessions (BEFORE / AFTER recap) ----------

@router.post("/sessions")
def start_session(resume: int | None = Query(None), db: Session = Depends(get_db)):
    s = sessions.start(db, resume)
    return {"id": s.id, "started_at": s.started_at.isoformat(timespec="seconds")}


@router.get("/sessions")
def recent_sessions(limit: int = Query(5, ge=1, le=50), db: Session = Depends(get_db)):
    return sessions.recent(db, limit)


def _session(db: Session, sid: int) -> LessonSession:
    s = db.get(LessonSession, sid)
    if s is None:
        raise HTTPException(404, "Session not found")
    return s


@router.get("/sessions/{sid}")
def session_recap(sid: int, db: Session = Depends(get_db)):
    return sessions.recap(db, _session(db, sid))


@router.post("/sessions/{sid}/end")
def end_session(sid: int, db: Session = Depends(get_db)):
    return sessions.end(db, _session(db, sid))

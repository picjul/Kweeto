"""Teaching sessions and their BEFORE/AFTER recap.

A session starts when a Lesson opens (or resumes in the same browser tab) and ends with "End lesson". At the
start we store what Pixel guessed on every image still to annotate (`LessonSession.snapshot`) and where the
event and outcome logs stood. The recap then says, with real numbers only:
- how often Pixel was right at the start of the session and at the end. Each judged guess was made BEFORE
  you corrected it (outcomes), so this is a prospective score, not a test on what it was taught;
- what you did (boxes, corrections, finished images) and how many images changed because of it (⚡);
- the images still to annotate where Pixel changed its mind: its guesses then, and now.
When the session ends the recap is frozen (`summary`): later lessons do not rewrite it.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import learning, pixel
from .models import Box, Event, ImageItem, LessonSession, Outcome, Proposal, Verification

STALE = timedelta(hours=12)
BLOCK = 10          # the "first" and "last" judged guesses compared
MIN_JUDGED = 10     # in-session comparison needs at least this many judged guesses
MAX_CHANGED = 8


def _now() -> datetime:
    return datetime.now()


def _snapshot(db: Session) -> dict[str, list]:
    todo = list(db.scalars(select(ImageItem.id).where(ImageItem.status == "embedded")))
    snap: dict[str, list] = {str(i): [] for i in todo}
    for p in db.scalars(select(Proposal).where(Proposal.is_control.is_(False), Proposal.image_id.in_(todo))):
        snap[str(p.image_id)].append([p.class_id, p.region_id, round(p.x, 4), round(p.y, 4), round(p.w, 4),
                                      round(p.h, 4), round(p.confidence, 3)])
    return snap


def start(db: Session, resume: int | None = None) -> LessonSession:
    """Resumes an open session (same tab) or starts a new one; sessions left open for long are closed."""
    if resume is not None:
        s = db.get(LessonSession, resume)
        if s is not None and s.ended_at is None and _now() - s.started_at < STALE:
            return s
    for old in db.scalars(select(LessonSession).where(LessonSession.ended_at.is_(None))):
        if _now() - old.started_at >= STALE:
            end(db, old)
    s = LessonSession(started_at=_now(), snapshot=_snapshot(db),
                      start_event_id=db.scalar(select(func.max(Event.id))) or 0,
                      start_outcome_id=db.scalar(select(func.max(Outcome.id))) or 0)
    db.add(s)
    db.commit()
    return s


def _track(oks: list[bool]) -> dict:
    return {"right": sum(oks), "total": len(oks)}


def _accuracy(db: Session, s: LessonSession, end_outcome: int) -> tuple[dict | None, int]:
    oks = [bool(o) for o in db.scalars(select(Outcome.correct).where(
        Outcome.id > s.start_outcome_id, Outcome.id <= end_outcome).order_by(Outcome.id))]
    n = len(oks)
    if n >= MIN_JUDGED:
        b = min(BLOCK, n // 2)
        return {"basis": "session", "before": _track(oks[:b]), "after": _track(oks[-b:])}, n
    prev = [bool(o) for o in db.scalars(select(Outcome.correct).where(Outcome.id <= s.start_outcome_id)
                                         .order_by(Outcome.id.desc()).limit(BLOCK))][::-1]
    if n >= 5 and len(prev) >= 5:
        b = min(n, len(prev))
        return {"basis": "previous", "before": _track(prev[-b:]), "after": _track(oks[-b:])}, n
    return None, n


def _guess(row: list) -> dict:
    cid, rid, x, y, w, h, conf = row
    return {"class_id": cid, "region_id": rid, "x": x, "y": y, "w": w, "h": h, "level": learning.level_of(conf)}


def _changed(db: Session, s: LessonSession) -> tuple[list[dict], int, int]:
    """(images where Pixel changed its mind, how many, how many of the snapshot's images you taught)."""
    snap = {int(k): v for k, v in (s.snapshot or {}).items()}
    if not snap:
        return [], 0, 0
    imgs = {i.id: i for i in db.scalars(select(ImageItem).where(ImageItem.id.in_(list(snap))))}
    still = [i for i, im in imgs.items() if im.status == "embedded"]
    taught = sum(1 for im in imgs.values() if im.status in ("annotated", "ignored"))
    now: dict[int, list] = defaultdict(list)
    for p in db.scalars(select(Proposal).where(Proposal.is_control.is_(False), Proposal.image_id.in_(still))):
        now[p.image_id].append([p.class_id, p.region_id, p.x, p.y, p.w, p.h, p.confidence])
    out = []
    for iid in still:
        before, after = snap.get(iid, []), now.get(iid, [])
        if {(r[0], r[1]) for r in before} == {(r[0], r[1]) for r in after}:
            continue
        cb, ca = Counter(r[0] for r in before), Counter(r[0] for r in after)
        kind = "new" if not before else "gone" if not after else "class" if cb != ca else "refined"
        score = {"class": 3, "new": 2, "gone": 2, "refined": 1}[kind]
        top = max((r[6] for r in after), default=0.0)
        im = imgs[iid]
        out.append({"image_id": iid, "filename": im.filename, "thumb_url": f"/files/thumbs/{im.thumb_name}",
                    "kind": kind, "before": [_guess(r) for r in before], "after": [_guess(r) for r in after],
                    "_rank": (score, top)})
    out.sort(key=lambda d: d.pop("_rank"), reverse=True)
    return out[:MAX_CHANGED], len(out), taught


def recap(db: Session, s: LessonSession) -> dict:
    if s.ended_at is not None and s.summary:
        return s.summary
    end_event = s.end_event_id or db.scalar(select(func.max(Event.id))) or 0
    end_outcome = s.end_outcome_id or db.scalar(select(func.max(Outcome.id))) or 0
    until = s.ended_at or _now()
    events = list(db.scalars(select(Event).where(Event.id > s.start_event_id, Event.id <= end_event)))
    by_type = Counter(e.type for e in events)
    acc, judged = _accuracy(db, s, end_outcome)
    boxes = db.scalar(select(func.count(Box.id)).where(Box.created_at >= s.started_at, Box.created_at <= until,
                                                         Box.source != "import")) or 0
    finished = db.scalar(select(func.count(Verification.image_id)).where(
        Verification.created_at >= s.started_at, Verification.created_at <= until)) or 0
    changed, n_changed, taught = _changed(db, s)
    r = {"id": s.id, "started_at": s.started_at.isoformat(timespec="seconds"),
         "ended_at": s.ended_at.isoformat(timespec="seconds") if s.ended_at else None,
         "minutes": max(0, round((until - s.started_at).total_seconds() / 60)),
         "accuracy": acc, "judged": judged,
         "boxes": boxes, "finished": finished, "corrections": by_type.get("correct", 0),
         "confirmed": by_type.get("accept", 0), "rejected": by_type.get("reject", 0),
         "gestures": sum(by_type.get(t, 0) for t in ("label", "accept", "correct", "reject", "batch_review", "question")),
         "propagated": sum(e.delta_count or 0 for e in events),
         "changed": changed, "changed_total": n_changed, "taught_from_snapshot": taught,
         "snapshot_images": len(s.snapshot or {})}
    r["pixel_message"] = pixel.recap_line(r)
    return r


def end(db: Session, s: LessonSession) -> dict:
    if s.ended_at is not None and s.summary:
        return s.summary
    s.end_event_id = db.scalar(select(func.max(Event.id))) or 0
    s.end_outcome_id = db.scalar(select(func.max(Outcome.id))) or 0
    s.ended_at = _now()
    s.summary = None
    r = recap(db, s)
    s.summary = r
    s.snapshot = {}  # no longer needed: the recap is frozen
    db.commit()
    return r


def recent(db: Session, limit: int = 5) -> list[dict]:
    """The latest finished sessions that had something in them (for the Overview)."""
    out = []
    for s in db.scalars(select(LessonSession).where(LessonSession.ended_at.is_not(None))
                        .order_by(LessonSession.id.desc()).limit(limit * 3)):
        r = s.summary or {}
        if not (r.get("gestures") or r.get("boxes")):
            continue
        out.append({k: r.get(k) for k in ("id", "started_at", "ended_at", "minutes", "accuracy", "judged", "boxes",
                                           "finished", "corrections", "propagated", "changed_total")})
        if len(out) >= limit:
            break
    return out

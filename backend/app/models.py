"""Database schema (SQLite)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (JSON, Boolean, DateTime, Float, ForeignKey, Integer,
                        LargeBinary, String, UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _now() -> datetime:
    return datetime.now()


class ImageItem(Base):
    __tablename__ = "images"

    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(512))
    stored_name: Mapped[str] = mapped_column(String(128), unique=True)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    # pending -> embedded -> annotated | ignored | error
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    error: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    @property
    def thumb_name(self) -> str:
        return self.stored_name.rsplit(".", 1)[0] + ".jpg"


class LabelClass(Base):
    __tablename__ = "classes"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    color: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Box(Base):
    """Annotation confirmed by a human (normalised 0..1 coordinates)."""
    __tablename__ = "boxes"

    id: Mapped[int] = mapped_column(primary_key=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), index=True)
    class_id: Mapped[int] = mapped_column(ForeignKey("classes.id", ondelete="CASCADE"), index=True)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    w: Mapped[float] = mapped_column(Float)
    h: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(16), default="manual")  # manual|proposal|batch|question
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Region(Base):
    """A crop with an embedding: candidate window (window), confirmed box (box), or a candidate added where the
    project's trained detector saw an object that no window covered (detect, see detector_infer.scan)."""
    __tablename__ = "regions"

    id: Mapped[int] = mapped_column(primary_key=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(8), index=True)  # window | box | detect
    box_id: Mapped[int | None] = mapped_column(ForeignKey("boxes.id", ondelete="CASCADE"), nullable=True, index=True)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    w: Mapped[float] = mapped_column(Float)
    h: Mapped[float] = mapped_column(Float)
    is_full: Mapped[bool] = mapped_column(Boolean, default=False)
    embedding: Mapped[bytes] = mapped_column(LargeBinary)


class Negative(Base):
    """'This region is NOT this class'."""
    __tablename__ = "negatives"
    __table_args__ = (UniqueConstraint("region_id", "class_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    region_id: Mapped[int] = mapped_column(ForeignKey("regions.id", ondelete="CASCADE"), index=True)
    class_id: Mapped[int] = mapped_column(ForeignKey("classes.id", ondelete="CASCADE"))


class Proposal(Base):
    """Pixel's current guess. Recomputed after every teaching gesture."""
    __tablename__ = "proposals"

    id: Mapped[int] = mapped_column(primary_key=True)
    image_id: Mapped[int] = mapped_column(Integer, index=True)
    region_id: Mapped[int] = mapped_column(Integer)
    class_id: Mapped[int] = mapped_column(Integer)
    second_class_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, index=True)
    margin: Mapped[float] = mapped_column(Float)
    nn_sim: Mapped[float] = mapped_column(Float)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    w: Mapped[float] = mapped_column(Float)
    h: Mapped[float] = mapped_column(Float)
    origin_event_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    is_control: Mapped[bool] = mapped_column(Boolean, default=False)  # hidden control check in the Harvest
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Event(Base):
    """Log of every human gesture: provenance of propagations and leverage metrics."""
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    # label | accept | correct | reject | batch_review | question
    type: Mapped[str] = mapped_column(String(24), index=True)
    image_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    class_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    from_class_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    delta_count: Mapped[int] = mapped_column(Integer, default=0)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class BoxMask(Base):
    """Cached mask of a confirmed box, drawn by the segmenter inside the box (exports only).

    Polygons are normalised [[x, y], ...]. `source` = "segmenter" or "box" (fallback: the box itself).
    `signature` = segmenter + box geometry: a different segmenter or a moved box recomputes it."""
    __tablename__ = "box_masks"

    box_id: Mapped[int] = mapped_column(ForeignKey("boxes.id", ondelete="CASCADE"), primary_key=True)
    signature: Mapped[str] = mapped_column(String(256))
    polygons: Mapped[list] = mapped_column(JSON)
    area: Mapped[float] = mapped_column(Float)  # fraction of the image covered by the mask
    source: Mapped[str] = mapped_column(String(16))


class Verification(Base):
    """The teacher finished this image in a Lesson ("Save & next"): every object of the known classes is boxed.

    Only on verified images do the remaining regions count as "not an object" (parts, groups, clutter).
    An image that merely received a box from the Harvest is NOT verified.
    """
    __tablename__ = "verifications"

    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Detection(Base):
    """One box of the project's active detector on an image still to annotate (its own, uncalibrated score).

    Pixel may use them as extra evidence (settings.use_detector): they are opinions of a model trained ONLY on
    human-finished images, never examples to learn from (rule 1).
    """
    __tablename__ = "detections"

    id: Mapped[int] = mapped_column(primary_key=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), index=True)
    run: Mapped[str] = mapped_column(String(64))
    class_id: Mapped[int] = mapped_column(ForeignKey("classes.id", ondelete="CASCADE"))
    score: Mapped[float] = mapped_column(Float)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    w: Mapped[float] = mapped_column(Float)
    h: Mapped[float] = mapped_column(Float)


class DetectorScan(Base):
    """The active detector (run) already looked at this image (it may have found nothing)."""
    __tablename__ = "detector_scans"

    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), primary_key=True)
    run: Mapped[str] = mapped_column(String(64))


class Outcome(Base):
    """What happened to one of Pixel's guesses once a human judged it: Pixel's real track record.

    Used to speak honestly about confidence ("when I'm this sure I'm right 9 times out of 10") and to show
    that learning is real (accuracy of the latest guesses vs the first ones). Hidden checks are excluded.
    """
    __tablename__ = "outcomes"

    id: Mapped[int] = mapped_column(primary_key=True)
    confidence: Mapped[float] = mapped_column(Float)
    correct: Mapped[bool] = mapped_column(Boolean)
    class_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(16))  # lesson | harvest | question
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Question(Base):
    __tablename__ = "questions"

    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[str] = mapped_column(String(24))  # few_examples | novelty | confusion
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | answered | dismissed
    signature: Mapped[str] = mapped_column(String(128), index=True)
    text: Mapped[str] = mapped_column(String(512))
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class HealthDismissal(Base):
    """A finding of the dataset health page the teacher looked at and kept ("It's right")."""
    __tablename__ = "health_dismissals"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class LessonSession(Base):
    """One teaching session (opened by the Lesson): what Pixel thought at the start, for the BEFORE/AFTER recap.

    `snapshot` = Pixel's guesses on every image still to annotate when the session started:
    {image_id: [[class_id, region_id, x, y, w, h, confidence], ...]} (empty list = no guess).
    The id ranges of events and outcomes delimit what happened during the session."""
    __tablename__ = "lesson_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    start_event_id: Mapped[int] = mapped_column(Integer, default=0)
    end_event_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    start_outcome_id: Mapped[int] = mapped_column(Integer, default=0)
    end_outcome_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)

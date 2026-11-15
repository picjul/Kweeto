from __future__ import annotations

from pydantic import BaseModel, Field


class ClassIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    color: str | None = None


class ClassPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    color: str | None = None


class BoxIn(BaseModel):
    id: int | None = None
    class_id: int
    x: float
    y: float
    w: float
    h: float
    # set when the box comes from an accepted proposal
    proposal_region_id: int | None = None
    proposal_class_id: int | None = None


class RejectedIn(BaseModel):
    region_id: int
    class_id: int
    x: float = 0
    y: float = 0
    w: float = 0
    h: float = 0


class AnnotationSave(BaseModel):
    boxes: list[BoxIn] = []
    rejected: list[RejectedIn] = []
    done: bool = True


class ReviewItem(BaseModel):
    proposal_id: int
    region_id: int
    class_id: int
    from_class_id: int | None = None


class BatchReviewIn(BaseModel):
    accept: list[ReviewItem] = []
    reject: list[ReviewItem] = []
    correct: list[ReviewItem] = []


class Assignment(BaseModel):
    region_id: int
    proposed_class_id: int
    class_id: int | None = None  # None = "neither"


class QuestionAnswerIn(BaseModel):
    action: str = "submit"  # submit | annotate | ignore
    assignments: list[Assignment] = []


class SettingsIn(BaseModel):
    sim_min: float | None = None
    sim_high: float | None = None
    auto_calibrate: bool | None = None
    propose_min: float | None = None
    batch_min: float | None = None
    knn_k: int | None = Field(default=None, ge=1, le=50)
    temperature: float | None = Field(default=None, gt=0)
    max_per_image: int | None = Field(default=None, ge=1, le=50)
    use_probe: bool | None = None
    probe: str | None = None
    probe_weight: float | None = Field(default=None, ge=0, le=1)
    probe_ramp: int | None = Field(default=None, ge=1, le=100)
    use_background: bool | None = None
    snap_boxes: bool | None = None
    use_detector: bool | None = None
    detector_weight: float | None = Field(default=None, ge=0, le=1)
    detector_veto: float | None = Field(default=None, ge=0, le=1)


class SegmentIn(BaseModel):
    """Prompt for the segmenter, normalised 0..1: one or more points and/or a rough box."""
    points: list[tuple[float, float]] = []
    box: tuple[float, float, float, float] | None = None  # x, y, w, h


class CustomEngineIn(BaseModel):
    embedder: str
    model: str = ""
    segmenter: str
    sam_model: str = ""
    sam_points: int = Field(8, ge=1, le=32)
    sam_refine: int = Field(16, ge=0, le=128)


class ProfileIn(BaseModel):
    profile: str  # light | balanced | accurate | custom | a plugin's profile
    custom: CustomEngineIn | None = None  # with profile = "custom"


class ExportIn(BaseModel):
    formats: list[str] = Field(min_length=1)
    masks: bool = True
    images: bool = True
    scope: str = Field(default="annotated", pattern="^(annotated|boxed)$")
    train: float = Field(default=1.0, ge=0, le=1)
    val: float = Field(default=0.0, ge=0, le=1)
    test: float = Field(default=0.0, ge=0, le=1)
    seed: int = 0


class ImageIdsIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=10_000)


class PixelIn(BaseModel):
    name: str | None = Field(default=None, max_length=24)
    color: str | None = None
    shape: str | None = None
    eyes: str | None = None
    accessory: str | None = None


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    pixel: PixelIn | None = None
    open: bool = True


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    pixel: PixelIn | None = None


class ImportCommitIn(BaseModel):
    format: str | None = None
    complete: bool = True          # images with imported boxes are finished (every object boxed)
    empty_negative: bool = False   # images listed without boxes contain no objects
    skip_classes: list[str] = []


class BoxPatch(BaseModel):
    class_id: int


class DismissIn(BaseModel):
    key: str = Field(min_length=1, max_length=128)

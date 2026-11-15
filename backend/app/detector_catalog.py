"""Which LibreYOLO detector families can be trained on the Training page (plugins.DETECTORS).

LibreYOLO ships many families (see `available_families()`); Kweeto offers the ones that are
1. object detectors LibreYOLO can train, and
2. under a license compatible with Apache-2.0 for code AND pretrained weights (the project's rule),
and that were checked end to end here: training, ONNX export, inference on Kweeto's runtime.

Adding another LibreYOLO family is one registration (in a plugin, or below once checked):

    from app.detector_catalog import DetectorFamily
    from app.plugins import DETECTORS

    DETECTORS.register(DetectorFamily(
        id="rtmdet", title="RTMDet", prefix="LibreRTMDet", license="Apache-2.0",
        summary="...", sizes={"t": ("Tiny", "..."), "s": ("Small", "...")}))

`id` is LibreYOLO's FAMILY name and `prefix` its FILENAME_PREFIX: the pretrained weights are
`<prefix><size>.pt`, downloaded by LibreYOLO on first use. Model ids are "<family>-<size>" (e.g. "yolo9-t").
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .plugins import DETECTORS


@dataclass(frozen=True)
class DetectorFamily:
    id: str                 # LibreYOLO FAMILY
    title: str              # shown name, e.g. "YOLOv9"
    prefix: str             # LibreYOLO FILENAME_PREFIX: weights = <prefix><size>.pt
    license: str            # code + pretrained weights
    summary: str
    sizes: dict[str, tuple[str, str]] = field(default_factory=dict)  # size -> (title, summary), in display order
    kind: str = "CNN"       # CNN | transformer: a hint for the user (transformers want more data and time)
    fixed_imgsz: int | None = None  # the family only exports at this input size: training uses it too

    def model_id(self, size: str) -> str:
        return f"{self.id}-{size}"

    def weights(self, size: str) -> str:
        return f"{self.prefix}{size}.pt"

    def models(self) -> dict[str, dict]:
        return {self.model_id(s): {"title": t, "family": self.title, "family_id": self.id, "size": s,
                                   "weights": self.weights(s), "license": self.license, "summary": summ,
                                   "kind": self.kind, "family_summary": self.summary, "fixed_imgsz": self.fixed_imgsz,
                                   "builtin": self in _BUILTIN}
                for s, (t, summ) in self.sizes.items()}


_BUILTIN: list[DetectorFamily] = [
    DetectorFamily(
        "yolo9", "YOLOv9", "LibreYOLO9", "MIT",
        "Modern single-stage CNN detector: quick to train, a safe first choice on a CPU.",
        {"t": ("Fast", "Smallest and quickest to train: a good first run, fine on a CPU."),
         "s": ("Balanced", "More accurate, a few times slower to train. A good overnight run on a CPU."),
         "m": ("Accurate", "The most accurate; best with an NVIDIA GPU (or a long night on a CPU).")}),
    DetectorFamily(
        "yolox", "YOLOX", "LibreYOLOX", "Apache-2.0",
        "Anchor-free YOLO: a well-known baseline, easy to deploy.",
        {"n": ("Nano", "Tiny YOLOX: the fastest at inference, for small devices."),
         "s": ("Small", "YOLOX small: a well-known baseline, easy to deploy.")}),
    DetectorFamily(
        "rtmdet", "RTMDet", "LibreRTMDet", "Apache-2.0",
        "OpenMMLab's real-time CNN detector: accurate for its size.",
        {"t": ("Tiny", "Very small and fast, good accuracy for its size."),
         "s": ("Small", "A step up in accuracy, still light.")}),
    DetectorFamily(
        "dfine", "D-FINE", "LibreDFINE", "Apache-2.0",
        "Real-time DETR (transformer) with fine-grained box refinement: precise boxes, wants a GPU and more images.",
        {"n": ("Nano", "The smallest D-FINE: a transformer detector that still runs on a CPU."),
         "s": ("Small", "More accurate; training on a CPU is slow.")}, kind="transformer"),
    DetectorFamily(
        "deim", "DEIM", "LibreDEIM", "Apache-2.0",
        "D-FINE trained with DEIM's matching: converges in fewer epochs, good when time is short.",
        {"n": ("Nano", "Small and quick to converge."),
         "s": ("Small", "More accurate; best with a GPU.")}, kind="transformer"),
    DetectorFamily(
        "rtdetrv2", "RT-DETRv2", "LibreRTDETRv2", "Apache-2.0",
        "Baidu's real-time detection transformer, second version: no NMS, strong on crowded scenes.",
        {"r18": ("ResNet-18", "The lightest RT-DETRv2."),
         "r34": ("ResNet-34", "More accurate; best with a GPU.")}, kind="transformer", fixed_imgsz=640),
]
# Checked here end to end (LibreYOLO 1.7.4, CPU): 1-epoch training through detector_job, ONNX export, inference of
# the exported model. RT-DETRv2 exports only at its native 640 px. Not offered: RF-DETR (needs the extra `rfdetr`
# package: add it with a plugin, n/s/m are Apache-2.0), and families with non-commercial / GPL / custom weight
# licenses (YOLO-NAS, YOLOv7, EC, DEIMv2 l/x, ...).

for _f in _BUILTIN:
    DETECTORS.register(_f)


def models() -> dict[str, dict]:
    """Every trainable model id -> its info (only families the installed LibreYOLO has)."""
    have = available_families()
    out: dict[str, dict] = {}
    for fam in DETECTORS.all():
        if have and fam.id not in have:
            continue  # this LibreYOLO version does not have it
        out.update(fam.models())
    return out


def model_info(model_id: str) -> dict:
    """Info of a model id, also for runs made with a family that is no longer offered."""
    info = models().get(model_id)
    if info is not None:
        return info
    fam, _, size = model_id.rpartition("-")
    return {"title": model_id, "family": fam, "family_id": fam, "size": size, "license": "", "summary": "",
            "kind": "", "weights": "", "fixed_imgsz": None}


def available_families() -> dict[str, dict]:
    """LibreYOLO's detection families that can be trained (installed version): FAMILY -> {sizes, group}."""
    try:
        import libreyolo  # noqa: F401  (registers the families)
        from libreyolo.models.base.model import BaseModel
        from libreyolo.models.registry import group_of
    except Exception:
        return {}
    out = {}
    for cls in BaseModel._registry:
        fam = str(getattr(cls, "FAMILY", "") or "")
        if not fam or "detect" not in tuple(getattr(cls, "SUPPORTED_TASKS", ())):
            continue
        if group_of(fam) not in ("g0", "g1", "g2"):  # g3/g4 have no training implementation
            continue
        out[fam] = {"sizes": sorted(getattr(cls, "INPUT_SIZES", {}) or {}), "group": group_of(fam),
                    "prefix": getattr(cls, "FILENAME_PREFIX", "")}
    return out


def not_offered() -> list[dict]:
    """Trainable LibreYOLO detection families that Kweeto does not offer (yet): license to check first."""
    have = available_families()
    offered = {f.id for f in DETECTORS.all()}
    return [{"family": k, **v} for k, v in sorted(have.items()) if k not in offered]

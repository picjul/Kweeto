"""Engine profiles: the user picks an intention (light / balanced / accurate), not a model.

A profile fixes the two vision models used at ingest and how hard the segmenter looks:
- embedder:  turns a crop into a vector (Pixel's "eyes"; changing it invalidates every stored vector);
- segmenter: finds candidate object regions (SAM family) and powers click-to-box / snapping;
- sam_points / sam_refine: prompts of the automatic scan. The SAM mask decoder costs ~50 ms per prompt
  on a CPU whatever the model, so the scan uses a sparse grid plus extra points only where no mask
  covered the image yet (thin or small objects that fall between grid points).

All models are Apache-2.0 licensed (see docs/licenses.md).

The models are registered components (plugins.EMBEDDERS / SEGMENTERS): a profile only names them. Besides the
built-in profiles there is "custom" (any registered embedder + segmenter and checkpoints, chosen on the Engine
page) and plugins may add profiles with `register_profile`.

Each project has its own profile, stored in <project>/engine.json together with the signature of the
embeddings in its database, so switching profile can trigger exactly the re-scan that is needed.
Environment variables (KWEETO_EMBEDDER, KWEETO_MODEL, KWEETO_SEGMENTER, KWEETO_SAM_MODEL,
KWEETO_SAM_POINTS) still override single fields, for development and benchmarks.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, replace

from . import workspace

LEGACY_SIGNATURE = "siglip:google/siglip-base-patch16-224"  # databases created before profiles existed


@dataclass(frozen=True)
class EngineConfig:
    profile: str
    embedder: str      # a registered embedder: dinov2 | siglip | hf | pixels | a plugin's
    model: str         # its checkpoint
    segmenter: str     # a registered segmenter: sam (SAM / SlimSAM) | sam2 | simple | a plugin's
    sam_model: str     # the segmenter's checkpoint (the name is historical: any segmenter)
    sam_points: int    # first-pass grid: sam_points x sam_points prompts
    sam_refine: int    # max extra prompts on regions no mask covered

    @property
    def signature(self) -> str:
        """Identity of the embedding space: vectors with different signatures can't be compared."""
        from .plugins import EMBEDDERS

        try:
            return EMBEDDERS.get(self.embedder).signature_of(self.model)
        except ValueError:  # its plugin is gone: still a stable identity
            return f"{self.embedder}:{self.model}"

    @property
    def scan_signature(self) -> str:
        """Identity of the candidate regions: when it changes the images must be scanned again."""
        from .config import MAX_SEGMENTS, MAX_UNIONS, PROPOSER
        from .plugins import SEGMENTERS

        try:
            seg = SEGMENTERS.get(self.segmenter).scan_signature_of(self.sam_model, self.sam_points, self.sam_refine)
        except ValueError:
            seg = f"{self.segmenter}:{self.sam_model}:{self.sam_points}:{self.sam_refine}"
        return f"{PROPOSER}:{seg}:{MAX_SEGMENTS}:{MAX_UNIONS}"

    def custom(self) -> dict:
        return {k: getattr(self, k) for k in CUSTOM_FIELDS}

    def describe(self) -> dict:
        info = PROFILE_INFO.get(self.profile) or {"title": self.profile, "summary": ""}
        if self.profile == CUSTOM:
            info = {"title": "Custom", "summary": f"{self.embedder} ({self.model.split('/')[-1] or '-'}) + "
                                                   f"{self.segmenter} ({self.sam_model.split('/')[-1] or '-'})"}
        return {**asdict(self), "signature": self.signature, **info}


CUSTOM_FIELDS = ("embedder", "model", "segmenter", "sam_model", "sam_points", "sam_refine")


PROFILES: dict[str, EngineConfig] = {
    "light": EngineConfig("light", "dinov2", "facebook/dinov2-small",
                          "sam", "nielsr/slimsam-77-uniform", sam_points=6, sam_refine=16),
    "balanced": EngineConfig("balanced", "dinov2", "facebook/dinov2-small",
                             "sam2", "facebook/sam2.1-hiera-tiny", sam_points=8, sam_refine=24),
    "accurate": EngineConfig("accurate", "siglip", "google/siglip-base-patch16-224",
                             "sam", "facebook/sam-vit-base", sam_points=12, sam_refine=32),
}

PROFILE_INFO = {
    "light": {"title": "Light", "summary": "Small models (DINOv2-small + SlimSAM): for laptops without a GPU."},
    "balanced": {"title": "Balanced", "summary": "DINOv2-small + SAM 2.1 tiny: good regions at a fraction of the cost."},
    "accurate": {"title": "Accurate", "summary": "SigLIP base + SAM base: the most thorough scan, best with a GPU."},
}
DEFAULT_PROFILE = "light"
CUSTOM = "custom"


def register_profile(cfg: EngineConfig, title: str, summary: str) -> None:
    """For plugins: a ready-made profile (an intention) shown next to light / balanced / accurate."""
    if cfg.profile == CUSTOM:
        raise ValueError("'custom' is reserved")
    PROFILES[cfg.profile] = cfg
    PROFILE_INFO[cfg.profile] = {"title": title, "summary": summary}


def custom_config(c: dict) -> EngineConfig:
    """A custom profile from its fields; checks that the components are registered and runnable here."""
    from .plugins import EMBEDDERS, SEGMENTERS

    emb, seg = EMBEDDERS.get(str(c.get("embedder", ""))), SEGMENTERS.get(str(c.get("segmenter", "")))
    for comp in (emb, seg):
        if not comp.available():
            raise ValueError(f"{comp.title} can't run here: its dependencies are not installed")
    refine = c.get("sam_refine")
    return EngineConfig(CUSTOM, emb.id, str(c.get("model") or emb.default_model), seg.id,
                        str(c.get("sam_model") or seg.default_model),
                        int(c.get("sam_points") or 8), int(16 if refine is None else refine))


def _env_overrides(cfg: EngineConfig) -> EngineConfig:
    ch: dict = {}
    if os.getenv("KWEETO_EMBEDDER"):
        ch["embedder"] = os.environ["KWEETO_EMBEDDER"]
    if os.getenv("KWEETO_MODEL"):
        ch["model"] = os.environ["KWEETO_MODEL"]
    if os.getenv("KWEETO_SEGMENTER"):
        ch["segmenter"] = os.environ["KWEETO_SEGMENTER"]
    elif ch.get("embedder") == "pixels":
        ch["segmenter"] = "simple"  # fake embedder = development without torch
    if os.getenv("KWEETO_SAM_MODEL"):
        ch["sam_model"] = os.environ["KWEETO_SAM_MODEL"]
    if os.getenv("KWEETO_SAM_POINTS"):
        ch["sam_points"] = int(os.environ["KWEETO_SAM_POINTS"])
    if os.getenv("KWEETO_SAM_REFINE"):
        ch["sam_refine"] = int(os.environ["KWEETO_SAM_REFINE"])
    return replace(cfg, **ch) if ch else cfg


def resolve(name: str, custom: dict | None = None) -> EngineConfig:
    if name == CUSTOM:
        c = custom if custom is not None else (_read_file().get("custom") or {})
        if not c:
            raise ValueError("The custom profile needs an embedder and a segmenter")
        return _env_overrides(custom_config(c))
    if name not in PROFILES:
        raise ValueError(f"Unknown profile {name!r}: choose one of {', '.join([*PROFILES, CUSTOM])}")
    return _env_overrides(PROFILES[name])


def _read_file() -> dict:
    if workspace.current is None:
        return {}
    try:
        return json.loads(workspace.engine_file().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_file(data: dict) -> None:
    workspace.engine_file().write_text(json.dumps(data, indent=2), encoding="utf-8")


def _initial() -> EngineConfig:
    data = _read_file()
    name = data.get("profile") or os.getenv("KWEETO_PROFILE") or DEFAULT_PROFILE
    if name == CUSTOM and data.get("custom"):
        try:  # registry lookups only (no model is loaded here)
            return resolve(CUSTOM, data["custom"])
        except ValueError as e:  # a plugin was removed: fall back, the Engine page shows the profile in use
            import logging

            logging.getLogger("kweeto.profiles").warning("custom profile unusable (%s): using %s", e, DEFAULT_PROFILE)
            name = DEFAULT_PROFILE
    return resolve(name if name in PROFILES else DEFAULT_PROFILE)


active: EngineConfig = _initial()
generation = 0  # bumped on every switch: work started with older models is discarded


def stored() -> dict:
    """What the database was built with: {"data_signature", "scan_signature"} (empty = never recorded)."""
    return _read_file()


def record(cfg: EngineConfig) -> None:
    data = {"profile": cfg.profile, "data_signature": cfg.signature, "scan_signature": cfg.scan_signature}
    if cfg.profile == CUSTOM:
        data["custom"] = cfg.custom()
    _write_file(data)


def overrides() -> list[str]:
    names = ("KWEETO_EMBEDDER", "KWEETO_MODEL", "KWEETO_SEGMENTER", "KWEETO_SAM_MODEL",
             "KWEETO_SAM_POINTS", "KWEETO_SAM_REFINE")
    return [n for n in names if os.getenv(n)]


def set_active(cfg: EngineConfig) -> None:
    global active, generation
    active = cfg
    generation += 1


def load_for_project() -> None:
    """Activates the profile saved in the (newly) active project, or the default for a new project."""
    set_active(_initial())

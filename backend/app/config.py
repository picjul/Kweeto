"""Central configuration. Everything can be overridden with environment variables."""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
# Root of all the projects (each project = a folder with its own DB and images, see workspace.py)
DATA_DIR = Path(os.getenv("KWEETO_DATA_DIR", str(BASE_DIR / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Which vision models run (embedder, segmenter) is chosen by the engine PROFILE: see profiles.py.
EMBED_BATCH = int(os.getenv("KWEETO_EMBED_BATCH", "16"))

# Where Pixel looks for objects (computed ONCE per image at ingest):
#   "segments" = the segmenter's object masks at several granularities + merged fragments (default)
#   "windows"  = fixed grid, fast but not object-shaped (legacy / fallback)
PROPOSER = os.getenv("KWEETO_PROPOSER", "segments")
MAX_SEGMENTS = int(os.getenv("KWEETO_MAX_SEGMENTS", "24"))
MAX_UNIONS = int(os.getenv("KWEETO_MAX_UNIONS", "6"))  # "fragment" candidates: unions of nearby look-alike pieces

# Candidate windows per image: g x g grids (1 = whole image) + a centre window
WINDOW_GRIDS = tuple(int(g) for g in os.getenv("KWEETO_GRIDS", "1,2").split(",") if g.strip())
CENTER_WINDOW = os.getenv("KWEETO_CENTER_WINDOW", "1") == "1"

QUEUE_SEED = os.getenv("KWEETO_QUEUE_SEED")  # makes the Lesson queue reproducible (benchmarks/tests)

THUMB_SIZE = 320
BOX_PAD = 0.10  # context around hand-drawn boxes when computing their embedding
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
MAX_GROUP_ITEMS = 60
CORS_ORIGINS = [o.strip() for o in os.getenv(
    "KWEETO_CORS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()]
# Host names the backend answers to (protection against DNS rebinding, see SECURITY.md). Add yours when Kweeto is
# reached under another name (e.g. behind your own authenticating reverse proxy); "*" disables the check.
ALLOWED_HOSTS = [h.strip() for h in os.getenv("KWEETO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]").split(",")
                 if h.strip()]


@dataclass
class Settings:
    """Engine thresholds, editable at runtime through /api/settings."""
    sim_min: float = float(os.getenv("KWEETO_SIM_MIN", "0.55"))
    sim_high: float = float(os.getenv("KWEETO_SIM_HIGH", "0.85"))
    auto_calibrate: bool = os.getenv("KWEETO_AUTO_CALIBRATE", "1") == "1"
    propose_min: float = 0.30
    batch_min: float = 0.65
    knn_k: int = 10
    temperature: float = 0.03
    max_per_image: int = 12
    use_probe: bool = os.getenv("KWEETO_USE_PROBE", "1") == "1"
    probe: str = os.getenv("KWEETO_PROBE", "linear")  # which learner (plugins.PROBES): linear | mlp | a plugin
    probe_weight: float = 0.5  # blend between kNN vote (0) and linear probe (1), reached after `probe_ramp` examples/class
    probe_ramp: int = 5        # the probe's say grows with the examples: kNN first (few-shot), probe later
    use_background: bool = True  # learn "not an object" (parts, groups, clutter) from the images you verified
    snap_boxes: bool = True    # snap hand-drawn boxes to the object with the segmenter
    # the project's trained detector (Training page, "Use in Kweeto") as a second opinion in Pixel's guesses.
    # On by default once a detector is in use: bench.simulate (real models) F1 0.94 -> 0.99 and 0.91 -> 0.98.
    use_detector: bool = os.getenv("KWEETO_USE_DETECTOR", "1") == "1"
    detector_weight: float = 0.3  # pull of a matching detector box on the class and on "is it an object"
    detector_veto: float = 0.3    # confidence drop where the detector saw nothing

    def as_dict(self) -> dict:
        return asdict(self)


settings = Settings()

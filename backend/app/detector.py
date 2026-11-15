"""Ad-hoc detector training: a real object detector (LibreYOLO, MIT) trained on the project's finished images.

Pixel's everyday learning (kNN + probe, learning.py) adapts in milliseconds after every gesture. This is the other
kind of learning: a full detector trained for minutes or hours (e.g. overnight), started on command, which you can
download (.pt / ONNX) and use elsewhere.

- Data: only the images you FINISHED in a Lesson (`verifications`): their annotation is complete, so every object is
  boxed and everything else is background. Images with a few boxes but not finished would teach the detector that
  unboxed objects are background, so they are left out. Never Pixel's proposals (rule 1: no feedback loop).
- Split: train / validation, deterministic. The validation images are never trained on, so the reported mAP is honest.
- The training runs in a separate, low-priority process (`detector_job.py`): the app stays responsive, the run can be
  stopped (the last finished epoch is kept) and resumed.
- Models: the LibreYOLO families of detector_catalog.py (licenses compatible with Apache-2.0, code and weights;
  plugins can add more). Training uses CUDA or Apple
  MPS when PyTorch has them, otherwise the CPU; the trained model is exported to ONNX and runs on the app's ONNX
  Runtime (any execution provider).
"""
from __future__ import annotations

import json
import logging
import os
import random
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import detector_catalog, workspace
from .config import BASE_DIR, DATA_DIR
from .models import Box, ImageItem, LabelClass, Outcome, Verification

log = logging.getLogger("kweeto.detector")

# The trainable models come from the LibreYOLO family catalog (detector_catalog.py, plugins.DETECTORS):
# model id = "<family>-<size>", e.g. "yolo9-t".
MIN_IMAGES = 10      # finished images needed to train at all
VAL_FRACTION = 0.2   # held out for the honest metrics
LIVE = ("preparing", "running")

_lock = threading.Lock()
_active: dict | None = None  # {"dir": Path, "proc": Popen, "project": str}


def weights_dir() -> Path:
    """Pretrained starting points, shared by every project (downloaded from the LibreYOLO Hugging Face org)."""
    d = Path(os.getenv("KWEETO_DETECTOR_WEIGHTS") or (DATA_DIR / "libreyolo"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def runs_dir() -> Path:
    d = workspace.require().dir / "training"
    d.mkdir(parents=True, exist_ok=True)
    return d


def available() -> tuple[bool, str | None]:
    try:
        import libreyolo  # noqa: F401
        return True, None
    except Exception as e:  # light install without torch / libreyolo
        return False, f"LibreYOLO is not installed ({type(e).__name__}). Install the full requirements to train detectors."


def training_device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return f"cuda ({torch.cuda.get_device_name(0)})"
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


# ---------- dataset ----------

def _finished(db: Session) -> tuple[list[ImageItem], dict[int, list[Box]], list[LabelClass]]:
    ids = set(db.scalars(select(Verification.image_id)))
    images = [i for i in db.scalars(select(ImageItem).order_by(ImageItem.id)) if i.id in ids and i.status != "error"]
    boxes: dict[int, list[Box]] = {}
    for b in db.scalars(select(Box).where(Box.image_id.in_(ids))):
        boxes.setdefault(b.image_id, []).append(b)
    used = {b.class_id for bs in boxes.values() for b in bs}
    classes = [c for c in db.scalars(select(LabelClass).order_by(LabelClass.id)) if c.id in used]
    return images, boxes, classes


def readiness(db: Session) -> dict:
    """What a training would use right now, and whether it can start."""
    images, boxes, classes = _finished(db)
    per_class = {c.name: 0 for c in classes}
    names = {c.id: c.name for c in classes}
    for bs in boxes.values():
        for b in bs:
            per_class[names[b.class_id]] += 1
    n = len(images)
    n_val = max(1, round(n * VAL_FRACTION)) if n >= 2 else 0
    reasons = []
    if n < MIN_IMAGES:
        reasons.append(f"Finish at least {MIN_IMAGES} images in a Lesson (\"Save & next\"): {n} so far.")
    if not classes:
        reasons.append("No boxes on the finished images yet.")
    ok_lib, why = available()
    if not ok_lib:
        reasons.append(why)
    return {"images": n, "train": n - n_val, "val": n_val, "background": sum(1 for i in images if not boxes.get(i.id)),
            "boxes": sum(len(b) for b in boxes.values()), "classes": per_class, "ready": not reasons, "reasons": reasons,
            "min_images": MIN_IMAGES}


def build_dataset(db: Session, out: Path, seed: int = 0) -> dict:
    """Writes a YOLO dataset (images/, labels/, data.yaml) of the finished images; returns its summary."""
    from .export import _image_bytes

    images, boxes, classes = _finished(db)
    if len(images) < MIN_IMAGES or not classes:
        raise ValueError(" ".join(readiness(db)["reasons"]) or "Not enough finished images.")
    index = {c.id: k for k, c in enumerate(classes)}
    order = [i.id for i in images]
    random.Random(seed).shuffle(order)
    n_val = max(1, round(len(order) * VAL_FRACTION))
    val = set(order[:n_val])
    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
    for img in images:
        split = "val" if img.id in val else "train"
        stem = f"{img.id:06d}"
        ext = Path(img.stored_name).suffix.lower() or ".jpg"
        (out / "images" / split / f"{stem}{ext}").write_bytes(_image_bytes(img))  # upright if EXIF-rotated
        rows = []
        for b in boxes.get(img.id, []):
            cx, cy = min(1.0, max(0.0, b.x + b.w / 2)), min(1.0, max(0.0, b.y + b.h / 2))
            rows.append(f"{index[b.class_id]} {cx:.6f} {cy:.6f} {min(1.0, b.w):.6f} {min(1.0, b.h):.6f}")
        (out / "labels" / split / f"{stem}.txt").write_text("\n".join(rows), encoding="utf-8")
    names = [c.name for c in classes]
    yaml = "".join([f"path: {out.as_posix()}\n", "train: images/train\n", "val: images/val\n", f"nc: {len(names)}\n",
                    "names:\n", *(f"  {k}: {json.dumps(n)}\n" for k, n in enumerate(names))])
    (out / "data.yaml").write_text(yaml, encoding="utf-8")
    return {"classes": names, "images": len(images), "train": len(images) - n_val, "val": n_val,
            "boxes": sum(len(b) for b in boxes.values())}


# ---------- runs ----------

def _read(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_json(p: Path, data: dict) -> None:
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def _is_active(d: Path) -> bool:
    return _active is not None and _active["dir"] == d and _active["proc"].poll() is None


def checkpoint(d: Path) -> Path | None:
    """The run's model: best.pt (best validation score), else last.pt (a run stopped before any validation)."""
    for name in ("best.pt", "last.pt"):
        p = d / "run" / "weights" / name
        if p.exists():
            return p
    return None


def run_out(d: Path) -> dict:
    job, st = _read(d / "job.json"), _read(d / "status.json")
    state = st.get("state", "preparing")
    if state in LIVE and not _is_active(d):
        state = "interrupted"  # the process is gone (app restarted, crash): resumable from the last epoch
    return {**{k: job.get(k) for k in ("id", "model", "epochs", "imgsz", "patience", "batch", "created_at", "dataset")},
            **{k: v for k, v in st.items() if k != "state"}, "state": state,
            "model_info": detector_catalog.model_info(job.get("model") or ""),
            "has_model": checkpoint(d) is not None, "has_onnx": (d / "model.onnx").exists(),
            "resumable": state in ("stopped", "interrupted", "failed") and (d / "run" / "weights" / "last.pt").exists()}


def list_runs() -> list[dict]:
    root = runs_dir()
    runs = [run_out(d) for d in root.iterdir() if (d / "job.json").exists()]
    return sorted(runs, key=lambda r: r.get("created_at") or "", reverse=True)


def run_dir(run_id: str) -> Path:
    if not run_id or any(c in run_id for c in "/\\."):  # an id, never a path
        raise KeyError(run_id)
    d = runs_dir() / run_id
    if not (d / "job.json").exists():
        raise KeyError(run_id)
    return d


def _spawn(d: Path, mode: str) -> subprocess.Popen:
    out = open(d / "train.out", "a", encoding="utf-8")
    kw: dict = {"cwd": str(BASE_DIR), "stdout": out, "stderr": subprocess.STDOUT}
    if sys.platform == "win32":  # below-normal priority, no console window
        kw["creationflags"] = 0x00004000 | 0x08000000
    else:
        kw["preexec_fn"] = lambda: os.nice(10)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    return subprocess.Popen([sys.executable, "-m", "app.detector_job", str(d), mode], env=env, **kw)


def busy() -> dict | None:
    """The run in progress (in any project), if any: one training at a time, it takes the whole machine."""
    if _active is not None and _active["proc"].poll() is None:
        return {"project": _active["project"], "id": _active["dir"].name}
    return None


def start(db: Session, model: str, epochs: int, imgsz: int, patience: int, batch: int) -> dict:
    global _active
    offered = detector_catalog.models()
    if model not in offered:
        raise ValueError(f"Unknown model {model!r}: choose one of {', '.join(offered)}")
    imgsz = offered[model].get("fixed_imgsz") or imgsz  # some families only export at their native size
    ok, why = available()
    if not ok:
        raise ValueError(why)
    with _lock:
        if busy():
            raise RuntimeError("A training is already running: stop it first.")
        run_id = datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{model}"
        d = runs_dir() / run_id
        d.mkdir(parents=True)
        try:
            summary = build_dataset(db, d / "dataset")
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise
        write_json(d / "job.json", {"id": run_id, "model": model, "weights": str(weights_dir() / offered[model]["weights"]),
                                    "outcomes_at_start": _outcomes(db),
                                    "epochs": epochs, "imgsz": imgsz, "patience": patience, "batch": batch,
                                    "created_at": datetime.now().isoformat(timespec="seconds"), "dataset": summary})
        write_json(d / "status.json", {"state": "preparing", "phase": "starting", "device": training_device(),
                                       "history": [], "started_at": time.time()})
        _active = {"dir": d, "proc": _spawn(d, "train"), "project": workspace.require().id}
        return run_out(d)


def resume(run_id: str) -> dict:
    global _active
    d = run_dir(run_id)
    with _lock:
        if busy():
            raise RuntimeError("A training is already running: stop it first.")
        if not run_out(d)["resumable"]:
            raise ValueError("This run cannot be resumed.")
        st = _read(d / "status.json")
        write_json(d / "status.json", {**st, "state": "preparing", "phase": "resuming", "error": None})
        _active = {"dir": d, "proc": _spawn(d, "resume"), "project": workspace.require().id}
        return run_out(d)


def stop(run_id: str) -> dict:
    d = run_dir(run_id)
    with _lock:
        if _is_active(d):
            proc = _active["proc"]
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
            st = _read(d / "status.json")
            write_json(d / "status.json", {**st, "state": "stopped", "finished_at": time.time()})
        return run_out(d)


def delete(run_id: str) -> None:
    d = run_dir(run_id)
    if _is_active(d):
        raise RuntimeError("Stop the training before deleting it.")
    shutil.rmtree(d, ignore_errors=True)


def onnx_file(run_id: str) -> Path:
    """The run's ONNX model, exported from best.pt now if the run ended without it (stopped / interrupted)."""
    d = run_dir(run_id)
    out = d / "model.onnx"
    if out.exists():
        return out
    if checkpoint(d) is None:
        raise ValueError("This run has no trained model yet.")
    if _is_active(d):
        raise RuntimeError("The training is still running: stop it or wait for the end.")
    r = subprocess.run([sys.executable, "-m", "app.detector_job", str(d), "export"], cwd=str(BASE_DIR),
                       capture_output=True, text=True, timeout=600)
    if not out.exists():
        raise RuntimeError(f"ONNX export failed: {(r.stdout + r.stderr)[-500:]}")
    return out


# ---------- "my guesses stopped improving: train a detector?" ----------

PLATEAU_BLOCK = 30      # judged guesses per block
PLATEAU_BLOCKS = 3      # consecutive blocks compared (the last 90 judged guesses)
PLATEAU_MIN_ERRORS = 0.10   # still wrong at least this often
PLATEAU_MIN_GAIN = 0.05     # an error rate that dropped by less than this is not improving


def _outcomes(db: Session) -> int:
    from sqlalchemy import func

    return db.scalar(select(func.count(Outcome.id))) or 0


def _dismissed_file() -> Path:
    return runs_dir() / "suggestion.json"


def plateau(oks: list[bool]) -> dict | None:
    """Errors per block over the last PLATEAU_BLOCKS blocks, if they stopped going down (oldest block first)."""
    n = PLATEAU_BLOCK * PLATEAU_BLOCKS
    if len(oks) < n:
        return None
    last = oks[-n:]
    errors = [PLATEAU_BLOCK - sum(last[k * PLATEAU_BLOCK:(k + 1) * PLATEAU_BLOCK]) for k in range(PLATEAU_BLOCKS)]
    first, latest = errors[0] / PLATEAU_BLOCK, errors[-1] / PLATEAU_BLOCK
    if latest < PLATEAU_MIN_ERRORS or first - latest >= PLATEAU_MIN_GAIN:
        return None
    return {"errors": errors, "block": PLATEAU_BLOCK}


def suggestion(db: Session) -> dict | None:
    """Pixel proposes a dedicated detector when its judged guesses have stopped improving.

    Only from real outcomes (hidden checks excluded), only with PLATEAU_BLOCKS x PLATEAU_BLOCK judgments made AFTER the
    last training started (a new detector deserves a fair chance), never while one is training, and silent after
    "Not now" until as many new judgments are still flat.
    """
    if busy():
        return None
    oks = [bool(o) for o in db.scalars(select(Outcome.correct).order_by(Outcome.id))]
    since = 0
    for r in list_runs():
        job = _read(runs_dir() / r["id"] / "job.json")
        since = max(since, int(job.get("outcomes_at_start") or 0))
    since = max(since, int(_read(_dismissed_file()).get("outcomes") or 0))
    p = plateau(oks[since:])
    if p is None:
        return None
    ready = readiness(db)
    return {"kind": "train_detector", **p, "judged": len(oks), "ready": ready["ready"],
            "finished_images": ready["images"], "min_images": ready["min_images"], "trained_before": bool(list_runs())}


def dismiss_suggestion(db: Session) -> None:
    write_json(_dismissed_file(), {"outcomes": _outcomes(db), "at": time.time()})

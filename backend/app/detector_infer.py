"""Running a trained detector (see detector.py) inside Kweeto.

Each project can mark one finished run as its ACTIVE detector. It runs on the app's ONNX Runtime (runtime.py: the
same execution provider as the other models, GPU included), with LibreYOLO's own pre/post-processing (letterbox,
NMS). Its classes are matched to the project's classes BY NAME (a class renamed or deleted since the training is
simply not reported).

The detector's scores are its own and uncalibrated: they are shown as a plain number, never as a percentage or a
"confidence"; the honest measure of the model is the mAP on its held-out images.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import detector, embedder, runtime, workspace
from .models import ImageItem, LabelClass

log = logging.getLogger("kweeto.detector")

MIN_SCORE = 0.1   # low on purpose: the view shows what the detector sees, weak boxes included (drawn faint)
_lock = threading.Lock()
_model: dict = {}                               # {"key": (project, run, mtime), "model": LibreYOLO backend, "provider": str}
_cache: OrderedDict[tuple, dict] = OrderedDict()  # (project, run, image_id) -> result
_CACHE_SIZE = 256


def _active_file() -> Path:
    return detector.runs_dir() / "active.json"


def active_id() -> str | None:
    try:
        rid = json.loads(_active_file().read_text(encoding="utf-8")).get("run")
    except Exception:
        return None
    try:
        d = detector.run_dir(rid)
    except KeyError:
        return None
    return rid if detector.checkpoint(d) is not None else None


def set_active(run_id: str | None) -> str | None:
    """Makes a run the project's detector (exports it to ONNX if needed); None turns it off."""
    if run_id is None:
        _active_file().unlink(missing_ok=True)
    else:
        d = detector.run_dir(run_id)
        if detector.run_out(d)["state"] in detector.LIVE:
            raise RuntimeError("This run is still training: wait for the end or stop it.")
        detector.onnx_file(run_id)  # make sure the ONNX model exists
        detector.write_json(_active_file(), {"run": run_id})
    with _lock:
        _model.clear()
        _cache.clear()
    from .worker import worker  # the detector looks at the images still to annotate (Pixel may use it)
    worker.wake()
    return active_id()


def _load(run_id: str):
    d = detector.run_dir(run_id)
    path = detector.onnx_file(run_id)
    key = (workspace.require().id, run_id, path.stat().st_mtime)
    if _model.get("key") == key:
        return _model["model"], _model["classes"], _model["provider"]
    from libreyolo import LibreYOLO

    classes = json.loads((d / "job.json").read_text(encoding="utf-8"))["dataset"]["classes"]
    model = LibreYOLO(str(path), nb_classes=len(classes), device="cpu")
    provider = "CPU"
    if runtime.runtime() == "onnx":  # same execution provider as the other models (DirectML, CUDA...)
        try:
            g = runtime.Graph(path)
            model.session = g.session
            provider = runtime.label(g.provider)
        except Exception as e:  # LibreYOLO's own CPU session still works
            log.warning("Detector stays on the CPU: %s", e)
    _model.clear()
    _model.update(key=key, model=model, classes=classes, provider=provider)
    return model, classes, provider


def _infer(run_id: str, pil, by_name: dict[str, tuple[int, str]]) -> tuple[list[dict], str]:
    """Runs the detector on one image (caller holds `_lock`). Classes are matched by name."""
    import numpy as np

    model, names, provider = _load(run_id)
    W, H = pil.size
    r = model(pil, conf=MIN_SCORE)
    boxes = []
    b = r.boxes
    if b is not None and len(b.xyxy):
        for (x0, y0, x1, y1), score, k in zip(np.asarray(b.xyxy, dtype=float), np.asarray(b.conf, dtype=float),
                                              np.asarray(b.cls, dtype=int)):
            name = names[k] if 0 <= k < len(names) else None
            cls = by_name.get(name) if name else None
            if cls is None:
                continue  # a class renamed or deleted since the training
            x, y = max(0.0, x0 / W), max(0.0, y0 / H)
            w, h = min(1.0, x1 / W) - x, min(1.0, y1 / H) - y
            if w <= 0 or h <= 0:
                continue
            boxes.append({"class_id": cls[0], "class_name": cls[1], "score": round(float(score), 3),
                          "x": x, "y": y, "w": w, "h": h})
    boxes.sort(key=lambda d: -d["score"])
    return boxes, provider


def scan_image(run_id: str, path: Path, by_name: dict[str, tuple[int, str]]):
    """The detector's boxes on one image file + the opened image (worker: no DB session needed)."""
    pil = embedder.load_image(path)
    with _lock:
        boxes, _provider = _infer(run_id, pil, by_name)
    return boxes, pil


def detect(db: Session, image_id: int) -> dict:
    """The active detector's boxes on one image (normalised x, y, w, h), cached."""
    run_id = active_id()
    if run_id is None:
        return {"run": None, "boxes": []}
    key = (workspace.require().id, run_id, image_id)
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
        img = db.get(ImageItem, image_id)
        if img is None:
            raise KeyError(image_id)
        by_name = {c.name: (c.id, c.name) for c in db.scalars(select(LabelClass))}
        pil = embedder.load_image(workspace.images_dir() / img.stored_name)
        t = time.time()
        boxes, provider = _infer(run_id, pil, by_name)
        ms = round((time.time() - t) * 1000)
        out = {"run": run_id, "provider": provider, "ms": ms, "boxes": boxes}
        _cache[key] = out
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
        return out


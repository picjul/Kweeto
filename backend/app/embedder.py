"""Pixel's "eyes": the active embedder (chosen by the engine profile, see profiles.py) and image helpers.

The embedders themselves are registered components (embedders.py, plugins.py): this module only keeps the
one in use, loads it lazily, and serialises the calls.
"""
from __future__ import annotations

import threading

import numpy as np
from PIL import Image, ImageOps

from . import plugins, profiles
from .config import CENTER_WINDOW, WINDOW_GRIDS

_lock = threading.Lock()
_current = None  # the loaded embedders.Embedder


def load_image(path) -> Image.Image:
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def windows() -> list[tuple[float, float, float, float, bool]]:
    """Normalised candidate windows (x, y, w, h, is_full)."""
    out: list[tuple[float, float, float, float, bool]] = []
    for g in WINDOW_GRIDS:
        for i in range(g):
            for j in range(g):
                out.append((j / g, i / g, 1 / g, 1 / g, g == 1))
    if CENTER_WINDOW:
        out.append((0.15, 0.15, 0.7, 0.7, False))
    return out


def crop_norm(img: Image.Image, x: float, y: float, w: float, h: float, pad: float = 0.0) -> Image.Image:
    W, H = img.size
    x0 = max(0.0, (x - w * pad)) * W
    y0 = max(0.0, (y - h * pad)) * H
    x1 = min(1.0, (x + w + w * pad)) * W
    y1 = min(1.0, (y + h + h * pad)) * H
    if x1 - x0 < 4:
        x1 = min(W, x0 + 4)
    if y1 - y0 < 4:
        y1 = min(H, y0 + 4)
    return img.crop((int(x0), int(y0), int(round(x1)), int(round(y1))))


def _get():
    """The active profile's embedder, loaded (caller holds `_lock`)."""
    global _current
    cfg = profiles.active
    if _current is None or (_current.id, _current.model) != (cfg.embedder, cfg.model):
        _current = None
        emb = plugins.EMBEDDERS.get(cfg.embedder)(cfg.model)
        emb.load()
        _current = emb
    return _current


def embed_images(images: list[Image.Image]) -> np.ndarray:
    if not images:
        return np.zeros((0, 0), dtype=np.float32)
    with _lock:
        return _get().embed(images)


def warmup() -> None:
    with _lock:
        _get()


def unload() -> None:
    """Frees the model (profile switch); the next call loads the active profile's model."""
    global _current
    with _lock:
        _current = None


def device() -> str:
    """Where the embedder runs: "DirectML", "CUDA", "CPU" (ONNX Runtime) or "cpu" / "cuda" / "mps" (PyTorch)."""
    cur = _current
    if cur is not None and (cur.id, cur.model) == (profiles.active.embedder, profiles.active.model):
        return "cpu (pixels)" if cur.id == "pixels" else cur.device
    return "cpu (pixels)" if profiles.active.embedder == "pixels" else "cpu"

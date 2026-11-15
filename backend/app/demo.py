"""One-click demo project: synthetic images ready to teach, so a first-time user sees Pixel learn in minutes.

The images come from demo_scenes.py (generated here, no download, no license question): tomatoes, limes and pipes
on plain backgrounds, several per image, with piles of touching fruit and pipes broken by a gap. The project gets
the three classes and a fast engine: the default profile's embedder with the "simple" (colour) segmenter, which
finds these objects well without SAM and scans an image in a fraction of a second. Without torch it falls back to
the "pixels" test embedder. Nothing is labelled in advance: the user teaches, as in a real project.
"""
from __future__ import annotations

import importlib.util
import io

from sqlalchemy import select

from . import db, embedder, profiles, projects, segmenter, services, workspace
from .demo_scenes import CLASSES, make_scene
from .models import ImageItem, LabelClass

N_IMAGES = 36
SIZE = (480, 360)
SEED = 4242
CLASS_COLORS = {"tomato": "#dc2626", "lime": "#65a30d", "pipe": "#2563eb"}
NAME = "Demo: fruit & pipes"
PIXEL = workspace.PixelTraits(name="Pixel", color="violet", shape="round", eyes="cyan", accessory="leaf")


def _engine() -> profiles.EngineConfig:
    base = profiles.PROFILES[profiles.DEFAULT_PROFILE]
    has_torch = importlib.util.find_spec("torch") is not None and importlib.util.find_spec("transformers") is not None
    emb = {"embedder": base.embedder, "model": base.model} if has_torch else {"embedder": "pixels", "model": ""}
    return profiles.resolve(profiles.CUSTOM, {**emb, "segmenter": "simple"})


def create() -> workspace.Project:
    """Creates and opens the demo project; its images are scanned by the worker in the background."""
    p = workspace.create(NAME, PIXEL)
    projects.open_project(p)
    cfg = _engine()
    profiles.set_active(cfg)
    profiles.record(cfg)
    embedder.unload()
    segmenter.unload()
    with db.SessionLocal() as s:
        for name in CLASSES:
            s.add(LabelClass(name=name, color=CLASS_COLORS.get(name, services.PALETTE[0])))
        known = set(s.scalars(select(ImageItem.content_hash)))
        for i in range(N_IMAGES):
            buf = io.BytesIO()
            make_scene(SEED + i, *SIZE).image.save(buf, "PNG")
            services.add_image(s, f"demo_{i + 1:03d}.png", buf.getvalue(), known)
        s.commit()
    from .worker import worker

    worker.wake()
    return p

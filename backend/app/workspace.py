"""Projects: each dataset is a separate project folder with its own database, images, engine profile and Pixel.

    DATA_DIR/
      projects.json              {"active": "<project id>"}
      projects/<id>/
        project.json             name, Pixel's traits, creation date
        teachme.db               SQLite (boxes, regions, proposals, ...)
        images/  thumbs/
        engine.json              engine profile + signature of the stored data (see profiles.py)

One project is active at a time (single user, local app). Isolation is by construction: switching project
swaps the database and the folders; deleting a project deletes its folder.
"""
from __future__ import annotations

import json
import random
import re
import shutil
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from .config import DATA_DIR

PROJECTS_DIR = DATA_DIR / "projects"
REGISTRY = DATA_DIR / "projects.json"
LEGACY_ITEMS = ("teachme.db", "teachme.db-wal", "teachme.db-shm", "images", "thumbs", "engine.json")

# ---------- Pixel's look ----------

# name -> (hue, saturation %, lightness % light theme, lightness % dark theme)
PALETTES = {
    "violet": (262, 83, 58, 66), "indigo": (239, 84, 58, 67), "sky": (199, 89, 45, 60),
    "teal": (173, 80, 36, 50), "emerald": (152, 69, 38, 52), "lime": (85, 70, 38, 52),
    "amber": (35, 92, 48, 58), "coral": (8, 82, 58, 66), "rose": (340, 82, 55, 65),
    "slate": (215, 25, 42, 62),
}
SHAPES = ("round", "square", "blob", "tall")
EYES = ("cyan", "lime", "amber", "pink", "white")
ACCESSORIES = ("none", "bow", "cap", "glasses", "headphones", "leaf")
NAMES = ("Pixel", "Bit", "Byte", "Voxel", "Texel", "Pico", "Nibble", "Kilo", "Glitch", "Sprite", "Dot", "Lumen")


@dataclass
class PixelTraits:
    name: str = "Pixel"
    color: str = "violet"
    shape: str = "round"
    eyes: str = "cyan"
    accessory: str = "none"

    @staticmethod
    def random(seed: str | None = None) -> "PixelTraits":
        rng = random.Random(seed)
        return PixelTraits(name=rng.choice(NAMES), color=rng.choice(list(PALETTES)), shape=rng.choice(SHAPES),
                           eyes=rng.choice(EYES), accessory=rng.choice(ACCESSORIES))

    def validated(self) -> "PixelTraits":
        name = (self.name or "Pixel").strip()[:24] or "Pixel"
        return PixelTraits(name=name,
                           color=self.color if self.color in PALETTES else "violet",
                           shape=self.shape if self.shape in SHAPES else "round",
                           eyes=self.eyes if self.eyes in EYES else "cyan",
                           accessory=self.accessory if self.accessory in ACCESSORIES else "none")


@dataclass
class Project:
    id: str
    name: str
    created_at: str
    pixel: PixelTraits = field(default_factory=PixelTraits)

    @property
    def dir(self) -> Path:
        return PROJECTS_DIR / self.id

    def out(self) -> dict:
        h, s, l_light, l_dark = PALETTES[self.pixel.color]
        return {"id": self.id, "name": self.name, "created_at": self.created_at, "pixel": asdict(self.pixel),
                "accent": {"light": f"{h} {s}% {l_light}%", "dark": f"{h} {s}% {l_dark}%"}}

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        data = {"id": self.id, "name": self.name, "created_at": self.created_at, "pixel": asdict(self.pixel)}
        (self.dir / "project.json").write_text(json.dumps(data, indent=2), encoding="utf-8")


# ---------- registry ----------

lock = threading.RLock()  # held while switching project, and by the worker while it commits
current: Project | None = None


def require() -> "Project":
    if current is None:
        from .db import NoProjectOpen

        raise NoProjectOpen("No project is open: create or open one first")
    return current


def images_dir() -> Path:
    return require().dir / "images"


def thumbs_dir() -> Path:
    return require().dir / "thumbs"


def db_path() -> Path:
    return require().dir / "teachme.db"


def engine_file() -> Path:
    return require().dir / "engine.json"


def _load(pdir: Path) -> Project | None:
    try:
        d = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
        traits = PixelTraits(**{k: v for k, v in (d.get("pixel") or {}).items() if k in PixelTraits.__annotations__})
        return Project(id=pdir.name, name=d.get("name") or pdir.name, created_at=d.get("created_at", ""),
                       pixel=traits.validated())
    except Exception:
        return None


def list_projects() -> list[Project]:
    if not PROJECTS_DIR.exists():
        return []
    out = [p for p in (_load(d) for d in PROJECTS_DIR.iterdir() if d.is_dir()) if p is not None]
    return sorted(out, key=lambda p: p.created_at)


def get(pid: str) -> Project | None:
    if not re.fullmatch(r"[a-z0-9-]{1,64}", pid or ""):
        return None
    return _load(PROJECTS_DIR / pid)


def _slug(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32] or "project"
    return f"{base}-{uuid.uuid4().hex[:6]}"


def create(name: str, pixel: PixelTraits | None = None) -> Project:
    name = name.strip()[:64] or "Untitled project"
    pid = _slug(name)
    p = Project(id=pid, name=name, created_at=datetime.now().isoformat(timespec="seconds"),
                pixel=(pixel or PixelTraits.random(pid)).validated())
    for sub in ("images", "thumbs"):
        (p.dir / sub).mkdir(parents=True, exist_ok=True)
    p.save()
    return p


def update(pid: str, name: str | None = None, pixel: PixelTraits | None = None) -> Project | None:
    p = get(pid)
    if p is None:
        return None
    if name is not None and name.strip():
        p.name = name.strip()[:64]
    if pixel is not None:
        p.pixel = pixel.validated()
    p.save()
    if current is not None and current.id == pid:
        current.name, current.pixel = p.name, p.pixel
    return p


def remove_dir(pid: str) -> bool:
    """Deletes a (non-active) project's folder."""
    p = get(pid)
    if p is None or (current is not None and current.id == pid):
        return False
    shutil.rmtree(p.dir, ignore_errors=False)
    return True


def remember_active(pid: str | None) -> None:
    REGISTRY.write_text(json.dumps({"active": pid}), encoding="utf-8")


def stored_active() -> str | None:
    try:
        return json.loads(REGISTRY.read_text(encoding="utf-8")).get("active")
    except Exception:
        return None


def migrate_legacy() -> Project | None:
    """Moves a pre-projects data folder (DATA_DIR/teachme.db, images/, ...) into a project, losing nothing."""
    if not (DATA_DIR / "teachme.db").exists():
        return None
    p = create("My project", PixelTraits())  # the classic violet Pixel, as before
    for item in LEGACY_ITEMS:
        src = DATA_DIR / item
        if not src.exists():
            continue
        dst = p.dir / item
        if dst.is_dir() and not any(dst.iterdir()):
            dst.rmdir()  # the empty folders created for the new project
        shutil.move(str(src), str(dst))
    return p

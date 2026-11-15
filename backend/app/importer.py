"""Import of existing annotations (COCO, YOLO, Pascal VOC, Label Studio, CVAT) into the open project.

Flow: the client opens a staging area, sends files into it (images, annotation files, zips: extracted here),
asks for a preview (which format, how many boxes, which classes, which images match) and then commits. The
commit runs in a background thread with progress; the staging folder is removed at the end.

What the files become:
- every imported box is a confirmed Box (source "import"): an example Pixel learns from, exactly like a box
  drawn in a Lesson. They are human labels made in another tool (Label Studio *predictions* are not imported).
- `complete` (default on): an image with imported boxes is also *finished* (verified), so its other regions
  teach Pixel what is not an object. COCO "crowd" boxes (a group, not one object) are skipped and keep their
  image unfinished. Images listed WITHOUT boxes are finished only with `empty_negative`: many tools list
  every image of a task, labelled or not.
- uploaded images that no annotation mentions are imported as images still to teach.
- images already in the project are matched by content (hash) or by file name. One that already has boxes
  keeps them: the import never mixes its boxes with yours.

Coordinates are normalised with the image size the file states (or the image's own size). When that is the
raw size of a photo with an EXIF rotation, the boxes are rotated with it: Kweeto shows images upright.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import threading
import time
import uuid
import zipfile
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from math import cos, radians, sin
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree

from PIL import Image
from sqlalchemy import func, select

from . import db, services, workspace
from .config import ALLOWED_EXT
from .models import Box, Event, ImageItem, LabelClass, Verification

log = logging.getLogger("kweeto.import")

FORMATS = {
    "coco": "COCO JSON (instances_*.json): images, categories, bbox annotations",
    "yolo": "YOLO / Ultralytics: one .txt per image (class cx cy w h, or a polygon) + data.yaml or classes.txt",
    "voc": "Pascal VOC: one XML per image (<annotation> with <object><bndbox>)",
    "labelstudio": "Label Studio JSON export (full or JSON-MIN): rectangles and polygons",
    "cvat": "CVAT for images 1.1 XML: boxes, polygons, polylines, points, masks",
}
PREFERENCE = ("coco", "cvat", "labelstudio", "voc", "yolo")  # on a tie in boxes
LS_PREFIX = re.compile(r"^[0-9a-f]{8}-")                    # Label Studio prefixes uploaded files with a hash
NAMES_FILES = {"classes.txt", "obj.names", "labels.txt", "classes.names"}
STALE_S = 24 * 3600


@dataclass
class Rec:
    """The annotation of one image as found in a file."""
    ref: str                                   # image reference as written (path, URL) or the YOLO label path
    boxes: list[tuple[str, float, float, float, float]] = field(default_factory=list)  # class, x, y, w, h
    units: str = "px"                          # px | norm
    size: tuple[int, int] | None = None        # image size the file states (px units)
    complete: bool = True                      # False: some objects are not boxed one by one (COCO crowd)
    yolo: bool = False                         # ref is a label file: match the image by stem


@dataclass
class Job:
    id: str
    project_id: str
    status: str = "staging"      # staging | running | done | error | cancelled
    done: int = 0
    total: int = 0
    error: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    finished_at: str | None = None
    counts: dict = field(default_factory=dict)
    format: str | None = None
    message: str | None = None

    def out(self) -> dict:
        return asdict(self)


_jobs: dict[str, Job] = {}
_parsed: dict[str, tuple[int, dict, list[str]]] = {}   # job id -> (files version, {format: [Rec]}, warnings)
_version: dict[str, int] = {}
_lock = threading.Lock()


# ---------- staging ----------

def _root() -> Path:
    d = workspace.require().dir / "imports"
    d.mkdir(exist_ok=True)
    return d


def stage_dir(job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{10}", job_id):
        raise KeyError(job_id)
    return _root() / job_id


def create() -> Job:
    pid = workspace.require().id
    for old in _root().iterdir():  # leftovers of imports never committed
        try:
            if old.is_dir() and time.time() - old.stat().st_mtime > STALE_S and old.name not in _jobs:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass
    j = Job(id=uuid.uuid4().hex[:10], project_id=pid)
    stage_dir(j.id).mkdir()
    _jobs[j.id] = j
    _version[j.id] = 0
    return j


def get(job_id: str) -> Job:
    j = _jobs.get(job_id)
    if j is None or j.project_id != workspace.require().id:
        raise KeyError(job_id)
    return j


def _safe_rel(name: str) -> str | None:
    """A sanitised relative path (no drive, no .., no hidden macOS junk) or None to skip the file."""
    parts = [p for p in re.split(r"[\\/]+", name or "") if p not in ("", ".", "..")]
    if not parts or parts[0] == "__MACOSX" or parts[-1].startswith("._") or parts[-1] in (".DS_Store", "Thumbs.db"):
        return None
    parts = [re.sub(r'[<>:"|?*\x00-\x1f]', "_", p)[:200] for p in parts]
    return "/".join(parts)


def add_file(job_id: str, name: str, fileobj) -> int:
    """Stores one uploaded file in the staging area (a zip is extracted). Returns how many files it added."""
    j = get(job_id)
    if j.status != "staging":
        raise RuntimeError("This import has already started")
    root = stage_dir(job_id)
    rel = _safe_rel(name)
    if rel is None:
        return 0
    added = 0
    if rel.lower().endswith(".zip"):
        base = rel[:-4]
        with zipfile.ZipFile(fileobj) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                sub = _safe_rel(info.filename)
                if sub is None:
                    continue
                dest = root / base / sub
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out, 1 << 20)
                added += 1
    else:
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as out:
            shutil.copyfileobj(fileobj, out, 1 << 20)
        added = 1
    with _lock:
        _version[job_id] = _version.get(job_id, 0) + 1
    return added


def discard(job_id: str) -> None:
    j = get(job_id)
    if j.status == "running":
        j.status = "cancelled"
        return
    _jobs.pop(job_id, None)
    _parsed.pop(job_id, None)
    _digest_cache.pop(job_id, None)
    shutil.rmtree(stage_dir(job_id), ignore_errors=True)


def _files(root: Path) -> list[str]:
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


def _is_image(rel: str) -> bool:
    return PurePosixPath(rel).suffix.lower() in ALLOWED_EXT


# ---------- parsers ----------

def _num(v, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _poly_box(xs: list[float], ys: list[float]) -> tuple[float, float, float, float] | None:
    if not xs or not ys:
        return None
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def _parse_coco(d: dict, warn: list[str], src: str) -> list[Rec]:
    cats = {c.get("id"): str(c.get("name", c.get("id"))) for c in d.get("categories") or []}
    recs: dict = {}
    for im in d.get("images") or []:
        w, h = int(_num(im.get("width"))), int(_num(im.get("height")))
        recs[im.get("id")] = Rec(ref=str(im.get("file_name") or ""), units="px", size=(w, h) if w > 0 and h > 0 else None)
    crowd = 0
    for a in d.get("annotations") or []:
        r = recs.get(a.get("image_id"))
        if r is None:
            continue
        if a.get("iscrowd"):
            r.complete = False
            crowd += 1
            continue
        bb = a.get("bbox")
        g = None
        if isinstance(bb, list) and len(bb) >= 4:
            g = tuple(_num(v) for v in bb[:4])
        elif isinstance(a.get("segmentation"), list) and a["segmentation"] and isinstance(a["segmentation"][0], list):
            pts = [p for poly in a["segmentation"] for p in poly]
            g = _poly_box([_num(v) for v in pts[0::2]], [_num(v) for v in pts[1::2]])
        if g is None:
            continue
        r.boxes.append((cats.get(a.get("category_id"), str(a.get("category_id"))), *g))
    if crowd:
        warn.append(f"{src}: {crowd} crowd annotations (a group of objects, not one) were skipped; "
                    "their images are imported as not finished.")
    return list(recs.values())


def _ls_ref(data: dict) -> str | None:
    if not isinstance(data, dict):
        return None
    for k in ("image", "img", "url", "image_url"):
        if isinstance(data.get(k), str):
            return data[k]
    for v in data.values():
        if isinstance(v, str) and PurePosixPath(urlparse(v).path).suffix.lower() in ALLOWED_EXT:
            return v
    return None


def _ls_boxes(items: list[dict]) -> tuple[list, tuple[int, int] | None]:
    """Label Studio results (full export `result` or JSON-MIN label dicts) -> boxes in normalised units."""
    labels_by_id: dict = {}
    for it in items:
        v = it.get("value") if isinstance(it.get("value"), dict) else None
        if v is not None and it.get("type") == "labels" and v.get("labels"):
            labels_by_id[it.get("id")] = v["labels"][0]
    out, size = [], None
    for it in items:
        v = it.get("value") if isinstance(it.get("value"), dict) else it  # JSON-MIN: the item is the value
        ow, oh = int(_num(it.get("original_width") or v.get("original_width"))), int(_num(it.get("original_height") or v.get("original_height")))
        if ow > 0 and oh > 0:
            size = (ow, oh)
        name = None
        for key in ("rectanglelabels", "polygonlabels", "labels"):
            if isinstance(v.get(key), list) and v[key]:
                name = str(v[key][0])
                break
        name = name or labels_by_id.get(it.get("id"))
        if name is None:
            continue
        if "points" in v and isinstance(v["points"], list) and v["points"]:
            pts = [(_num(p[0]) / 100, _num(p[1]) / 100) for p in v["points"] if isinstance(p, (list, tuple)) and len(p) >= 2]
            g = _poly_box([p[0] for p in pts], [p[1] for p in pts])
        elif all(k in v for k in ("x", "y", "width", "height")):
            x, y, w, h = (_num(v[k]) / 100 for k in ("x", "y", "width", "height"))
            rot = _num(v.get("rotation"))
            if rot and ow > 0 and oh > 0:  # rotated around its top-left corner, clockwise, in pixels
                c, s = cos(radians(rot)), sin(radians(rot))
                X, Y, W, H = x * ow, y * oh, w * ow, h * oh
                xs = [X + dx * c - dy * s for dx, dy in ((0, 0), (W, 0), (W, H), (0, H))]
                ys = [Y + dx * s + dy * c for dx, dy in ((0, 0), (W, 0), (W, H), (0, H))]
                gx = _poly_box(xs, ys)
                g = (gx[0] / ow, gx[1] / oh, gx[2] / ow, gx[3] / oh)
            else:
                g = (x, y, w, h)
        else:
            continue
        if g is not None:
            out.append((name, *g))
    return out, size


def _parse_labelstudio(tasks: list, warn: list[str], src: str) -> list[Rec]:
    recs, unlabelled = [], 0
    for t in tasks:
        if not isinstance(t, dict):
            continue
        if isinstance(t.get("data"), dict):  # full export
            ref = _ls_ref(t["data"])
            anns = [a for a in (t.get("annotations") or t.get("completions") or [])
                    if isinstance(a, dict) and not a.get("was_cancelled")]
            if ref is None:
                continue
            if not anns:
                unlabelled += 1
                continue
            items = [r for r in anns[-1].get("result") or [] if isinstance(r, dict)]  # the latest annotation
        else:  # JSON-MIN: {"image": ..., "<control name>": [{x, y, width, height, rectanglelabels}], ...}
            ref = _ls_ref(t)
            if ref is None:
                continue
            items = [d for v in t.values() if isinstance(v, list) for d in v if isinstance(d, dict)]
        boxes, size = _ls_boxes(items)
        recs.append(Rec(ref=ref, boxes=boxes, units="norm", size=size))
    if unlabelled:
        warn.append(f"{src}: {unlabelled} tasks have no annotation yet (predictions are not imported).")
    return recs


def _is_labelstudio(d) -> bool:
    if not isinstance(d, list) or not d or not isinstance(d[0], dict):
        return False
    t = d[0]
    if isinstance(t.get("data"), dict) and ("annotations" in t or "completions" in t or "predictions" in t):
        return True
    return _ls_ref(t) is not None and any(isinstance(v, list) for v in t.values())


def _parse_voc(root, src: str) -> Rec:
    fn = (root.findtext("filename") or "").strip() or PurePosixPath(src).stem
    size = root.find("size")
    w = int(_num(size.findtext("width"))) if size is not None else 0
    h = int(_num(size.findtext("height"))) if size is not None else 0
    rec = Rec(ref=fn, units="px", size=(w, h) if w > 0 and h > 0 else None)
    for o in root.iter("object"):
        bb = o.find("bndbox")
        name = (o.findtext("name") or "").strip()
        if bb is None or not name:
            continue
        x0, y0 = _num(bb.findtext("xmin")), _num(bb.findtext("ymin"))
        x1, y1 = _num(bb.findtext("xmax")), _num(bb.findtext("ymax"))
        rec.boxes.append((name, x0 - 1, y0 - 1, x1 - x0 + 1, y1 - y0 + 1))  # VOC pixels are 1-based, inclusive
    return rec


def _parse_cvat(root, warn: list[str], src: str) -> list[Rec]:
    recs = []
    for im in root.iter("image"):
        w, h = int(_num(im.get("width"))), int(_num(im.get("height")))
        rec = Rec(ref=im.get("name") or "", units="px", size=(w, h) if w > 0 and h > 0 else None)
        for el in im:
            label = el.get("label")
            if not label:
                continue
            g = None
            if el.tag == "box":
                x0, y0, x1, y1 = (_num(el.get(k)) for k in ("xtl", "ytl", "xbr", "ybr"))
                rot = _num(el.get("rotation"))
                if rot:  # rotated around its centre, clockwise
                    cx, cy, c, s = (x0 + x1) / 2, (y0 + y1) / 2, cos(radians(rot)), sin(radians(rot))
                    pts = [(cx + dx * c - dy * s, cy + dx * s + dy * c)
                           for dx, dy in ((x0 - cx, y0 - cy), (x1 - cx, y0 - cy), (x1 - cx, y1 - cy), (x0 - cx, y1 - cy))]
                    g = _poly_box([p[0] for p in pts], [p[1] for p in pts])
                else:
                    g = (x0, y0, x1 - x0, y1 - y0)
            elif el.tag in ("polygon", "polyline", "points"):
                pts = [tuple(_num(v) for v in p.split(",")[:2]) for p in (el.get("points") or "").split(";") if "," in p]
                g = _poly_box([p[0] for p in pts], [p[1] for p in pts])
            elif el.tag == "mask":
                g = tuple(_num(el.get(k)) for k in ("left", "top", "width", "height"))
            elif el.tag == "ellipse":
                cx, cy, rx, ry = (_num(el.get(k)) for k in ("cx", "cy", "rx", "ry"))
                g = (cx - rx, cy - ry, 2 * rx, 2 * ry)
            if g is not None:
                rec.boxes.append((label, *g))
        recs.append(rec)
    tracks = sum(1 for _ in root.iter("track"))
    if tracks:
        warn.append(f"{src}: {tracks} video tracks were skipped (export the task as 'CVAT for images').")
    return recs


def _yaml_names(text: str) -> list[str] | None:
    try:
        import yaml  # noqa: PLC0415 - optional (comes with the full install)
        d = yaml.safe_load(text)
        names = d.get("names") if isinstance(d, dict) else None
    except ImportError:
        names = _mini_yaml_names(text)
    except Exception:
        return None
    if isinstance(names, dict):
        return [str(names[k]) for k in sorted(names, key=lambda k: int(k))]
    if isinstance(names, list):
        return [str(n) for n in names]
    return None


def _mini_yaml_names(text: str):
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        m = re.match(r"^names\s*:\s*(.*)$", ln)
        if not m:
            continue
        inline = m.group(1).strip()
        if inline.startswith("["):
            return [s.strip().strip("'\"") for s in inline.strip("[]").split(",") if s.strip()]
        out: dict | list = {}
        for sub in lines[i + 1:]:
            if not sub.startswith((" ", "\t", "-")):
                break
            kv = re.match(r"^\s*(\d+)\s*:\s*(.+)$", sub)
            it = re.match(r"^\s*-\s*(.+)$", sub)
            if kv:
                out[int(kv.group(1))] = kv.group(2).strip().strip("'\"")
            elif it:
                out = out if isinstance(out, list) else []
                out.append(it.group(1).strip().strip("'\""))
        return out
    return None


def _yolo_label(text: str) -> list[tuple[int, float, float, float, float]] | None:
    """Parses a YOLO label file; None when the text is not one (an image list, a README...)."""
    out = []
    for ln in text.splitlines():
        parts = ln.split()
        if not parts:
            continue
        try:
            cls = int(parts[0])
            vals = [float(v) for v in parts[1:]]
        except ValueError:
            return None
        if cls < 0 or len(vals) < 4 or any(v < -0.01 or v > 1.01 for v in vals[:4]):
            return None
        if len(vals) in (4, 5):  # cx cy w h (+ a confidence)
            cx, cy, w, h = vals[:4]
            out.append((cls, cx - w / 2, cy - h / 2, w, h))
        elif len(vals) % 2 == 0:  # polygon (segmentation)
            g = _poly_box(vals[0::2], vals[1::2])
            out.append((cls, *g))
        else:
            return None
    return out


def parse(job_id: str) -> tuple[dict[str, list[Rec]], list[str], list[str]]:
    """{format: [Rec]} found in the staging area, the warnings, and the staged images. Cached per upload."""
    root = stage_dir(job_id)
    files = _files(root)
    images = [f for f in files if _is_image(f)]
    v = _version.get(job_id, 0)
    hit = _parsed.get(job_id)
    if hit and hit[0] == v:
        return hit[1], hit[2], images
    found: dict[str, list[Rec]] = defaultdict(list)
    warn: list[str] = []
    yolo_names: list[str] | None = None
    yolo_files: list[str] = []
    for rel in files:
        low = rel.lower()
        name = PurePosixPath(low).name
        path = root / rel
        try:
            if low.endswith(".json"):
                d = json.loads(path.read_text(encoding="utf-8-sig"))
                if isinstance(d, dict) and isinstance(d.get("images"), list) and isinstance(d.get("annotations"), list):
                    found["coco"] += _parse_coco(d, warn, rel)
                elif _is_labelstudio(d):
                    found["labelstudio"] += _parse_labelstudio(d, warn, rel)
            elif low.endswith(".xml"):
                x = ElementTree.parse(path).getroot()
                if x.tag == "annotation":
                    found["voc"].append(_parse_voc(x, rel))
                elif x.tag == "annotations":
                    found["cvat"] += _parse_cvat(x, warn, rel)
            elif low.endswith((".yaml", ".yml")) and yolo_names is None:
                yolo_names = _yaml_names(path.read_text(encoding="utf-8", errors="replace"))
            elif name in NAMES_FILES or low.endswith(".names"):
                if yolo_names is None:
                    yolo_names = [ln.strip() for ln in path.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
            elif low.endswith(".txt"):
                yolo_files.append(rel)
        except Exception as e:  # a broken file must not stop the others
            warn.append(f"{rel}: could not be read ({type(e).__name__}).")
    def name_of(k: int) -> str:
        return yolo_names[k] if yolo_names and k < len(yolo_names) else f"class {k}"

    for rel in yolo_files:
        lab = _yolo_label((root / rel).read_text(encoding="utf-8", errors="replace"))
        if lab is None:
            continue
        found["yolo"].append(Rec(ref=rel, boxes=[(name_of(c), *g) for c, *g in lab], units="norm", yolo=True))
    if found.get("yolo") and not yolo_names:
        warn.append("YOLO: no data.yaml or classes.txt found, classes are named by their number.")
    out = {k: v for k, v in found.items() if v}
    with _lock:
        _parsed[job_id] = (v, out, warn)
    return out, warn, images


# ---------- matching images ----------

def _ref_names(ref: str) -> tuple[list[str], list[str]]:
    """(lower-case path segments, candidate file names) of an image reference (path or URL)."""
    path = unquote(urlparse(ref).path if re.match(r"^[a-z][a-z0-9+.-]*://", ref, re.I) else ref)
    segs = [s for s in re.split(r"[\\/]+", path.lower()) if s]
    if not segs:
        return [], []
    names = [segs[-1]]
    stripped = LS_PREFIX.sub("", segs[-1])
    if stripped != segs[-1]:
        names.append(stripped)
    return segs, names


def _common_tail(a: list[str], b: list[str]) -> int:
    n = 0
    while n < min(len(a), len(b)) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


class _Index:
    def __init__(self, images: list[str]) -> None:
        self.by_name: dict[str, list[str]] = defaultdict(list)
        self.by_stem: dict[str, list[str]] = defaultdict(list)
        for p in images:
            pp = PurePosixPath(p.lower())
            self.by_name[pp.name].append(p)
            self.by_stem[pp.stem].append(p)

    @staticmethod
    def _best(cands: list[str], segs: list[str]) -> str:
        return max(cands, key=lambda c: (_common_tail(c.lower().split("/")[:-1], segs[:-1]), -len(c)))

    def find(self, rec: Rec) -> str | None:
        if rec.yolo:  # labels/train/x.txt -> images/train/x.jpg, else same folder, else the closest x.*
            segs = rec.ref.lower().split("/")
            stem = PurePosixPath(segs[-1]).stem
            cands = self.by_stem.get(stem, [])
            if not cands:
                return None
            want = ["images" if s == "labels" else s for s in segs]
            return self._best(cands, want)
        segs, names = _ref_names(rec.ref)
        for n in names:
            cands = self.by_name.get(n) or ([] if PurePosixPath(n).suffix else self.by_stem.get(n, []))
            if cands:
                return self._best(cands, segs)
        return None


def _project_index(s) -> tuple[dict[str, int], dict[str, int], set[int]]:
    """(lower file name -> image id, lower stem -> id, ids of images that already have boxes)."""
    by_name, by_stem = {}, {}
    for iid, fn in s.execute(select(ImageItem.id, ImageItem.filename).order_by(ImageItem.id)).all():
        low = fn.lower()
        by_name.setdefault(low, iid)
        by_stem.setdefault(PurePosixPath(low).stem, iid)
    boxed = set(s.scalars(select(Box.image_id).distinct()))
    return by_name, by_stem, boxed


def _match_project(rec: Rec, by_name: dict, by_stem: dict) -> int | None:
    if rec.yolo:
        return by_stem.get(PurePosixPath(rec.ref.lower()).stem)
    _segs, names = _ref_names(rec.ref)
    for n in names:
        if n in by_name:
            return by_name[n]
        if not PurePosixPath(n).suffix and n in by_stem:
            return by_stem[n]
    return None


def plan(job_id: str, fmt: str | None = None) -> dict:
    """What a commit would do: the preview shown before importing."""
    found, warn, images = parse(job_id)
    if fmt is None or fmt not in found:
        fmt = max(found, key=lambda k: (sum(len(r.boxes) for r in found[k]), -PREFERENCE.index(k))) if found else None
    recs = found.get(fmt, []) if fmt else []
    idx = _Index(images)
    with db.SessionLocal() as s:
        by_name, by_stem, boxed = _project_index(s)
        existing = {c.lower(): c for c in s.scalars(select(LabelClass.name))}
        n_project = s.scalar(select(func.count(ImageItem.id))) or 0
        by_hash = dict(s.execute(select(ImageItem.content_hash, ImageItem.id)).all())
    digest = _digests(job_id, images)
    here = {p: by_hash[d] for p, d in digest.items() if d in by_hash}  # uploaded again: already in the project
    matches: list[tuple[Rec, str | None, int | None]] = []
    missing: list[str] = []
    used: set = set()
    dup_recs = 0
    for r in recs:
        p = idx.find(r)
        pid = None if p else _match_project(r, by_name, by_stem)
        key = p or pid
        if key is None:
            missing.append(r.ref)
            continue
        if key in used:
            dup_recs += 1
            continue
        used.add(key)
        matches.append((r, p, pid if pid is not None else here.get(p)))
    if dup_recs:
        warn = warn + [f"{dup_recs} images are annotated twice in the files: only the first annotation is used."]
    labelled_stage = {p for _r, p, _i in matches if p}
    keeps_boxes = sum(1 for _r, _p, i in matches if i is not None and i in boxed)
    cls = Counter()
    cls_imgs: dict[str, set] = defaultdict(set)
    for r, p, i in matches:
        if i is not None and i in boxed:
            continue
        for b in r.boxes:
            cls[b[0].strip()[:64] or "unnamed"] += 1
            cls_imgs[b[0].strip()[:64] or "unnamed"].add(p or i)
    return {
        "format": fmt,
        "formats": {k: {"title": FORMATS[k], "images": len(v), "boxes": sum(len(r.boxes) for r in v)} for k, v in found.items()},
        "files": len(_files(stage_dir(job_id))),
        "images_uploaded": len(images),
        "annotated": len(matches),
        "with_boxes": sum(1 for r, _p, i in matches if r.boxes and not (i is not None and i in boxed)),
        "listed_empty": sum(1 for r, _p, i in matches if not r.boxes and not (i is not None and i in boxed)),
        "in_project": sum(1 for _r, p, _i in matches if p is None),
        "already_here": len(here),
        "keeps_boxes": keeps_boxes,
        "unlabelled": len(set(images) - labelled_stage),
        "missing": len(missing),
        "missing_examples": missing[:5],
        "boxes": sum(cls.values()),
        "classes": [{"name": n, "boxes": k, "images": len(cls_imgs[n]), "existing": existing.get(n.lower())}
                    for n, k in cls.most_common()],
        "project_images": n_project,
        "warnings": warn[:20],
        "_matches": matches,
    }


_digest_cache: dict[str, dict[str, tuple[int, float, str]]] = {}


def _digests(job_id: str, images: list[str]) -> dict[str, str]:
    """Content hash of every staged image (cached by size + mtime: the preview is asked for more than once)."""
    root = stage_dir(job_id)
    cache = _digest_cache.setdefault(job_id, {})
    out = {}
    for rel in images:
        st = (root / rel).stat()
        hit = cache.get(rel)
        if hit is None or hit[:2] != (st.st_size, st.st_mtime):
            hit = (st.st_size, st.st_mtime, hashlib.sha1((root / rel).read_bytes()).hexdigest())
            cache[rel] = hit
        out[rel] = hit[2]
    return out


# ---------- geometry ----------

def _orient(g: tuple[float, float, float, float], o: int) -> tuple[float, float, float, float]:
    """A normalised box of the raw (stored) pixels -> the same box on the upright image (EXIF orientation o)."""
    x, y, w, h = g
    return {
        2: (1 - x - w, y, w, h), 3: (1 - x - w, 1 - y - h, w, h), 4: (x, 1 - y - h, w, h),
        5: (y, x, h, w), 6: (1 - y - h, x, h, w), 7: (1 - y - h, 1 - x - w, h, w), 8: (y, 1 - x - w, h, w),
    }.get(o, g)


def _raw_info(path: Path) -> tuple[tuple[int, int], int]:
    with Image.open(path) as im:
        try:
            o = int(im.getexif().get(0x0112, 1))
        except Exception:
            o = 1
        return im.size, o


def normalise(rec: Rec, upright: tuple[int, int], raw: tuple[tuple[int, int], int] | None) -> tuple[list, int]:
    """(normalised boxes clipped to the image, how many fell outside it)."""
    W, H = upright
    o = 1
    if rec.units == "px":
        size = rec.size or (W, H)
        if raw and rec.size and raw[1] in (5, 6, 7, 8) and rec.size == raw[0] and rec.size != (W, H):
            o = raw[1]  # the file used the raw, un-rotated pixels
    out, outside = [], 0
    for name, x, y, w, h in rec.boxes:
        g = (x / size[0], y / size[1], w / size[0], h / size[1]) if rec.units == "px" else (x, y, w, h)
        g = _orient(g, o)
        x0, y0 = max(0.0, min(1.0, g[0])), max(0.0, min(1.0, g[1]))
        x1, y1 = max(0.0, min(1.0, g[0] + g[2])), max(0.0, min(1.0, g[1] + g[3]))
        if x1 - x0 < 1e-4 or y1 - y0 < 1e-4:
            outside += 1
            continue
        out.append((name.strip()[:64] or "unnamed", x0, y0, max(0.002, x1 - x0), max(0.002, y1 - y0)))
    return out, outside


# ---------- commit ----------

def commit(job_id: str, fmt: str | None, complete: bool, empty_negative: bool, skip_classes: list[str]) -> Job:
    j = get(job_id)
    if j.status != "staging":
        raise RuntimeError("This import has already started")
    p = plan(job_id, fmt)
    if not p["annotated"] and not p["images_uploaded"]:
        raise ValueError("Nothing to import: no annotation matched an image and no image was uploaded")
    j.status, j.format = "running", p["format"]
    j.total = p["images_uploaded"] + p["annotated"]
    threading.Thread(target=_run, args=(j, p, complete, empty_negative, {c.lower() for c in skip_classes}),
                     daemon=True, name=f"import-{j.id}").start()
    return j


def _alive(j: Job) -> bool:
    return j.status == "running" and workspace.current is not None and workspace.current.id == j.project_id


def _run(j: Job, p: dict, complete: bool, empty_negative: bool, skip: set[str]) -> None:
    from .worker import worker

    root = stage_dir(j.id)
    k = Counter()
    try:
        _, _, images = parse(j.id)
        with db.SessionLocal() as s:
            known = dict(s.execute(select(ImageItem.content_hash, ImageItem.id)).all())
            boxed = set(s.scalars(select(Box.image_id).distinct()))
            classes = {c.name.lower(): c.id for c in s.scalars(select(LabelClass))}
            n_classes = len(classes)
        # 1. the images (new ones are scanned by the worker as usual)
        image_of: dict[str, int] = {}
        for start in range(0, len(images), 32):
            with workspace.lock:
                if not _alive(j):
                    break
                with db.SessionLocal() as s:
                    fresh: dict[str, ImageItem] = {}       # digest -> new row (ids after the flush)
                    same: list[tuple[str, str]] = []       # (path, digest) of copies of an image of this chunk
                    for rel in images[start:start + 32]:
                        data = (root / rel).read_bytes()
                        digest = hashlib.sha1(data).hexdigest()
                        if digest in known or digest in fresh:  # the same file again (another folder, already here)
                            same.append((rel, digest))
                            k["duplicates"] += 1
                        else:
                            out = services.store_image(s, PurePosixPath(rel).name, data, set())
                            if isinstance(out, str):
                                k["rejected"] += 1
                            else:
                                fresh[digest] = out
                                image_of[rel] = -1
                                same.append((rel, digest))
                        j.done += 1
                    s.flush()
                    for digest, item in fresh.items():
                        known[digest] = item.id
                    for rel, digest in same:
                        image_of[rel] = known[digest]
                    k["images"] += len(fresh)
                    s.commit()
            worker.wake()
        # 2. the boxes
        matches = p["_matches"]
        for start in range(0, len(matches), 64):
            with workspace.lock:
                if not _alive(j):
                    break
                with db.SessionLocal() as s:
                    for rec, rel, pid in matches[start:start + 64]:
                        j.done += 1
                        iid = image_of.get(rel) if rel else pid
                        img = s.get(ImageItem, iid) if iid else None
                        if img is None:
                            continue
                        if img.id in boxed:
                            k["kept_yours"] += 1
                            continue
                        path = workspace.images_dir() / img.stored_name
                        raw = _raw_info(path) if rec.units == "px" and rec.size and rec.size != (img.width, img.height) else None
                        bxs, outside = normalise(rec, (img.width, img.height), raw)
                        k["outside"] += outside
                        kept = [b for b in bxs if b[0].lower() not in skip]
                        k["skipped_class"] += len(bxs) - len(kept)
                        for name, x, y, w, h in kept:
                            cid = classes.get(name.lower())
                            if cid is None:
                                c = LabelClass(name=name, color=services.PALETTE[len(classes) % len(services.PALETTE)])
                                s.add(c)
                                s.flush()
                                cid = classes[name.lower()] = c.id
                            s.add(Box(image_id=img.id, class_id=cid, x=x, y=y, w=w, h=h, source="import"))
                        k["boxes"] += len(kept)
                        if kept:
                            boxed.add(img.id)
                            k["annotated"] += 1
                        finish = bool(kept and complete and rec.complete and len(kept) == len(bxs)) or bool(not rec.boxes and empty_negative)
                        if finish and s.get(Verification, img.id) is None:
                            s.add(Verification(image_id=img.id))
                            k["finished"] += 1
                        if (kept or finish) and img.status == "embedded":
                            img.status = "annotated"
                    s.commit()
        k["classes_new"] = len(classes) - n_classes
        with db.SessionLocal() as s:
            s.add(Event(type="import", payload={"format": j.format, **k}))
            s.commit()
        j.counts = dict(k)
        j.message = message(dict(k))
        if j.status == "running":
            j.status = "done"
        worker.wake()  # embeds the new boxes, scans the new images, then Pixel re-learns
    except Exception as e:  # pragma: no cover - reported to the page
        log.exception("import failed")
        j.status, j.error = "error", f"{type(e).__name__}: {e}"
        j.counts = dict(k)
    finally:
        j.finished_at = datetime.now().isoformat(timespec="seconds")
        shutil.rmtree(root, ignore_errors=True)
        _parsed.pop(j.id, None)
        _digest_cache.pop(j.id, None)


def message(k: dict) -> str:
    """Pixel's line after an import (real counts only)."""
    from .pixel import import_line
    return import_line(k)


def preview(job_id: str, fmt: str | None = None) -> dict:
    p = plan(job_id, fmt)
    p.pop("_matches")
    p["job"] = get(job_id).out()
    return p


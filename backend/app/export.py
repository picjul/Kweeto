"""Exports of the open project's annotations: COCO, YOLO, Pascal VOC, CSV and PNG masks, as one zip.

Boxes are what you confirmed. Masks are NOT hand-drawn: they are drawn by the segmenter inside each
confirmed box (cached in `box_masks`), with the box itself as a fallback when the segmenter finds nothing
coherent; the README inside the zip says how many came from each source.

Coordinates refer to the image as Kweeto shows it (EXIF orientation applied): images with an EXIF
rotation are re-encoded upright in the export so every tool sees the same pixels as the annotations.
Runs in a background thread with progress; the zip lands in <project>/exports/.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import random
import re
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from xml.sax.saxutils import escape

import numpy as np
from PIL import Image, ImageDraw, ImageOps
from sqlalchemy import select

from . import db, embedder, geometry, profiles, segmenter, workspace
from .engine import iou
from .models import Box, BoxMask, ImageItem, LabelClass, Verification

log = logging.getLogger("kweeto.export")

FORMATS = {
    "coco": "COCO JSON (instances_<split>.json): boxes, plus instance polygons when masks are on",
    "yolo": "YOLO / Ultralytics: one .txt per image (class cx cy w h) + data.yaml; with masks also yolo-seg/",
    "voc": "Pascal VOC: one XML per image + ImageSets/Main split lists",
    "csv": "CSV: one row per box (pixels and normalised), images without boxes listed too",
    "masks": "PNG masks: semantic (pixel = class index) and instance (16-bit, pixel = instance id)",
}
NEEDS_MASKS = {"masks"}          # formats that only make sense with masks
USES_MASKS = {"coco", "yolo", "masks"}


@dataclass
class ExportOptions:
    formats: list[str]
    masks: bool = True
    images: bool = True
    scope: str = "annotated"     # annotated = boxed or verified images (empty verified ones = negatives) | boxed
    split: tuple[float, float, float] = (1.0, 0.0, 0.0)
    seed: int = 0


@dataclass
class Job:
    id: str
    project_id: str
    project_name: str
    options: dict
    status: str = "queued"       # queued | running | done | error | cancelled
    phase: str = "queued"        # masks | writing | done
    done: int = 0
    total: int = 0
    eta_s: int | None = None
    error: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    finished_at: str | None = None
    size: int = 0
    counts: dict = field(default_factory=dict)

    def out(self) -> dict:
        return asdict(self)


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def exports_dir() -> "os.PathLike":
    d = workspace.require().dir / "exports"
    d.mkdir(exist_ok=True)
    return d


def zip_path(job_id: str):
    return exports_dir() / f"{job_id}.zip"


def list_jobs() -> list[dict]:
    """Running jobs + finished exports of the open project (also those from previous sessions)."""
    pid = workspace.require().id
    out = {j.id: j.out() for j in _jobs.values() if j.project_id == pid}
    for meta in exports_dir().glob("*.json"):
        try:
            d = json.loads(meta.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("id") not in out and zip_path(d["id"]).exists():
            out[d["id"]] = d
    return sorted(out.values(), key=lambda d: d["created_at"], reverse=True)


def get(job_id: str) -> dict | None:
    return next((j for j in list_jobs() if j["id"] == job_id), None)


def delete(job_id: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{10}", job_id):
        return False
    j = _jobs.get(job_id)
    if j and j.status in ("queued", "running"):
        j.status = "cancelled"
        return True
    found = False
    for p in (zip_path(job_id), exports_dir() / f"{job_id}.json"):
        if p.exists():
            p.unlink()
            found = True
    _jobs.pop(job_id, None)
    return found


def candidates() -> dict:
    with db.SessionLocal() as s:
        boxed = set(s.scalars(select(Box.image_id)))
        verified = set(s.scalars(select(Verification.image_id)))
        return {"annotated": len(boxed | verified), "boxed": len(boxed),
                "boxes": len(list(s.scalars(select(Box.id)))),
                "cached_masks": len(list(s.scalars(select(BoxMask.box_id))))}


def start(opts: ExportOptions) -> Job:
    bad = [f for f in opts.formats if f not in FORMATS]
    if bad or not opts.formats:
        raise ValueError(f"Unknown or no formats: {bad or opts.formats}")
    if any(f in NEEDS_MASKS for f in opts.formats) and not opts.masks:
        raise ValueError("PNG masks need masks turned on")
    if sum(opts.split) <= 0 or min(opts.split) < 0:
        raise ValueError("Invalid split")
    p = workspace.require()
    with _lock:
        if any(j.status in ("queued", "running") for j in _jobs.values()):
            raise RuntimeError("An export is already running")
        job = Job(id=uuid.uuid4().hex[:10], project_id=p.id, project_name=p.name, options=asdict(opts))
        _jobs[job.id] = job
    threading.Thread(target=_run_safe, args=(job, opts), daemon=True, name=f"export-{job.id}").start()
    return job


# ---------- the work ----------

class _Cancelled(Exception):
    pass


def _check(job: Job) -> None:
    if job.status == "cancelled" or workspace.current is None or workspace.current.id != job.project_id:
        raise _Cancelled()


def _run_safe(job: Job, opts: ExportOptions) -> None:
    job.status = "running"
    try:
        _run(job, opts)
        job.status, job.phase = "done", "done"
    except _Cancelled:
        job.status = "cancelled"
    except Exception as e:  # pragma: no cover - reported to the UI
        log.exception("export failed")
        job.status, job.error = "error", str(e)[:500]
    job.finished_at = datetime.now().isoformat(timespec="seconds")
    if job.status == "done":
        try:
            (exports_dir() / f"{job.id}.json").write_text(json.dumps(job.out(), indent=2), encoding="utf-8")
        except Exception:  # pragma: no cover
            pass


def _mask_signature(b) -> str:
    return f"{segmenter.mask_signature()}|{b.x:.4f},{b.y:.4f},{b.w:.4f},{b.h:.4f}"


def _compute_mask(path, pil, b) -> tuple[list, float, str]:
    """Mask of one box, clipped to the box; falls back to the box when the segmenter disagrees with it."""
    box = (b.x, b.y, b.w, b.h)
    try:
        mask, _score = segmenter.mask_in_box(str(path), pil, box)
    except Exception:  # pragma: no cover - segmenter unavailable
        mask = None
    if mask is not None:
        h, w = mask.shape
        clip = np.zeros_like(mask)
        x0, y0 = max(0, int(b.x * w)), max(0, int(b.y * h))
        x1, y1 = min(w, int(np.ceil((b.x + b.w) * w))), min(h, int(np.ceil((b.y + b.h) * h)))
        clip[y0:y1, x0:x1] = True
        mask = mask & clip
        mb = segmenter.mask_to_box(mask)
        if mb is not None and iou(mb, box) >= 0.5:
            polys = geometry.mask_polygons(mask)
            if polys:
                return polys, float(mask.mean()), "segmenter"
    return [geometry.box_polygon(box)], b.w * b.h, "box"


def _ensure_masks(job: Job, images: list, boxes_by_img: dict) -> dict[int, BoxMask]:
    with db.SessionLocal() as s:
        cached = {m.box_id: m for m in s.scalars(select(BoxMask))}
    todo = [i for i in images if any(cached.get(b.id) is None or cached[b.id].signature != _mask_signature(b)
                                     for b in boxes_by_img.get(i.id, []))]
    job.phase, job.done, job.total = "masks", 0, len(todo)
    t0 = time.time()
    for img in todo:
        _check(job)
        path = workspace.images_dir() / img.stored_name
        pil = embedder.load_image(path)
        with db.SessionLocal() as s:
            for b in boxes_by_img[img.id]:
                sig = _mask_signature(b)
                if b.id in cached and cached[b.id].signature == sig:
                    continue
                polys, area, source = _compute_mask(path, pil, b)
                row = s.get(BoxMask, b.id) or BoxMask(box_id=b.id)
                row.signature, row.polygons, row.area, row.source = sig, [[list(p) for p in poly] for poly in polys], area, source
                s.add(row)
                cached[b.id] = row
            s.commit()
        job.done += 1
        rate = (time.time() - t0) / job.done
        job.eta_s = round(rate * (job.total - job.done))
    job.eta_s = None
    return cached


def _unique_names(images: list) -> dict[int, str]:
    used: set[str] = set()
    out = {}
    for img in images:
        base = os.path.basename(img.filename) or img.stored_name
        stem, ext = os.path.splitext(base)
        stem = re.sub(r"[^\w\-. ]+", "_", stem).strip() or "image"
        ext = ext.lower() or os.path.splitext(img.stored_name)[1]
        name, k = f"{stem}{ext}", 2
        while name.lower() in used:
            name, k = f"{stem}_{k}{ext}", k + 1
        used.add(name.lower())
        out[img.id] = name
    return out


def _image_bytes(img) -> bytes:
    """The file as stored, or re-encoded upright if it carries an EXIF rotation."""
    path = workspace.images_dir() / img.stored_name
    data = path.read_bytes()
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.getexif().get(0x0112, 1) in (1, None):
                return data
            fixed = ImageOps.exif_transpose(im).convert("RGB")
        buf = io.BytesIO()
        fixed.save(buf, "JPEG" if path.suffix.lower() in (".jpg", ".jpeg") else "PNG", quality=95)
        return buf.getvalue()
    except Exception:  # pragma: no cover
        return data


def _splits(images: list, ratios: tuple, seed: int) -> dict[int, str]:
    ids = [i.id for i in images]
    random.Random(seed).shuffle(ids)
    total = sum(ratios)
    n = len(ids)
    n_train = round(n * ratios[0] / total)
    n_val = round(n * ratios[1] / total) if ratios[1] else 0
    if ratios[2] == 0:
        n_val = n - n_train
    out = {}
    for k, iid in enumerate(ids):
        out[iid] = "train" if k < n_train else "val" if k < n_train + n_val else "test"
    return out


def _run(job: Job, opts: ExportOptions) -> None:
    _check(job)
    with db.SessionLocal() as s:
        classes = list(s.scalars(select(LabelClass).order_by(LabelClass.id)))
        boxes = list(s.scalars(select(Box).order_by(Box.image_id, Box.id)))
        verified = set(s.scalars(select(Verification.image_id)))
        boxed = {b.image_id for b in boxes}
        wanted = boxed | verified if opts.scope == "annotated" else boxed
        images = list(s.scalars(select(ImageItem).where(ImageItem.id.in_(wanted)).order_by(ImageItem.id)))
    boxes_by_img: dict[int, list] = defaultdict(list)
    for b in boxes:
        boxes_by_img[b.image_id].append(b)
    cls_index = {c.id: k for k, c in enumerate(classes)}   # YOLO 0.., semantic PNG = k + 1, COCO = k + 1
    masks = _ensure_masks(job, images, boxes_by_img) if opts.masks and any(f in USES_MASKS for f in opts.formats) else {}

    _check(job)
    job.phase, job.done, job.total = "writing", 0, len(images)
    names = _unique_names(images)
    split_of = _splits(images, opts.split, opts.seed)
    used_splits = [sp for sp in ("train", "val", "test") if sp in split_of.values()]
    fmts = set(opts.formats)
    counts = {"images": len(images), "boxes": sum(len(boxes_by_img[i.id]) for i in images), "classes": len(classes),
              "negatives": sum(1 for i in images if not boxes_by_img[i.id]),
              "splits": {sp: sum(1 for v in split_of.values() if v == sp) for sp in used_splits},
              "masks_segmenter": 0, "masks_box_fallback": 0}

    coco: dict[str, dict] = {sp: {"images": [], "annotations": []} for sp in used_splits}
    csv_rows: list[list] = []
    ann_id = 1
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip", dir=exports_dir())
    tmp.close()
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
            def put_image(folder: str, img, data: bytes):
                z.writestr(zipfile.ZipInfo(f"{folder}/{names[img.id]}", date_time=time.localtime()[:6]), data,
                           compress_type=zipfile.ZIP_STORED)

            for img in images:
                _check(job)
                sp = split_of[img.id]
                W, H = img.width, img.height
                stem = os.path.splitext(names[img.id])[0]
                bxs = boxes_by_img[img.id]
                data = _image_bytes(img) if opts.images else b""
                polys_of = {b.id: (masks[b.id].polygons if b.id in masks else None) for b in bxs}
                for b in bxs:
                    if b.id in masks:
                        counts["masks_segmenter" if masks[b.id].source == "segmenter" else "masks_box_fallback"] += 1

                if "coco" in fmts:
                    cimg = len(coco[sp]["images"]) + 1
                    coco[sp]["images"].append({"id": cimg, "file_name": names[img.id], "width": W, "height": H})
                    for b in bxs:
                        a = {"id": ann_id, "image_id": cimg, "category_id": cls_index[b.class_id] + 1, "iscrowd": 0,
                             "bbox": [round(b.x * W, 2), round(b.y * H, 2), round(b.w * W, 2), round(b.h * H, 2)],
                             "area": round(b.w * W * b.h * H, 2), "segmentation": []}
                        if polys_of[b.id]:
                            a["segmentation"] = [[round(v, 2) for x, y in poly for v in (x * W, y * H)] for poly in polys_of[b.id]]
                            a["area"] = round(sum(geometry.polygon_area(poly, W, H) for poly in polys_of[b.id]), 2)
                        coco[sp]["annotations"].append(a)
                        ann_id += 1
                    if opts.images:
                        put_image(f"coco/images/{sp}", img, data)

                if "yolo" in fmts:
                    det = [f"{cls_index[b.class_id]} {b.x + b.w / 2:.6f} {b.y + b.h / 2:.6f} {b.w:.6f} {b.h:.6f}" for b in bxs]
                    z.writestr(f"yolo/labels/{sp}/{stem}.txt", "\n".join(det) + ("\n" if det else ""))
                    if opts.images:
                        put_image(f"yolo/images/{sp}", img, data)
                    if masks:
                        seg = []
                        for b in bxs:
                            poly = max(polys_of[b.id] or [geometry.box_polygon((b.x, b.y, b.w, b.h))],
                                       key=lambda p: geometry.polygon_area(p))
                            seg.append(f"{cls_index[b.class_id]} " + " ".join(f"{x:.6f} {y:.6f}" for x, y in poly))
                        z.writestr(f"yolo-seg/labels/{sp}/{stem}.txt", "\n".join(seg) + ("\n" if seg else ""))
                        if opts.images:
                            put_image(f"yolo-seg/images/{sp}", img, data)

                if "voc" in fmts:
                    objs = "".join(
                        f"<object><name>{escape(next(c.name for c in classes if c.id == b.class_id))}</name><pose>Unspecified</pose>"
                        f"<truncated>0</truncated><difficult>0</difficult><bndbox><xmin>{max(1, round(b.x * W) + 1)}</xmin>"
                        f"<ymin>{max(1, round(b.y * H) + 1)}</ymin><xmax>{min(W, round((b.x + b.w) * W))}</xmax>"
                        f"<ymax>{min(H, round((b.y + b.h) * H))}</ymax></bndbox></object>" for b in bxs)
                    z.writestr(f"voc/Annotations/{stem}.xml",
                               f"<annotation><folder>JPEGImages</folder><filename>{escape(names[img.id])}</filename>"
                               f"<source><database>Kweeto</database></source><size><width>{W}</width><height>{H}</height>"
                               f"<depth>3</depth></size><segmented>0</segmented>{objs}</annotation>\n")
                    if opts.images:
                        put_image("voc/JPEGImages", img, data)

                if "csv" in fmts:
                    if not bxs:
                        csv_rows.append([sp, names[img.id], W, H, "", "", "", "", "", "", "", "", "", ""])
                    for b in bxs:
                        csv_rows.append([sp, names[img.id], W, H, next(c.name for c in classes if c.id == b.class_id),
                                         round(b.x * W), round(b.y * H), round((b.x + b.w) * W), round((b.y + b.h) * H),
                                         f"{b.x + b.w / 2:.6f}", f"{b.y + b.h / 2:.6f}", f"{b.w:.6f}", f"{b.h:.6f}",
                                         masks[b.id].source if b.id in masks else ""])

                if "masks" in fmts:
                    sem = Image.new("L", (W, H), 0)
                    inst = Image.new("I", (W, H), 0)
                    ds, di = ImageDraw.Draw(sem), ImageDraw.Draw(inst)
                    order = sorted(enumerate(bxs, start=1), key=lambda t: -t[1].w * t[1].h)  # small ones on top
                    for k, b in order:
                        for poly in polys_of[b.id] or [geometry.box_polygon((b.x, b.y, b.w, b.h))]:
                            pts = [(x * W, y * H) for x, y in poly]
                            ds.polygon(pts, fill=cls_index[b.class_id] + 1)
                            di.polygon(pts, fill=k)
                    for folder, im in (("semantic", sem), ("instance", Image.fromarray(np.asarray(inst, np.uint16)))):
                        buf = io.BytesIO()
                        im.save(buf, "PNG")
                        z.writestr(f"masks/{folder}/{sp}/{stem}.png", buf.getvalue())
                job.done += 1

            # per-format index files
            cats = [{"id": k + 1, "name": c.name, "supercategory": "object"} for k, c in enumerate(classes)]
            if "coco" in fmts:
                for sp in used_splits:
                    z.writestr(f"coco/annotations/instances_{sp}.json", json.dumps({
                        "info": {"description": f"{job.project_name} (Kweeto export)", "version": "1.0",
                                 "date_created": job.created_at, "contributor": "Kweeto"},
                        "licenses": [], "categories": cats, **coco[sp]}))
            names_yaml = "\n".join(f"  {k}: {json.dumps(c.name)}" for k, c in enumerate(classes))
            for folder in (["yolo"] if "yolo" in fmts else []) + (["yolo-seg"] if "yolo" in fmts and masks else []):
                val = "val" if "val" in used_splits else "train"
                z.writestr(f"{folder}/data.yaml",
                           f"# {job.project_name}: Kweeto export ({'segmentation' if folder == 'yolo-seg' else 'detection'})\n"
                           f"path: .\ntrain: images/train\nval: images/{val}\n"
                           + ("test: images/test\n" if "test" in used_splits else "") + f"names:\n{names_yaml}\n")
            if "voc" in fmts:
                z.writestr("voc/labels.txt", "\n".join(c.name for c in classes) + "\n")
                for sp in used_splits:
                    stems = [os.path.splitext(names[i.id])[0] for i in images if split_of[i.id] == sp]
                    z.writestr(f"voc/ImageSets/Main/{sp}.txt", "\n".join(stems) + "\n")
            if "csv" in fmts:
                buf = io.StringIO()
                w = csv.writer(buf)
                w.writerow(["split", "filename", "width", "height", "class", "xmin", "ymin", "xmax", "ymax",
                            "x_center", "y_center", "box_width", "box_height", "mask_source"])
                w.writerows(csv_rows)
                z.writestr("csv/annotations.csv", buf.getvalue())
            if "masks" in fmts:
                z.writestr("masks/classes.csv", "value,class\n0,background\n"
                           + "".join(f"{k + 1},{c.name}\n" for k, c in enumerate(classes)))
            z.writestr("README.txt", _readme(job, opts, classes, counts))
        _check(job)
        shutil.move(tmp.name, zip_path(job.id))
    finally:
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)
    job.counts = counts
    job.size = os.path.getsize(zip_path(job.id))


def _readme(job: Job, opts: ExportOptions, classes, counts) -> str:
    lines = [
        f"{job.project_name}: annotations exported by Kweeto on {job.created_at}",
        "",
        f"Images: {counts['images']} ({counts['negatives']} without objects, kept as negatives)",
        f"Boxes:  {counts['boxes']} (all confirmed by a human)",
        "Splits: " + ", ".join(f"{k} {v}" for k, v in counts["splits"].items()),
        "Classes: " + ", ".join(f"{k}={c.name}" for k, c in enumerate(classes)) + "  (YOLO ids; COCO ids and mask values are +1)",
        "",
        "Folders: " + ", ".join(opts.formats + (["yolo-seg"] if "yolo" in opts.formats and opts.masks else [])),
        "Coordinates refer to the upright image (EXIF orientation applied; such images are re-encoded upright here).",
    ]
    if opts.masks:
        lines += [
            "",
            "MASKS ARE GENERATED, NOT HAND-DRAWN: the segmenter drew each mask inside a confirmed box",
            f"({profiles.active.segmenter} {profiles.active.sam_model if profiles.active.segmenter != 'simple' else ''}).",
            f"{counts['masks_segmenter']} masks come from the segmenter, {counts['masks_box_fallback']} fall back to the",
            "box rectangle (the segmenter found nothing coherent with the box). Holes are not represented.",
            "Review them before training a segmentation model.",
        ]
    return "\n".join(lines) + "\n"

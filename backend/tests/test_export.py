"""Exports: every format is produced, consistent with the boxes, and the masks follow the objects."""
import csv
import io
import json
import os
import tempfile
import time
import zipfile
from xml.etree import ElementTree

os.environ.setdefault("KWEETO_EMBEDDER", "pixels")
os.environ.setdefault("KWEETO_DATA_DIR", tempfile.mkdtemp(prefix="kweeto-test-"))

import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from app.geometry import mask_polygons  # noqa: E402
from app.main import app  # noqa: E402
from bench.scenes import make_scene  # noqa: E402


def _png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def test_polygons_follow_the_mask():
    im = Image.new("L", (200, 160), 0)
    ImageDraw.Draw(im).ellipse([30, 20, 150, 140], fill=1)
    m = np.asarray(im, bool)
    polys = mask_polygons(m)
    back = Image.new("L", (200, 160), 0)
    ImageDraw.Draw(back).polygon([(x * 200, y * 160) for x, y in polys[0]], fill=1)
    r = np.asarray(back, bool)
    assert len(polys) == 1 and (m & r).sum() / (m | r).sum() > 0.97


def test_export_all_formats():
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Export test"})
        scenes = [make_scene(50000 + i) for i in range(6)]
        blank = Image.new("RGB", (320, 240), (210, 205, 198))  # a verified image with no objects = a negative
        files = [("files", (s.name, s.png(), "image/png")) for s in scenes] + [("files", ("empty.png", _png(blank), "image/png"))]
        c.post("/api/images/upload", files=files)
        t0 = time.time()
        while time.time() - t0 < 60:
            st = c.get("/api/stats").json()
            if st["images"]["embedded"] >= 7 and not st["worker"]["running"]:
                break
            time.sleep(0.2)
        cls = {n: c.post("/api/classes", json={"name": n}).json()["id"] for n in ("tomato", "lime", "pipe")}
        by_name = {i["filename"]: i for i in c.get("/api/images").json()["items"]}
        n_boxes = 0
        for s in scenes:
            boxes = [{"class_id": cls[o.cls], "x": o.box[0], "y": o.box[1], "w": o.box[2], "h": o.box[3]} for o in s.objects]
            n_boxes += len(boxes)
            c.put(f"/api/images/{by_name[s.name]['id']}/annotations", json={"boxes": boxes, "rejected": [], "done": True})
        c.put(f"/api/images/{by_name['empty.png']['id']}/annotations", json={"boxes": [], "rejected": [], "done": True})

        info = c.get("/api/exports").json()
        assert info["candidates"]["annotated"] == 7 and info["candidates"]["boxes"] == n_boxes
        assert c.post("/api/exports", json={"formats": ["nope"]}).status_code == 400
        job = c.post("/api/exports", json={"formats": ["coco", "yolo", "voc", "csv", "masks"], "masks": True,
                                           "images": True, "train": 0.7, "val": 0.3}).json()
        t0 = time.time()
        while time.time() - t0 < 120:
            j = c.get(f"/api/exports/{job['id']}").json()
            if j["status"] in ("done", "error"):
                break
            time.sleep(0.2)
        assert j["status"] == "done", j.get("error")
        assert j["counts"]["boxes"] == n_boxes and j["counts"]["negatives"] == 1
        print("mask sources:", j["counts"]["masks_segmenter"], "segmenter /", j["counts"]["masks_box_fallback"], "box")
        assert j["counts"]["masks_segmenter"] >= n_boxes * 0.7  # most masks really come from the segmenter

        r = c.get(f"/api/exports/{job['id']}/download")
        assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
        z = zipfile.ZipFile(io.BytesIO(r.content))
        names = z.namelist()

        # COCO: every box once, polygons inside the box, categories 1..N
        anns, imgs = [], []
        for sp in ("train", "val"):
            d = json.loads(z.read(f"coco/annotations/instances_{sp}.json"))
            assert [k["id"] for k in d["categories"]] == [1, 2, 3]
            anns += d["annotations"]
            imgs += d["images"]
            assert all(f"coco/images/{sp}/{i['file_name']}" in names for i in d["images"])
        assert len(anns) == n_boxes and len(imgs) == 7
        for a in anns:
            x, y, w, h = a["bbox"]
            seg = a["segmentation"][0]
            xs, ys = seg[0::2], seg[1::2]
            assert min(xs) >= x - 1 and max(xs) <= x + w + 1 and min(ys) >= y - 1 and max(ys) <= y + h + 1
            assert 0 < a["area"] <= w * h + 1

        # YOLO: one label file per image (empty for the negative), normalised values, data.yaml
        labels = [n for n in names if n.startswith("yolo/labels/")]
        assert len(labels) == 7
        lines = [ln for n in labels for ln in z.read(n).decode().splitlines()]
        assert len(lines) == n_boxes and all(0 <= float(v) <= 1 for ln in lines for v in ln.split()[1:])
        assert "names:" in z.read("yolo/data.yaml").decode() and "yolo-seg/data.yaml" in names
        seg_lines = [ln for n in names if n.startswith("yolo-seg/labels/") for ln in z.read(n).decode().splitlines()]
        assert len(seg_lines) == n_boxes and all(len(ln.split()) >= 7 for ln in seg_lines)

        # Pascal VOC: one XML per image, objects match
        xmls = [n for n in names if n.startswith("voc/Annotations/")]
        assert len(xmls) == 7
        assert sum(len(ElementTree.fromstring(z.read(n)).findall("object")) for n in xmls) == n_boxes

        # CSV: one row per box + one for the negative image
        rows = list(csv.DictReader(io.StringIO(z.read("csv/annotations.csv").decode())))
        assert len(rows) == n_boxes + 1 and sum(1 for r_ in rows if not r_["class"]) == 1

        # PNG masks: same size as the image, class values within range
        sem = [n for n in names if n.startswith("masks/semantic/")]
        assert len(sem) == 7
        some = np.asarray(Image.open(io.BytesIO(z.read(sem[0]))))
        assert some.shape == (240, 320) and some.max() <= 3
        assert "MASKS ARE GENERATED" in z.read("README.txt").decode()

        # a second export reuses the cached masks; deleting removes the file
        assert c.get("/api/exports").json()["candidates"]["cached_masks"] == n_boxes
        assert c.delete(f"/api/exports/{job['id']}").status_code == 200
        assert c.get(f"/api/exports/{job['id']}/download").status_code == 404

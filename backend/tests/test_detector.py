"""Detector training (LibreYOLO): the dataset is built only from finished images, correctly; the API guards its inputs.

A real training run (downloads LibreYOLO9t weights, trains 2 epochs on the CPU, exports ONNX) is opt-in:
KWEETO_TEST_MODELS=1.
"""
import os
import tempfile
import time
from pathlib import Path

import pytest

os.environ.setdefault("KWEETO_EMBEDDER", "pixels")
os.environ.setdefault("KWEETO_DATA_DIR", tempfile.mkdtemp(prefix="kweeto-test-"))

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app import db, detector  # noqa: E402
from app.main import app  # noqa: E402
from bench.scenes import make_scene  # noqa: E402


def _project(c, name: str, finished: int, unfinished: int = 0, blank: bool = False) -> dict:
    """A project with `finished` annotated + verified scenes, `unfinished` annotated but not finished ones."""
    import io

    c.post("/api/projects", json={"name": name})
    scenes = [make_scene(70000 + i) for i in range(finished + unfinished)]
    files = [("files", (s.name, s.png(), "image/png")) for s in scenes]
    if blank:
        buf = io.BytesIO()
        Image.new("RGB", (320, 240), (210, 205, 198)).save(buf, "PNG")
        files.append(("files", ("empty.png", buf.getvalue(), "image/png")))
    c.post("/api/images/upload", files=files)
    t0 = time.time()
    while time.time() - t0 < 60:
        st = c.get("/api/stats").json()
        if st["images"]["embedded"] >= len(files) and not st["worker"]["running"]:
            break
        time.sleep(0.2)
    cls = {n: c.post("/api/classes", json={"name": n}).json()["id"] for n in ("tomato", "lime", "pipe")}
    by_name = {i["filename"]: i for i in c.get("/api/images", params={"limit": 500}).json()["items"]}
    boxes_done = 0
    for k, s in enumerate(scenes):
        boxes = [{"class_id": cls[o.cls], "x": o.box[0], "y": o.box[1], "w": o.box[2], "h": o.box[3]} for o in s.objects]
        done = k < finished
        boxes_done += len(boxes) if done else 0
        c.put(f"/api/images/{by_name[s.name]['id']}/annotations", json={"boxes": boxes, "rejected": [], "done": done})
    if blank:
        c.put(f"/api/images/{by_name['empty.png']['id']}/annotations", json={"boxes": [], "rejected": [], "done": True})
    return {"boxes": boxes_done}


def test_dataset_uses_only_finished_images(tmp_path: Path):
    with TestClient(app) as c:
        info = _project(c, "Detector data", finished=12, unfinished=3, blank=True)
        ds = c.get("/api/training").json()["dataset"]
        assert ds["images"] == 13 and ds["background"] == 1          # 12 finished scenes + the finished blank one
        assert ds["boxes"] == info["boxes"] and ds["val"] == round(13 * detector.VAL_FRACTION)
        with db.SessionLocal() as s:
            summary = detector.build_dataset(s, tmp_path)
        assert summary["images"] == 13 and summary["train"] + summary["val"] == 13
        yaml = (tmp_path / "data.yaml").read_text(encoding="utf-8")
        assert "nc: 3" in yaml and "train: images/train" in yaml
        labels = list((tmp_path / "labels").rglob("*.txt"))
        images = list((tmp_path / "images").rglob("*.*"))
        assert len(labels) == len(images) == 13
        rows = [r.split() for p in labels for r in p.read_text().splitlines() if r.strip()]
        assert len(rows) == info["boxes"]
        assert all(0 <= int(r[0]) < 3 and all(0.0 <= float(v) <= 1.0 for v in r[1:]) for r in rows)
        assert sum(1 for p in labels if not p.read_text().strip()) == 1  # the blank image: background


def test_training_needs_enough_finished_images():
    with TestClient(app) as c:
        _project(c, "Too few", finished=3)
        ds = c.get("/api/training").json()["dataset"]
        assert not ds["ready"] and any("at least" in r for r in ds["reasons"])
        assert c.post("/api/training", json={"model": "yolo9-t", "epochs": 1}).status_code == 400
        assert c.post("/api/training", json={"model": "nope", "epochs": 1}).status_code == 400
        assert c.get("/api/training/../../etc").status_code == 404


def test_no_active_detector_by_default():
    with TestClient(app) as c:
        _project(c, "No detector", finished=2)
        assert c.get("/api/training").json()["active"] is None
        img = c.get("/api/images").json()["items"][0]["id"]
        assert c.get(f"/api/images/{img}/detector").json() == {"run": None, "boxes": []}
        assert c.post("/api/training/nope/activate").status_code == 404
        assert c.post("/api/training/deactivate").json() == {"active": None}


@pytest.mark.skipif(os.getenv("KWEETO_TEST_MODELS") != "1", reason="downloads weights and trains (KWEETO_TEST_MODELS=1)")
def test_real_training_run():
    with TestClient(app) as c:
        _project(c, "Real training", finished=12)
        run = c.post("/api/training", json={"model": "yolo9-t", "epochs": 2, "imgsz": 160, "patience": 0}).json()
        t0 = time.time()
        while time.time() - t0 < 600:
            r = c.get(f"/api/training/{run['id']}").json()
            if r["state"] not in ("preparing", "running"):
                break
            time.sleep(2)
        assert r["state"] == "done", r.get("error")
        assert r["has_model"] and r["has_onnx"] and len(r["history"]) == 2
        assert c.get(f"/api/training/{run['id']}/download", params={"format": "onnx"}).status_code == 200
        assert c.post(f"/api/training/{run['id']}/activate").json() == {"active": run["id"]}
        img = c.get("/api/images").json()["items"][0]["id"]
        view = c.get(f"/api/images/{img}/detector").json()
        assert view["run"] == run["id"] and isinstance(view["boxes"], list)

"""Import of existing datasets, dataset health (label errors, duplicates) and the lesson recap."""
import io
import json
import os
import tempfile
import time
import zipfile

os.environ.setdefault("KWEETO_EMBEDDER", "pixels")
os.environ.setdefault("KWEETO_DATA_DIR", tempfile.mkdtemp(prefix="kweeto-test-"))

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app import importer  # noqa: E402
from app.main import app  # noqa: E402
from bench.scenes import make_scene  # noqa: E402

CLASSES = ["tomato", "lime", "pipe"]


def _wait(c, timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = c.get("/api/stats").json()
        if s["images"]["pending"] == 0 and not s["worker"]["running"]:
            time.sleep(0.3)
            s = c.get("/api/stats").json()
            if s["images"]["pending"] == 0 and not s["worker"]["running"]:
                return s
        time.sleep(0.2)
    raise AssertionError("the worker did not finish")


def _coco(scenes, wrong: dict | None = None) -> bytes:
    wrong = wrong or {}
    images, anns = [], []
    for i, s in enumerate(scenes):
        images.append({"id": i + 1, "file_name": f"train/{s.name}", "width": 320, "height": 240})
        for j, o in enumerate(s.objects):
            name = wrong.get((i, j), o.cls)
            x, y, w, h = o.box
            anns.append({"id": len(anns) + 1, "image_id": i + 1, "category_id": CLASSES.index(name) + 1,
                         "bbox": [x * 320, y * 240, w * 320, h * 240], "iscrowd": 0})
    return json.dumps({"images": images, "annotations": anns,
                       "categories": [{"id": k + 1, "name": n} for k, n in enumerate(CLASSES)]}).encode()


def _zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, b in files.items():
            z.writestr(n, b)
    return buf.getvalue()


def _import(c, files: list[tuple[str, bytes]], **commit) -> dict:
    job = c.post("/api/imports").json()
    r = c.post(f"/api/imports/{job['id']}/files", files=[("files", (n, b, "application/octet-stream")) for n, b in files])
    assert r.status_code == 200, r.text
    prev = c.get(f"/api/imports/{job['id']}/preview").json()
    r = c.post(f"/api/imports/{job['id']}/commit", json=commit)
    assert r.status_code == 200, r.text
    t0 = time.time()
    while time.time() - t0 < 60:
        j = c.get(f"/api/imports/{job['id']}").json()
        if j["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert j["status"] == "done", j.get("error")
    return {"preview": prev, "job": j}


def test_parsers_and_orientation(tmp_path):
    # YOLO + names, VOC, CVAT, Label Studio (full, with a rotation-free rectangle) on one image 200x100
    lab = importer._yolo_label("0 0.5 0.5 0.2 0.4\n1 0.1 0.1 0.3 0.1 0.3 0.3\n")
    assert [tuple(round(v, 6) for v in r) for r in lab] == [(0, 0.4, 0.3, 0.2, 0.4), (1, 0.1, 0.1, 0.2, 0.2)]
    assert importer._yolo_label("images/train/a.jpg\n") is None
    assert importer._mini_yaml_names("path: x\nnames:\n  0: bolt\n  1: nut\n") == {0: "bolt", 1: "nut"}
    assert importer._mini_yaml_names("names: [bolt, 'nut']") == ["bolt", "nut"]
    from xml.etree import ElementTree
    voc = ElementTree.fromstring("<annotation><filename>a.jpg</filename><size><width>200</width><height>100</height></size>"
                                 "<object><name>bolt</name><bndbox><xmin>21</xmin><ymin>11</ymin><xmax>60</xmax>"
                                 "<ymax>50</ymax></bndbox></object></annotation>")
    r = importer._parse_voc(voc, "a.xml")
    assert r.boxes == [("bolt", 20.0, 10.0, 40.0, 40.0)] and r.size == (200, 100)
    cvat = ElementTree.fromstring('<annotations><image id="0" name="dir/a.jpg" width="200" height="100">'
                                  '<box label="bolt" xtl="20" ytl="10" xbr="60" ybr="50"/>'
                                  '<polygon label="nut" points="100,10;140,10;120,40"/></image></annotations>')
    rs = importer._parse_cvat(cvat, [], "x.xml")
    assert rs[0].boxes == [("bolt", 20.0, 10.0, 40.0, 40.0), ("nut", 100.0, 10.0, 40.0, 30.0)]
    ls = [{"data": {"image": "/data/upload/1/0a1b2c3d-a.jpg"}, "annotations": [{"result": [
        {"type": "rectanglelabels", "original_width": 200, "original_height": 100,
         "value": {"x": 10, "y": 10, "width": 20, "height": 40, "rectanglelabels": ["bolt"]}}]}]},
          {"data": {"image": "b.jpg"}, "annotations": []}]
    assert importer._is_labelstudio(ls)
    warn: list = []
    rs = importer._parse_labelstudio(ls, warn, "ls.json")
    assert len(rs) == 1 and rs[0].boxes == [("bolt", 0.1, 0.1, 0.2, 0.4)] and warn
    assert importer._ref_names("/data/upload/1/0a1b2c3d-a.jpg")[1] == ["0a1b2c3d-a.jpg", "a.jpg"]
    # a box drawn on the raw pixels of a photo stored rotated (EXIF 6) lands on the upright image
    rec = importer.Rec(ref="a.jpg", boxes=[("bolt", 20, 10, 40, 30)], units="px", size=(200, 100))
    (g,), _ = importer.normalise(rec, (100, 200), ((200, 100), 6))
    assert [round(v, 3) for v in g[1:]] == [0.6, 0.1, 0.3, 0.2]


def test_import_coco_then_health_and_recap():
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Import test"})
        scenes = [make_scene(9000 + i) for i in range(12)]  # 23 tomatoes, 11 limes, 5 pipes
        extra = [make_scene(9100 + i) for i in range(4)]  # images without labels: still to teach
        # one deliberate label error: a lime called tomato (image 0's first lime, if any)
        i, j = next((i, j) for i, s in enumerate(scenes) for j, o in enumerate(s.objects) if o.cls == "lime")
        wrong = {(i, j): "tomato"}
        z = _zip({"instances_train.json": _coco(scenes, wrong),
                  **{f"train/{s.name}": s.png() for s in scenes}, **{f"unlabelled/{s.name}": s.png() for s in extra}})
        n_boxes = sum(len(s.objects) for s in scenes)
        res = _import(c, [("dataset.zip", z)])
        p = res["preview"]
        assert p["format"] == "coco" and p["annotated"] == 12 and p["boxes"] == n_boxes and p["unlabelled"] == 4
        assert {k["name"] for k in p["classes"]} <= set(CLASSES) and p["missing"] == 0
        assert res["job"]["counts"]["boxes"] == n_boxes and res["job"]["counts"]["finished"] == 12
        assert "boxes" in res["job"]["message"]

        st = _wait(c)
        assert st["boxes"] == n_boxes and st["verified"] == 12
        assert st["images"]["annotated"] == 12 and st["images"]["embedded"] == 4
        assert st["proposals"] > 0  # Pixel starts already taught: guesses on the unlabelled images
        boxes = [b for i in c.get("/api/images", params={"limit": 100}).json()["items"] if i["box_count"]
                 for b in c.get(f"/api/images/{i['id']}").json()["boxes"]]
        assert boxes and all(b["source"] == "import" for b in boxes)

        # importing the same files again changes nothing: same images, their boxes are kept
        again = _import(c, [("dataset.zip", z)])
        assert again["job"]["counts"].get("boxes", 0) == 0 and again["job"]["counts"]["kept_yours"] == 12
        assert again["preview"]["boxes"] == 0 and again["preview"]["already_here"] == 16  # the preview said so too

        # health: the mislabelled lime is among the look-alikes, and fixing it is a correction
        h = c.get("/api/dataset-health").json()
        cls = {k["name"]: k["id"] for k in h["classes"]}
        assert sum(k["boxes"] for k in h["classes"]) == n_boxes
        looks = [s for s in h["suspects"] if s["kind"] == "looks_like"]
        hit = [s for s in looks if s["class_id"] == cls["tomato"] and s["suggest_class_id"] == cls["lime"]]
        assert len(hit) == 1 and len(looks) <= 2, [s["text"] for s in looks]
        assert "lime" in hit[0]["text"] and hit[0]["like"]
        r = c.patch(f"/api/boxes/{hit[0]['box_id']}", json={"class_id": cls["lime"]}).json()
        assert "lime" in r["message"]
        h2 = c.get("/api/dataset-health").json()
        assert not [s for s in h2["suspects"] if s["box_id"] == hit[0]["box_id"] and s["kind"] == "looks_like"]
        if h["suspects"]:
            key = h["suspects"][-1]["key"]
            assert c.post("/api/dataset-health/dismiss", json={"key": key}).status_code == 200
            assert key not in {s["key"] for s in c.get("/api/dataset-health").json()["suspects"]}

        # recap: a session where the teacher accepts Pixel's guesses on the unlabelled images
        sid = c.post("/api/sessions").json()["id"]
        assert c.post("/api/sessions", params={"resume": sid}).json()["id"] == sid
        todo = [i for i in c.get("/api/images", params={"status": "embedded"}).json()["items"]]
        d = c.get(f"/api/images/{todo[0]['id']}").json()
        body = {"boxes": [{"class_id": q["class_id"], "x": q["x"], "y": q["y"], "w": q["w"], "h": q["h"],
                           "proposal_region_id": q["region_id"], "proposal_class_id": q["class_id"]} for q in d["proposals"]],
                "rejected": [], "done": True}
        c.put(f"/api/images/{todo[0]['id']}/annotations", json=body)
        r = c.post(f"/api/sessions/{sid}/end").json()
        assert r["finished"] == 1 and r["judged"] == len(d["proposals"]) and r["pixel_message"]
        assert r["snapshot_images"] == 4 and r["taught_from_snapshot"] == 1
        assert c.get(f"/api/sessions/{sid}").json() == r  # frozen once ended
        assert c.get("/api/sessions").json()[0]["id"] == sid


def test_import_yolo_voc_and_duplicates():
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "YOLO test"})
        scenes = [make_scene(72000 + i) for i in range(3)]
        files = [("data.yaml", b"names:\n  0: tomato\n  1: lime\n  2: pipe\n")]
        for s in scenes:
            files.append((f"ds/images/train/{s.name}", s.png()))
            lines = [f"{CLASSES.index(o.cls)} {o.box[0] + o.box[2] / 2} {o.box[1] + o.box[3] / 2} {o.box[2]} {o.box[3]}"
                     for o in s.objects]
            files.append((f"ds/labels/train/{s.name.rsplit('.', 1)[0]}.txt", "\n".join(lines).encode()))
        # a near-duplicate: the first scene resized and saved as JPEG
        im = Image.open(io.BytesIO(scenes[0].png())).convert("RGB").resize((300, 225))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=80)
        files.append(("ds/images/extra/copy.jpg", buf.getvalue()))
        res = _import(c, files)
        assert res["preview"]["format"] == "yolo"
        assert res["job"]["counts"]["boxes"] == sum(len(s.objects) for s in scenes)
        _wait(c)
        h = c.get("/api/dataset-health").json()
        names = [{i["filename"] for i in g} for g in h["duplicates"]]
        assert {scenes[0].name, "copy.jpg"} in names
        assert not any(scenes[1].name in g and scenes[2].name in g for g in names)  # different scenes are not duplicates
        # VOC on images already in the project (matched by file name): the boxes of existing images are kept
        voc = ("<annotation><filename>copy.jpg</filename><size><width>300</width><height>225</height></size>"
               "<object><name>tomato</name><bndbox><xmin>11</xmin><ymin>11</ymin><xmax>60</xmax><ymax>60</ymax>"
               "</bndbox></object></annotation>").encode()
        res = _import(c, [("copy.xml", voc)])
        assert res["preview"]["format"] == "voc" and res["preview"]["in_project"] == 1
        assert res["job"]["counts"]["boxes"] == 1


def test_roundtrip_from_a_kweeto_export():
    """An export zip (COCO + YOLO + VOC side by side) imports back into a new project with the same boxes."""
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Roundtrip A"})
        scenes = [make_scene(9200 + i) for i in range(4)]
        z = _zip({"instances.json": _coco(scenes), **{f"train/{s.name}": s.png() for s in scenes}})
        _import(c, [("d.zip", z)])
        _wait(c)
        before = sorted((round(b["x"], 3), round(b["y"], 3), round(b["w"], 3)) for i in c.get("/api/images").json()["items"]
                        for b in c.get(f"/api/images/{i['id']}").json()["boxes"])
        job = c.post("/api/exports", json={"formats": ["coco", "yolo", "voc"], "masks": False}).json()
        t0 = time.time()
        while c.get(f"/api/exports/{job['id']}").json()["status"] not in ("done", "error") and time.time() - t0 < 60:
            time.sleep(0.1)
        data = c.get(f"/api/exports/{job['id']}/download").content

        c.post("/api/projects", json={"name": "Roundtrip B"})
        res = _import(c, [("export.zip", data)])
        p = res["preview"]
        assert set(p["formats"]) == {"coco", "yolo", "voc"} and p["format"] == "coco"
        assert res["job"]["counts"]["images"] == 4 and res["job"]["counts"]["duplicates"] == 8  # same files, 3 folders
        _wait(c)
        after = sorted((round(b["x"], 3), round(b["y"], 3), round(b["w"], 3)) for i in c.get("/api/images").json()["items"]
                       for b in c.get(f"/api/images/{i['id']}").json()["boxes"])
        assert len(after) == len(before) and all(abs(a - b) < 0.004 for x, y in zip(after, before) for a, b in zip(x, y))


def test_liveness_needs_no_project():
    from app import __version__

    with TestClient(app) as c:
        r = c.get("/api/health")
        assert r.status_code == 200 and r.json()["status"] == "ok" and r.json()["version"] == __version__

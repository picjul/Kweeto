"""End-to-end test with the fake 'pixels' embedder (no torch) on synthetic images."""
import io
import os
import random
import tempfile
import time

os.environ["KWEETO_EMBEDDER"] = "pixels"
os.environ["KWEETO_DATA_DIR"] = tempfile.mkdtemp(prefix="kweeto-test-")

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from app.main import app  # noqa: E402


def _img(kind: str, seed: int) -> bytes:
    rnd = random.Random(seed)
    im = Image.new("RGB", (128, 128), (rnd.randint(110, 150),) * 3)
    d = ImageDraw.Draw(im)
    s = rnd.randint(60, 90)
    x, y = rnd.randint(0, 128 - s), rnd.randint(0, 128 - s)
    if kind == "red":
        d.rectangle([x, y, x + s, y + s], fill=(220, 30, 30))
    else:
        d.ellipse([x, y, x + s, y + s], fill=(30, 60, 220))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _wait_embedded(c, n, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = c.get("/api/stats").json()
        if s["images"]["embedded"] + s["images"]["annotated"] >= n and not s["worker"]["running"]:
            return s
        time.sleep(0.3)
    raise AssertionError("embedding did not complete")


def test_full_flow():
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "API test"})  # nothing is created by default
        files = [("files", (f"{k}_{i}.png", _img(k, i * 7 + (k == "red")), "image/png"))
                 for k in ("red", "blue") for i in range(25)]
        r = c.post("/api/images/upload", files=files).json()
        assert r["uploaded"] == 50
        # duplicate
        r2 = c.post("/api/images/upload", files=[files[0]]).json()
        assert r2["duplicates"] == 1
        _wait_embedded(c, 50)

        red = c.post("/api/classes", json={"name": "Red"}).json()
        blue = c.post("/api/classes", json={"name": "Blue"}).json()
        imgs = c.get("/api/images", params={"limit": 500}).json()["items"]
        truth = {i["id"]: (red["id"] if i["filename"].startswith("red") else blue["id"]) for i in imgs}

        # questions: few examples
        qs = c.get("/api/questions").json()["questions"]
        assert any(q["type"] == "few_examples" for q in qs)

        # teach 3 examples per class (box over the whole image)
        teach = ([i for i in imgs if truth[i["id"]] == red["id"]][:3]
                 + [i for i in imgs if truth[i["id"]] == blue["id"]][:3])
        for i in teach:
            res = c.put(f"/api/images/{i['id']}/annotations",
                        json={"boxes": [{"class_id": truth[i["id"]], "x": 0, "y": 0, "w": 1, "h": 1}],
                              "rejected": []}).json()
            assert "message" in res

        stats = c.get("/api/stats").json()
        assert stats["boxes"] == 6
        assert stats["proposals"] > 0

        # proposal accuracy on unannotated images
        correct = total = 0
        for i in c.get("/api/images", params={"status": "embedded", "limit": 500}).json()["items"]:
            d = c.get(f"/api/images/{i['id']}").json()
            if d["proposals"]:
                total += 1
                correct += d["proposals"][0]["class_id"] == truth[i["id"]]
        assert total > 20
        assert correct / total > 0.8

        # queue and similarity
        nxt = c.get("/api/queue/next", params={"position": 1}).json()
        assert nxt["image_id"] is not None
        sim = c.get(f"/api/images/{imgs[0]['id']}/similar", params={"k": 5}).json()
        assert len(sim) == 5

        # correction from a proposal: accept it while changing the class
        target = next(i for i in c.get("/api/images", params={"status": "embedded", "limit": 500}).json()["items"]
                      if c.get(f"/api/images/{i['id']}").json()["proposals"])
        d = c.get(f"/api/images/{target['id']}").json()
        p = d["proposals"][0]
        right = truth[target["id"]]
        res = c.put(f"/api/images/{target['id']}/annotations", json={
            "boxes": [{"class_id": right, "x": p["x"], "y": p["y"], "w": p["w"], "h": p["h"],
                       "proposal_region_id": p["region_id"], "proposal_class_id": p["class_id"]}],
            "rejected": [{"region_id": q["region_id"], "class_id": q["class_id"], "x": q["x"], "y": q["y"],
                          "w": q["w"], "h": q["h"]} for q in d["proposals"][1:]]}).json()
        assert "message" in res

        # Harvest: approve everything blindly -> controls must not become boxes
        boxes_before = c.get("/api/stats").json()["boxes"]
        batch = c.get("/api/batch").json()
        assert batch["groups"], "no groups in the harvest"
        items = [it for g in batch["groups"] for it in g["items"]]
        rev = c.post("/api/batch/review", json={"accept": [
            {"proposal_id": it["proposal_id"], "region_id": it["region_id"], "class_id": it["class_id"]}
            for it in items]}).json()
        n_controls = rev["controls_missed"]
        assert rev["accepted"] == len(items) - n_controls
        assert c.get("/api/stats").json()["boxes"] == boxes_before + rev["accepted"]

        # boxes confirmed through the harvest are almost all correct
        wrong = 0
        all_boxes = 0
        for i in c.get("/api/images", params={"status": "annotated", "limit": 500}).json()["items"]:
            for b in c.get(f"/api/images/{i['id']}").json()["boxes"]:
                all_boxes += 1
                wrong += b["class_id"] != truth[i["id"]]
        assert wrong / all_boxes < 0.15

        # click-to-box with the simple segmenter: click the centre of the drawn shape
        seg = c.post(f"/api/images/{imgs[0]['id']}/segment", json={"points": [[0.5, 0.5]], "box": None})
        assert seg.status_code == 200 and seg.json()["segmenter"] == "simple"

        # settings and reset (the probe is trained once there are >= 2 classes with examples)
        st = c.get("/api/settings").json()
        assert "effective" in st
        assert st["effective"]["probe"] is None or st["effective"]["probe"]["classes"] >= 2
        off = c.put("/api/settings", json={"use_probe": False}).json()
        assert off["settings"]["use_probe"] is False and off["effective"]["probe"] is None
        c.put("/api/settings", json={"use_probe": True})

        # engine profiles: listed, validated; env overrides (fake embedder) are reported
        eng_info = c.get("/api/engine").json()
        assert {p["profile"] for p in eng_info["profiles"]} == {"light", "balanced", "accurate"}
        assert "KWEETO_EMBEDDER" in eng_info["overrides"]
        assert c.put("/api/engine", json={"profile": "nope"}).status_code == 400
        assert c.put("/api/engine", json={"profile": "light"}).json()["active"]["profile"] == "light"

        # embedder change: regions AND box vectors are rebuilt in the background, the teaching survives
        from app import services
        from app.db import SessionLocal
        boxes_before = c.get("/api/stats").json()["boxes"]
        with SessionLocal() as db:
            services.reindex(db, embeddings_changed=True)
        c.post("/api/rescan")  # wakes the worker
        t0 = time.time()
        while time.time() - t0 < 60:
            st = c.get("/api/stats").json()
            if not st["worker"]["running"] and st["engine"]["vectors"] >= 50 + boxes_before and st["proposals"] > 0:
                break
            time.sleep(0.3)
        st = c.get("/api/stats").json()
        assert st["boxes"] == boxes_before and st["proposals"] > 0
        assert st["engine"]["vectors"] >= 50 + boxes_before  # every box has its vector again

        assert c.post("/api/reset").json()["ok"]
        assert c.get("/api/stats").json()["boxes"] == 0


def test_image_search_by_name_is_literal():
    """The command palette finds images by part of their file name; % and _ are plain characters."""
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Search test"})
        files = [("files", (n, _img("red", i), "image/png")) for i, n in enumerate(["part_000.png", "partX000.png", "a%b.png"])]
        c.post("/api/images/upload", files=files)
        names = lambda q: sorted(i["filename"] for i in c.get("/api/images", params={"q": q}).json()["items"])  # noqa: E731
        assert names("part_0") == ["part_000.png"]          # "_" is not a wildcard
        assert names("PART") == ["partX000.png", "part_000.png"]  # case-insensitive
        assert names("a%b") == ["a%b.png"]
        assert names("zzz") == []


def test_demo_project_is_ready_to_teach():
    """One click: an open project with three classes and synthetic images that the worker scans quickly."""
    with TestClient(app) as c:
        p = c.post("/api/projects/demo").json()
        assert p["active"] and p["name"].startswith("Demo")
        assert sorted(x["name"] for x in c.get("/api/classes").json()) == ["lime", "pipe", "tomato"]
        early = c.get("/api/queue/next", params={"position": 0}).json()
        assert early["image_id"] is not None or early["reason"] == "waiting"  # never "done" while images are scanned
        eng = c.get("/api/engine").json()["active"]
        assert eng["profile"] == "custom" and eng["segmenter"] == "simple"
        s = _wait_embedded(c, 36, timeout=120)
        assert s["images"]["total"] == 36 and s["engine"]["vectors"] > 36  # candidate regions were found
        nxt = c.get("/api/queue/next", params={"position": 0}).json()
        assert nxt["image_id"] is not None  # the Lesson can start right away


def test_queue_says_waiting_while_images_are_scanned():
    from app import db, services
    from app.models import ImageItem

    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Queue test"})
        with db.SessionLocal() as s:  # an image the worker has not scanned yet
            s.add(ImageItem(filename="x.png", stored_name="missing.png", width=8, height=8, content_hash="h",
                            status="pending"))
            s.commit()
            assert services.next_image(s, 0, []) == (None, "waiting")
            s.query(ImageItem).delete()
            s.commit()
            assert services.next_image(s, 0, []) == (None, "done")

"""Projects: isolation between datasets, per-project Pixel, deleting images and whole projects, migration."""
import io
import os
import tempfile
import time

os.environ.setdefault("KWEETO_EMBEDDER", "pixels")
os.environ.setdefault("KWEETO_DATA_DIR", tempfile.mkdtemp(prefix="kweeto-test-"))

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from app import workspace  # noqa: E402
from app.main import app  # noqa: E402


def _png(seed: int) -> bytes:
    im = Image.new("RGB", (96, 96), (130, 130, 130))
    ImageDraw.Draw(im).rectangle([10 + seed, 10, 60 + seed, 60], fill=(200, 30 + seed * 9, 30))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _wait_scanned(c, n, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = c.get("/api/stats").json()
        if s["images"]["embedded"] + s["images"]["annotated"] >= n and not s["worker"]["running"]:
            return
        time.sleep(0.2)
    raise AssertionError("scan did not complete")


def test_projects_are_isolated_and_deletable():
    with TestClient(app) as c:
        a = c.post("/api/projects", json={"name": "Vegetables"}).json()
        assert a["active"] and a["stats"]["images"] == 0
        assert set(a["pixel"]) == {"name", "color", "shape", "eyes", "accessory"}
        c.post("/api/images/upload", files=[("files", (f"v{i}.png", _png(i), "image/png")) for i in range(6)])
        _wait_scanned(c, 6)
        c.post("/api/classes", json={"name": "Tomato"})
        imgs = c.get("/api/images").json()["items"]
        assert len(imgs) == 6
        assert c.get(imgs[0]["thumb_url"]).status_code == 200  # files of the active project are served

        # a second project sees nothing of the first one, and has its own Pixel
        b = c.post("/api/projects", json={"name": "Screws", "pixel": {"color": "teal", "name": "Bit"}}).json()
        assert b["pixel"]["color"] == "teal" and b["pixel"]["name"] == "Bit"
        assert c.get("/api/images").json()["total"] == 0
        assert c.get("/api/classes").json() == []
        assert c.get(imgs[0]["thumb_url"]).status_code == 404
        b = c.patch(f"/api/projects/{b['id']}", json={"pixel": {"shape": "blob", "color": "nope"}}).json()
        assert b["pixel"]["shape"] == "blob" and b["pixel"]["color"] == "violet"  # invalid values fall back

        # back to the first project: everything is still there
        c.post(f"/api/projects/{a['id']}/open")
        assert c.get("/api/images").json()["total"] == 6
        assert [k["name"] for k in c.get("/api/classes").json()] == ["Tomato"]

        # delete one image, then two more in bulk: rows, vectors and files go
        path = workspace.images_dir()
        files_before = len(list(path.iterdir()))
        assert c.delete(f"/api/images/{imgs[0]['id']}").json()["deleted"] == 1
        assert c.post("/api/images/delete", json={"ids": [imgs[1]["id"], imgs[2]["id"]]}).json()["deleted"] == 2
        assert c.get("/api/images").json()["total"] == 3
        assert len(list(path.iterdir())) == files_before - 3
        assert c.get(f"/api/images/{imgs[0]['id']}").status_code == 404

        # delete a project that is not active, then the active one
        assert c.delete(f"/api/projects/{b['id']}").status_code == 200
        listed = {p["id"] for p in c.get("/api/projects").json()["projects"]}
        assert b["id"] not in listed
        r = c.delete(f"/api/projects/{a['id']}").json()
        assert r["active"] is None  # no other project is opened behind the user's back
        assert a["id"] not in {p["id"] for p in c.get("/api/projects").json()["projects"]}
        assert c.get("/api/stats").status_code == 409  # project pages answer "no project open"
        assert c.get("/api/stats").json()["code"] == "no_project"
        assert c.get("/api/projects/active").json() is None
        t0 = time.time()
        while (workspace.PROJECTS_DIR / a["id"]).exists() and time.time() - t0 < 15:
            time.sleep(0.2)
        assert not (workspace.PROJECTS_DIR / a["id"]).exists()


def test_legacy_data_is_moved_into_a_project(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace, "DATA_DIR", tmp_path)
    monkeypatch.setattr(workspace, "PROJECTS_DIR", tmp_path / "projects")
    (tmp_path / "teachme.db").write_bytes(b"db")
    (tmp_path / "images").mkdir()
    (tmp_path / "images" / "x.png").write_bytes(b"img")
    (tmp_path / "engine.json").write_text("{}")
    p = workspace.migrate_legacy()
    assert p is not None and p.name == "My project" and p.pixel.color == "violet"
    assert (p.dir / "teachme.db").read_bytes() == b"db"
    assert (p.dir / "images" / "x.png").exists() and (p.dir / "engine.json").exists()
    assert not (tmp_path / "teachme.db").exists() and not (tmp_path / "images").exists()
    assert workspace.migrate_legacy() is None  # nothing left to migrate


def test_first_start_opens_no_project(tmp_path, monkeypatch):
    from app import projects

    monkeypatch.setattr(workspace, "DATA_DIR", tmp_path)
    monkeypatch.setattr(workspace, "PROJECTS_DIR", tmp_path / "projects")
    monkeypatch.setattr(workspace, "REGISTRY", tmp_path / "projects.json")
    projects.startup()
    assert workspace.current is None
    assert workspace.list_projects() == []  # nothing created by default

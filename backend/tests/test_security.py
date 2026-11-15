"""Guards against other websites reaching the (unauthenticated, local) API: cross-site requests, DNS rebinding,
file names that would leave the project folder."""
import os
import tempfile

os.environ.setdefault("KWEETO_EMBEDDER", "pixels")
os.environ.setdefault("KWEETO_DATA_DIR", tempfile.mkdtemp(prefix="kweeto-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def test_cross_site_requests_are_refused():
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Security test"})
        # a form posted by another website: the browser adds Origin / Sec-Fetch-Site, not X-Kweeto
        r = c.post("/api/reset", headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"})
        assert r.status_code == 403 and r.json()["code"] == "cross_site"
        assert c.post("/api/rescan", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
        assert c.delete("/api/images/1", headers={"Origin": "null"}).status_code == 403
        # the app's own pages send the header; scripts and tests send no browser headers at all
        assert c.post("/api/reset", headers={"Origin": "http://localhost:3000", "X-Kweeto": "1"}).status_code == 200
        assert c.post("/api/reset").status_code == 200
        # reading is never blocked
        assert c.get("/api/stats", headers={"Origin": "https://evil.example"}).status_code == 200


def test_foreign_host_names_are_refused():
    """DNS rebinding: evil.example resolving to 127.0.0.1 still says Host: evil.example."""
    with TestClient(app) as c:
        assert c.get("/api/health", headers={"Host": "evil.example:8000"}).status_code == 400
        assert c.get("/api/health", headers={"Host": "127.0.0.1:8000"}).status_code == 200
        assert c.get("/api/health", headers={"Host": "localhost:3000"}).status_code == 200


def test_file_names_cannot_leave_the_project_folder():
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Files test"})
        for name in ("D%3Asecret.txt", "C%3Asecret.txt", "..%5Cx.jpg", ".env", "x.jpg%3Astream"):
            assert c.get(f"/files/images/{name}").status_code == 404, name


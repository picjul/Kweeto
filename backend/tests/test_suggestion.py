"""Pixel proposes a dedicated detector only when its judged guesses have really stopped improving."""
import os
import tempfile

os.environ.setdefault("KWEETO_EMBEDDER", "pixels")
os.environ.setdefault("KWEETO_DATA_DIR", tempfile.mkdtemp(prefix="kweeto-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import db, detector, pixel  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Outcome  # noqa: E402


def block(errors: int, n: int = detector.PLATEAU_BLOCK) -> list[bool]:
    return [False] * errors + [True] * (n - errors)


def test_plateau_rules():
    assert detector.plateau(block(6) + block(6)) is None                      # not enough judgments yet
    assert detector.plateau(block(6) + block(5) + block(6)) == {"errors": [6, 5, 6], "block": 30}
    assert detector.plateau(block(12) + block(8) + block(5)) is None          # still improving (40% -> 17%)
    assert detector.plateau(block(2) + block(2) + block(2)) is None           # flat, but rarely wrong (7%)
    assert detector.plateau(block(20) + block(6) + block(6) + block(5)) == {"errors": [6, 6, 5], "block": 30}


def _judge(oks: list[bool]) -> None:
    with db.SessionLocal() as s:
        s.add_all(Outcome(confidence=0.7, correct=ok, class_id=None, source="harvest") for ok in oks)
        s.commit()


def test_suggestion_appears_then_respects_not_now():
    with TestClient(app) as c:
        c.post("/api/projects", json={"name": "Plateau"})
        _judge(block(10) + block(9) + block(10))
        st = c.get("/api/stats").json()
        sg = st["suggestion"]
        assert sg["kind"] == "train_detector" and sg["errors"] == [10, 9, 10] and not sg["ready"]
        line = pixel.train_detector_line(sg)   # (the home message shows it once images and classes exist)
        assert "wrong 10, 9 and 10 times out of 30" in line
        assert f"finish {sg['min_images']} more images" in line

        c.post("/api/training/dismiss-suggestion")
        assert c.get("/api/stats").json()["suggestion"] is None               # "Not now"
        _judge(block(9) + block(10) + block(9))                                # 90 more, still flat
        assert c.get("/api/stats").json()["suggestion"]["errors"] == [9, 10, 9]


def test_line_after_a_previous_training():
    line = pixel.train_detector_line({"kind": "train_detector", "errors": [6, 5, 6], "block": 30, "ready": True,
                                      "finished_images": 40, "min_images": 10, "trained_before": True})
    assert line.startswith("In my last 90 guesses you judged I was wrong 6, 5 and 6 times out of 30")
    assert "Another training" in line

"""The trained detector as a second opinion in Pixel's guesses (engine.predict `detections`)."""
import numpy as np

from app import engine as eng

PARAMS = eng.Params(sim_min=0.2, sim_high=0.8, propose_min=0.05, knn_k=5, temperature=0.05, max_per_image=5)


def _unit(v):
    return (v / np.linalg.norm(v, axis=-1, keepdims=True)).astype(np.float32)


def _scene(rng):
    """Two classes; image 7 has two candidate windows of class 1 and an extra detector-only region."""
    dim = 32
    centers = _unit(rng.normal(size=(2, dim)))
    st = eng.VectorStore()
    items = []
    labels = []
    for k in range(6):  # confirmed examples, 3 per class, on other images
        c = k % 2
        items.append((100 + k, 900 + k, eng.KIND_BOX, (0.1, 0.1, 0.3, 0.3), False,
                      _unit(centers[c] + 0.1 * rng.normal(size=dim))))
        labels.append((100 + k, c + 1))
    a = (0.05, 0.05, 0.3, 0.3)
    b = (0.6, 0.6, 0.3, 0.3)
    d = (0.6, 0.05, 0.3, 0.3)
    items += [(1, 7, eng.KIND_WINDOW, a, False, _unit(centers[0] + 0.25 * rng.normal(size=dim))),
              (2, 7, eng.KIND_WINDOW, b, False, _unit(centers[0] + 0.25 * rng.normal(size=dim))),
              (3, 7, eng.KIND_DETECTOR, d, False, _unit(centers[0] + 0.1 * rng.normal(size=dim)))]
    st.add(items)
    return st, labels, a, b, d


def _by_region(props):
    return {p["region_id"]: p for p in props}


def test_off_means_exactly_the_old_behaviour():
    st, labels, *_ = _scene(np.random.default_rng(0))
    off = eng.predict(st, labels, [], {7}, PARAMS)
    assert 3 not in _by_region(off)  # detector-only regions are not candidates without the detector
    again = eng.predict(st, labels, [], {7}, PARAMS, detections=None)
    assert off == again


def test_agreement_raises_disagreement_and_silence_lower():
    st, labels, a, b, d = _scene(np.random.default_rng(1))
    base = _by_region(eng.predict(st, labels, [], {7}, PARAMS))
    dets = {7: [(1, 0.9, a), (2, 0.9, b), (1, 0.8, d)]}
    withd = _by_region(eng.predict(st, labels, [], {7}, PARAMS, detections=dets))
    assert withd[1]["confidence"] >= base[1]["confidence"]          # same class: at least as sure
    assert withd[2]["confidence"] < base[2]["confidence"]           # another class: humbler
    assert 3 in withd and withd[3]["class_id"] == 1                 # the detector's extra region is a candidate

    silent = _by_region(eng.predict(st, labels, [], {7}, PARAMS, detections={7: []}))
    for r in (1, 2):                                                # scanned, nothing seen: lower
        assert silent.get(r, {"confidence": 0})["confidence"] < base[r]["confidence"]

    unscanned = _by_region(eng.predict(st, labels, [], {7}, PARAMS, detections={}))
    for r in (1, 2):                                                # not looked at yet: unchanged
        assert abs(unscanned[r]["confidence"] - base[r]["confidence"]) < 1e-9


def test_evidence_matching():
    cls, score, scanned = eng.detector_evidence(
        np.array([1, 1, 2], np.int64),
        np.array([[0, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 1, 1]], np.float32),
        {1: [(4, 0.7, (0.02, 0.0, 0.5, 0.5))]})
    assert cls.tolist() == [4, -1, -1]
    assert score[0] == 0.7 and score[1] == 0
    assert scanned.tolist() == [True, True, False]

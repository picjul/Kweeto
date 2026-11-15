import numpy as np

from app import engine as eng


def _unit(v):
    return (v / np.linalg.norm(v, axis=-1, keepdims=True)).astype(np.float32)


def _make_store(rng, n_per_class=40, dim=32):
    centers = _unit(rng.normal(size=(2, dim)))
    st = eng.VectorStore()
    items, truth = [], {}
    rid = 1
    for c in range(2):
        for i in range(n_per_class):
            img = c * 1000 + i
            v = _unit(centers[c] + 0.15 * rng.normal(size=dim))
            items.append((rid, img, eng.KIND_WINDOW, (0, 0, 1, 1), True, v))
            truth[img] = c + 1
            rid += 1
    st.add(items)
    return st, items, truth


PARAMS = eng.Params(sim_min=0.2, sim_high=0.8, propose_min=0.1, knn_k=5, temperature=0.05, max_per_image=3)


def test_knn_propagates_correct_classes():
    rng = np.random.default_rng(0)
    st, items, truth = _make_store(rng)
    # 3 examples per class as confirmed boxes
    labels, box_items = [], []
    for k, (rid, img, _, g, _, v) in enumerate([items[0], items[1], items[2], items[40], items[41], items[42]]):
        box_items.append((10_000 + k, img, eng.KIND_BOX, g, False, v))
        labels.append((10_000 + k, truth[img]))
    st.add(box_items)
    targets = {img for img in truth}
    props = eng.predict(st, labels, [], targets, PARAMS)
    by_img = {p["image_id"]: p["class_id"] for p in props}
    acc = np.mean([by_img.get(i) == c for i, c in truth.items()])
    assert acc > 0.95


def test_negative_blocks_proposal():
    rng = np.random.default_rng(1)
    st, items, truth = _make_store(rng)
    rid, img, _, g, _, v = items[0]
    st.add([(99_999, 5555, eng.KIND_BOX, g, False, v)])
    labels = [(99_999, 1)]
    target_region = items[1]
    negatives = [(target_region[0], 1)]
    props = eng.predict(st, labels, negatives, {target_region[1]}, PARAMS)
    assert not any(p["region_id"] == target_region[0] for p in props)


def test_store_remove_and_similar():
    rng = np.random.default_rng(2)
    st, items, truth = _make_store(rng)
    res = eng.similar_images(st, items[0][1], k=5)
    assert len(res) == 5
    assert all(truth[i] == truth[items[0][1]] for i, _ in res)
    st.remove([items[1][0]])
    assert st.size() == len(items) - 1


def test_topk_numpy_matches_faiss_shape():
    rng = np.random.default_rng(3)
    base = _unit(rng.normal(size=(50, 16)))
    q = _unit(rng.normal(size=(7, 16)))
    sims, idx = eng.topk_ip(base, q, 4)
    assert sims.shape == (7, 4) and idx.shape == (7, 4)
    full = q @ base.T
    assert np.allclose(sims[:, 0], full.max(axis=1), atol=1e-5)


def test_probe_learns_and_blends_with_knn():
    rng = np.random.default_rng(5)
    st, items, truth = _make_store(rng)
    picks = [items[i] for i in (0, 1, 2, 3, 40, 41, 42, 43)]
    X = np.stack([it[5] for it in picks])
    y = np.array([truth[it[1]] for it in picks])
    probe = eng.train_probe(X, y)
    assert probe is not None and probe.train_acc == 1.0
    # the probe alone generalises to the unseen points of each cluster
    allX = np.stack([it[5] for it in items])
    pred = probe.classes[probe.predict_proba(allX).argmax(axis=1)]
    assert np.mean(pred == np.array([truth[it[1]] for it in items])) > 0.95
    # blended prediction keeps working end to end
    st.add([(20_000 + k, it[1], eng.KIND_BOX, it[3], False, it[5]) for k, it in enumerate(picks)])
    labels = [(20_000 + k, truth[it[1]]) for k, it in enumerate(picks)]
    p = eng.Params(**{**PARAMS.__dict__, "probe_weight": 0.5})
    props = eng.predict(st, labels, [], set(truth), p, probe=probe)
    by_img = {q["image_id"]: q["class_id"] for q in props}
    assert np.mean([by_img.get(i) == c for i, c in truth.items()]) > 0.95


def test_probe_needs_two_classes():
    X = np.eye(4, dtype=np.float32)
    assert eng.train_probe(X, np.array([1, 1, 1, 1])) is None


def test_kmeans_separates_clusters():
    rng = np.random.default_rng(4)
    st, items, truth = _make_store(rng)
    x = np.stack([it[5] for it in items])
    assign = eng.kmeans(x, 2)
    assert len(set(assign[:40])) == 1 and len(set(assign[40:])) == 1 and assign[0] != assign[40]


def _item(cls, conf, x, y, w, h):
    return dict(image_id=1, region_id=int(x * 1000 + y * 100 + w * 10), class_id=cls, second_class_id=None,
                confidence=conf, margin=0.5, nn_sim=0.9, x=x, y=y, w=w, h=h)


def test_touching_objects_win_over_their_pile():
    pile = _item(1, 0.8, 0.1, 0.1, 0.6, 0.2)  # Pixel is even surer about the pile...
    kids = [_item(1, 0.7, 0.1 + 0.2 * k, 0.1, 0.2, 0.2) for k in range(3)]
    out = eng.select_instances([pile] + kids, priors={}, max_n=10)
    assert sorted(round(o["x"], 3) for o in out) == [0.1, 0.3, 0.5]  # ...but it's three tomatoes, not one


def test_broken_object_wins_over_its_pieces_with_a_size_prior():
    whole = _item(2, 0.6, 0.1, 0.4, 0.5, 0.08)
    pieces = [_item(2, 0.7, 0.1, 0.4, 0.22, 0.08), _item(2, 0.7, 0.38, 0.4, 0.22, 0.08)]
    prior = eng.size_priors({2: [(0, 0, 0.5, 0.08)] * 3 + [(0, 0, 0.45, 0.09)]})
    out = eng.select_instances([whole] + pieces, priors=prior, max_n=10)
    assert len(out) == 1 and out[0]["w"] == 0.5
    # without knowing the typical size, the more confident reading (two objects) wins
    out = eng.select_instances([whole] + pieces, priors={}, max_n=10)
    assert len(out) == 2


def test_background_class_and_warm_start():
    rng = np.random.default_rng(7)
    obj = _unit(rng.normal(size=16))
    X = np.concatenate([_unit(obj + 0.2 * rng.normal(size=(10, 16))), _unit(rng.normal(size=(30, 16)))])
    y = np.array([3] * 10 + [eng.BG] * 30)
    probe = eng.train_probe(X, y)
    assert probe.has_bg and probe.train_acc > 0.95
    p_obj = probe.predict_proba(_unit(obj + 0.2 * rng.normal(size=(5, 16))))[:, 1]
    assert (p_obj > 0.5).all()
    # one more example: re-fit on everything, starting from the previous solution -> converges faster
    X2, y2 = np.concatenate([X, X[:1]]), np.concatenate([y, y[:1]])
    warm = eng.train_probe(X2, y2, init=probe)
    cold = eng.train_probe(X2, y2)
    assert warm.steps < cold.steps


def test_children_counts_flag_piles():
    st = eng.VectorStore()
    v = _unit(np.ones((4, 8)))
    st.add([(1, 5, eng.KIND_WINDOW, (0.1, 0.1, 0.6, 0.2), False, v[0]),
            (2, 5, eng.KIND_WINDOW, (0.1, 0.1, 0.2, 0.2), False, v[1]),
            (3, 5, eng.KIND_WINDOW, (0.3, 0.1, 0.2, 0.2), False, v[2]),
            (4, 5, eng.KIND_WINDOW, (0.5, 0.1, 0.2, 0.2), False, v[3])])
    counts = eng.children_counts(st, np.array([st.row_of[r] for r in (1, 2, 3, 4)]))
    assert counts.tolist() == [3, 0, 0, 0]

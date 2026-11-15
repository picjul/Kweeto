"""Extension points: registries, plugins, custom profile, probes, detector catalog."""
import textwrap

import numpy as np
import pytest

from app import detector_catalog, embedder, plugins, probes, profiles, segmenter
from app import engine as eng


@pytest.fixture(autouse=True)
def _clean_registries():
    """Plugins loaded by a test must not leak into the other tests."""
    regs = (plugins.EMBEDDERS, plugins.SEGMENTERS, plugins.PROBES, plugins.DETECTORS)
    plugins.ensure_loaded()
    saved = [dict(r._items) for r in regs]
    n_errors, n_loaded = len(plugins.errors), len(plugins.loaded_plugins)
    yield
    for r, items in zip(regs, saved):
        r._items.clear()
        r._items.update(items)
    del plugins.errors[n_errors:]
    del plugins.loaded_plugins[n_loaded:]


def test_builtins_are_registered():
    assert {"dinov2", "siglip", "hf", "pixels"} <= set(plugins.EMBEDDERS.ids())
    assert {"sam", "sam2", "simple"} <= set(plugins.SEGMENTERS.ids())
    assert {"linear", "mlp"} <= set(plugins.PROBES.ids())
    with pytest.raises(ValueError, match="Unknown embedder"):
        plugins.EMBEDDERS.get("nope")


def test_signatures_of_existing_projects_do_not_change():
    """Existing databases must not be re-embedded or re-scanned because of the refactor."""
    light = profiles.PROFILES["light"]  # without the env overrides the tests run with
    assert light.signature == "dinov2:facebook/dinov2-small"
    assert light.scan_signature.endswith(":sam:nielsr/slimsam-77-uniform:6:16:24:6")
    assert profiles.PROFILES["accurate"].signature == "siglip:google/siglip-base-patch16-224"
    simple = profiles.custom_config({"embedder": "pixels", "segmenter": "simple"})
    assert simple.signature == "pixels" and ":simple:" in simple.scan_signature


def test_plugin_file_registers_an_embedder_usable_by_a_custom_profile(tmp_path):
    path = tmp_path / "my_plugin.py"
    path.write_text(textwrap.dedent('''
        import numpy as np
        from app.embedders import Embedder
        from app.plugins import EMBEDDERS

        @EMBEDDERS.register
        class Mean(Embedder):
            id = "test-mean"
            title = "Mean colour"
            license = "MIT"
            needs_torch = False
            custom_model = False

            def embed(self, images):
                v = np.stack([np.asarray(im.resize((2, 2)), np.float32).reshape(-1) + 1 for im in images])
                return (v / np.linalg.norm(v, axis=1, keepdims=True)).astype(np.float32)
    '''))
    assert plugins.load_plugin_file(path)
    cfg = profiles.custom_config({"embedder": "test-mean", "segmenter": "simple"})
    assert cfg.signature == "test-mean:"
    old = profiles.active
    try:
        profiles.set_active(cfg)
        embedder.unload()
        from PIL import Image

        v = embedder.embed_images([Image.new("RGB", (8, 8), (10, 200, 30))])
        assert v.shape == (1, 12) and abs(float(np.linalg.norm(v)) - 1) < 1e-5
        assert segmenter.name() == "simple"
    finally:
        profiles.set_active(old)
        embedder.unload()
    assert any(c["id"] == "test-mean" and not c["builtin"] for c in plugins.describe()["embedders"])


def test_a_broken_plugin_is_reported_not_fatal(tmp_path):
    path = tmp_path / "broken.py"
    path.write_text("raise RuntimeError('boom')\n")
    assert not plugins.load_plugin_file(path)
    assert any(e["plugin"] == "broken.py" and "boom" in e["error"] for e in plugins.errors)


def test_custom_profile_checks_its_components():
    pytest.importorskip("transformers")  # the "sam" segmenter below must be runnable here
    with pytest.raises(ValueError):
        profiles.resolve("custom", {"embedder": "nope", "segmenter": "simple"})
    with pytest.raises(ValueError):
        profiles.resolve("custom", {})
    cfg = profiles.custom_config({"embedder": "dinov2", "segmenter": "sam", "sam_points": 4, "sam_refine": 0})
    assert cfg.model == "facebook/dinov2-small" and cfg.sam_model == "nielsr/slimsam-77-uniform"
    assert cfg.sam_refine == 0 and cfg.describe()["title"] == "Custom"


def _xor(n=200, seed=0):
    rng = np.random.default_rng(seed)
    X = rng.uniform(-1, 1, size=(n, 2)).astype(np.float32)
    y = np.where((X[:, 0] > 0) ^ (X[:, 1] > 0), 2, 1)
    return X, y


def test_mlp_probe_bends_where_a_line_cannot():
    X, y = _xor()
    lin = probes.LinearTrainer().fit(X, y, None)
    mlp = probes.MLPTrainer().fit(X, y, None)
    assert mlp.train_acc > 0.9 > lin.train_acc
    again = probes.MLPTrainer().fit(X, y, None)  # deterministic
    assert np.allclose(again.predict_proba(X), mlp.predict_proba(X))


def test_mlp_probe_refits_on_all_examples_and_can_unlearn():
    X, y = _xor()
    first = probes.MLPTrainer().fit(X, y, None)
    warm = probes.MLPTrainer().fit(X, y, None, init=first)
    assert warm.steps <= first.steps                      # warm start: cheaper ...
    keep = y == 1
    only_one = probes.MLPTrainer().fit(X[keep], y[keep], None, init=first)
    assert only_one is None                               # ... but it learns from what is there now: one class left
    bg = np.concatenate([y[:150], np.full(50, eng.BG)])
    p = probes.MLPTrainer().fit(X, bg, None)
    assert p.has_bg and p.classes[0] == eng.BG


def test_detector_catalog_keeps_existing_model_ids():
    fams = {f.id: f for f in plugins.DETECTORS.all()}
    assert fams["yolo9"].weights("t") == "LibreYOLO9t.pt" and fams["yolo9"].model_id("t") == "yolo9-t"
    assert fams["yolox"].weights("n") == "LibreYOLOXn.pt"
    assert detector_catalog.model_info("gone-x")["size"] == "x"  # a run made with a family no longer offered
    for f in fams.values():
        assert f.license and f.sizes and f.prefix.startswith("Libre")


def test_the_example_plugin_loads(tmp_path):
    from pathlib import Path

    src = Path(__file__).resolve().parent.parent / "plugins" / "_example_plugin.py"
    copy = tmp_path / "example_copy.py"
    copy.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    assert plugins.load_plugin_file(copy)
    assert "convnext" in plugins.EMBEDDERS and "centroid" in plugins.PROBES
    assert "rfdetr" in [f.id for f in plugins.DETECTORS.all()]
    X = np.array([[0, 0], [0, 1], [5, 5], [5, 6]], np.float32)
    p = plugins.PROBES.get("centroid")().fit(X, np.array([1, 1, 2, 2]), None)
    assert p.train_acc == 1.0 and p.predict_proba(X).shape == (4, 2)

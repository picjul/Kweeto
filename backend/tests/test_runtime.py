"""Inference runtime: execution provider choice, the ONNX export cache, and (opt-in) parity with PyTorch.

The parity test downloads nothing but needs the real models in the Hugging Face cache; run it with
KWEETO_TEST_MODELS=1 (it compares the app's own embedder/segmenter code paths on ONNX vs PyTorch).
"""
import os

import numpy as np
import pytest

from app import runtime


def test_auto_prefers_an_accelerator_then_cpu():
    assert runtime.choose_providers("auto", ["CPUExecutionProvider"]) == ["CPUExecutionProvider"]
    assert runtime.choose_providers("auto", ["DmlExecutionProvider", "CPUExecutionProvider"]) == \
        ["DmlExecutionProvider", "CPUExecutionProvider"]
    # CUDA beats DirectML; TensorRT and CoreML are never picked automatically
    assert runtime.choose_providers("auto", ["TensorrtExecutionProvider", "CUDAExecutionProvider", "DmlExecutionProvider",
                                             "CPUExecutionProvider"])[0] == "CUDAExecutionProvider"
    assert runtime.choose_providers("auto", ["CoreMLExecutionProvider", "CPUExecutionProvider"]) == ["CPUExecutionProvider"]


def test_explicit_provider_and_missing_one():
    have = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    assert runtime.choose_providers("coreml", have) == ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    assert runtime.choose_providers("dml", have) == ["CPUExecutionProvider"]  # not installed: CPU
    assert runtime.choose_providers("cpu", have) == ["CPUExecutionProvider"]


def test_runtime_choice(monkeypatch):
    monkeypatch.setenv("KWEETO_RUNTIME", "torch")
    assert runtime.runtime() == "torch"
    monkeypatch.setenv("KWEETO_RUNTIME", "onnx")
    monkeypatch.setattr(runtime, "_ort", lambda: None)  # onnxruntime missing: PyTorch
    assert runtime.runtime() == "torch"
    assert runtime.info()["runtime"] == "torch"


def test_export_once_then_reuse(tmp_path, monkeypatch):
    torch = pytest.importorskip("torch")
    pytest.importorskip("onnxruntime")
    pytest.importorskip("onnx")
    monkeypatch.setenv("KWEETO_ONNX_DIR", str(tmp_path))
    monkeypatch.setenv("KWEETO_EP", "cpu")
    lin = torch.nn.Linear(4, 3).eval()
    calls = []

    def export(path):
        calls.append(path)
        runtime.export_onnx(lin, (torch.randn(2, 4),), path, ["x"], ["y"], {"x": {0: "n"}, "y": {0: "n"}})

    g = runtime.graph("tiny/model", "linear", export)
    x = np.random.rand(5, 4).astype(np.float32)
    with torch.inference_mode():
        want = lin(torch.from_numpy(x)).numpy()
    assert np.allclose(g.run({"x": x})[0], want, atol=1e-5)
    assert g.provider == "CPUExecutionProvider"
    runtime.graph("tiny/model", "linear", export)  # cached: not exported again
    assert len(calls) == 1
    assert [p.name for p in tmp_path.iterdir()] == [runtime.graph_path("tiny/model", "linear").name]


@pytest.mark.skipif(os.getenv("KWEETO_TEST_MODELS") != "1", reason="needs the real models (KWEETO_TEST_MODELS=1)")
def test_onnx_matches_pytorch_on_real_models(tmp_path, monkeypatch):
    from PIL import Image, ImageDraw

    from app import embedder, profiles, segmenter
    from app.engine import iou

    monkeypatch.setenv("KWEETO_ONNX_DIR", str(tmp_path))
    profiles.set_active(profiles.resolve("light"))
    img = Image.new("RGB", (640, 480), (225, 220, 210))
    d = ImageDraw.Draw(img)
    d.ellipse((80, 100, 240, 260), fill=(200, 40, 30))
    d.rectangle((330, 160, 560, 300), fill=(60, 110, 160))
    crops = [img, img.crop((60, 80, 260, 280)), img.crop((300, 140, 600, 320))]

    def run(rt):
        monkeypatch.setenv("KWEETO_RUNTIME", rt)
        embedder.unload()
        segmenter.unload()
        return (embedder.embed_images(crops), segmenter.auto_boxes("img", img),
                segmenter.segment("img", img, points=[(0.25, 0.37)]), segmenter.segment("img", img, box=(0.5, 0.3, 0.4, 0.35)))

    (ea, aa, ca, sa), (eb, ab, cb, sb) = run("torch"), run("onnx")
    assert (ea * eb).sum(1).min() > 0.9999
    assert len(aa) == len(ab) and all(max(iou(x, y) for y in ab) > 0.95 for x in aa)
    assert iou(ca[0], cb[0]) > 0.95 and iou(sa[0], sb[0]) > 0.95

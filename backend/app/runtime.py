"""Inference runtime: ONNX Runtime with a selectable execution provider (the standard), PyTorch as fallback.

The vision models (embedders, SAM v1 family) run as ONNX graphs exported from their PyTorch weights on first
use and cached on disk, so the same file runs on whatever hardware ONNX Runtime supports here:

    KWEETO_RUNTIME = auto | onnx | torch     auto = onnx when onnxruntime is installed, else torch
    KWEETO_EP      = auto | cpu | cuda | tensorrt | dml | coreml | openvino | rocm | migraphx
    KWEETO_ONNX_DIR = cache of the exported graphs (default DATA_DIR/onnx)

"auto" picks the first accelerator the installed onnxruntime package offers (CUDA, ROCm, MIGraphX, DirectML,
OpenVINO), else the CPU. TensorRT (minutes-long engine builds) and CoreML (reduced precision by default, not
validated yet) are used only when asked for explicitly. The ONNX graphs reproduce the PyTorch outputs (cosine
>= 0.99999 for embeddings, mask IoU ~1.0), so switching runtime never invalidates stored vectors or regions.

Pick the onnxruntime package for your hardware (they exclude each other): `onnxruntime` (CPU; CoreML on macOS),
`onnxruntime-directml` (any DirectX 12 GPU on Windows: AMD, Intel, NVIDIA), `onnxruntime-gpu` (NVIDIA CUDA /
TensorRT), `onnxruntime-openvino` (Intel).
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Callable

from .config import DATA_DIR

log = logging.getLogger("kweeto.runtime")

EXPORT_VERSION = 1  # bump when a graph wrapper changes: old cached files are ignored

EP_ALIASES = {
    "cpu": "CPUExecutionProvider", "cuda": "CUDAExecutionProvider", "tensorrt": "TensorrtExecutionProvider",
    "dml": "DmlExecutionProvider", "directml": "DmlExecutionProvider", "coreml": "CoreMLExecutionProvider",
    "openvino": "OpenVINOExecutionProvider", "rocm": "ROCMExecutionProvider", "migraphx": "MIGraphXExecutionProvider",
}
AUTO_ORDER = ("CUDAExecutionProvider", "ROCMExecutionProvider", "MIGraphXExecutionProvider",
              "DmlExecutionProvider", "OpenVINOExecutionProvider")
LABELS = {
    "CPUExecutionProvider": "CPU", "CUDAExecutionProvider": "CUDA", "TensorrtExecutionProvider": "TensorRT",
    "DmlExecutionProvider": "DirectML", "CoreMLExecutionProvider": "CoreML", "OpenVINOExecutionProvider": "OpenVINO",
    "ROCMExecutionProvider": "ROCm", "MIGraphXExecutionProvider": "MIGraphX",
}
GPU_PROVIDERS = {"CUDAExecutionProvider", "TensorrtExecutionProvider", "DmlExecutionProvider",
                 "ROCMExecutionProvider", "MIGraphXExecutionProvider", "CoreMLExecutionProvider"}

_export_lock = threading.Lock()
_fallbacks: dict[str, str] = {}  # model part -> why it runs on PyTorch instead


def _ort():
    try:
        import onnxruntime  # noqa: F401
        return onnxruntime
    except Exception:
        return None


def requested_runtime() -> str:
    return (os.getenv("KWEETO_RUNTIME") or "auto").strip().lower()


def requested_ep() -> str:
    return (os.getenv("KWEETO_EP") or "auto").strip().lower()


def runtime() -> str:
    """"onnx" or "torch" (what new model loads will use)."""
    want = requested_runtime()
    if want == "torch":
        return "torch"
    if _ort() is None:
        if want == "onnx":
            log.warning("KWEETO_RUNTIME=onnx but onnxruntime is not installed: using PyTorch")
        return "torch"
    return "onnx"


def available_providers() -> list[str]:
    ort = _ort()
    return list(ort.get_available_providers()) if ort else []


def choose_providers(requested: str, available: list[str]) -> list[str]:
    """Execution providers in priority order, always ending with the CPU (per-node fallback)."""
    if requested in ("", "auto"):
        first = next((p for p in AUTO_ORDER if p in available), None)
    else:
        first = EP_ALIASES.get(requested, requested)
        if first not in available:
            log.warning("Execution provider %r is not available (have: %s): using the CPU",
                        requested, ", ".join(available) or "none")
            first = None
    out = [first] if first and first != "CPUExecutionProvider" else []
    return out + ["CPUExecutionProvider"]


def providers() -> list[str]:
    return choose_providers(requested_ep(), available_providers())


def cache_dir() -> Path:
    d = Path(os.getenv("KWEETO_ONNX_DIR") or (DATA_DIR / "onnx"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def graph_path(model_id: str, part: str) -> Path:
    slug = model_id.replace("/", "__").replace(":", "_")
    return cache_dir() / f"{slug}--{part}--v{EXPORT_VERSION}.onnx"


class Graph:
    """An ONNX Runtime session. Run calls are serialised (DirectML does not allow concurrent runs)."""

    def __init__(self, path: Path):
        ort = _ort()
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        provs = providers()
        if "DmlExecutionProvider" in provs:  # required by DirectML
            so.enable_mem_pattern = False
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        try:
            self.session = ort.InferenceSession(str(path), so, providers=provs)
        except Exception as e:  # a broken GPU driver must not stop the app
            log.warning("Could not start %s on %s (%s): using the CPU", path.name, provs[0], e)
            self.session = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
        self.provider = self.session.get_providers()[0]
        self.inputs = [i.name for i in self.session.get_inputs()]
        self._lock = threading.Lock()

    def run(self, feeds: dict) -> list:
        with self._lock:
            return self.session.run(None, feeds)


def graph(model_id: str, part: str, export: Callable[[Path], None]) -> Graph:
    """Loads the cached graph of `model_id`/`part`, exporting it first if needed (needs PyTorch)."""
    path = graph_path(model_id, part)
    if not path.exists():
        with _export_lock:
            if not path.exists():
                tmp = path.with_name(path.name + ".tmp")
                log.info("Exporting %s / %s to ONNX (once)...", model_id, part)
                export(tmp)
                os.replace(tmp, path)  # atomic: a crash mid-export never leaves a half-written graph
    return Graph(path)


def export_onnx(module, args: tuple, path: Path, inputs: list[str], outputs: list[str], dynamic: dict) -> None:
    """torch -> ONNX with the settings validated for these models (TorchScript exporter, opset 18)."""
    import torch

    with torch.inference_mode():
        torch.onnx.export(module.eval(), args, str(path), input_names=inputs, output_names=outputs,
                          dynamic_axes=dynamic, opset_version=18, dynamo=False)


def note_fallback(part: str, reason: str) -> None:
    _fallbacks[part] = reason
    log.warning("%s runs on PyTorch: %s", part, reason)


def clear_fallbacks() -> None:
    _fallbacks.clear()


def label(provider: str | None = None) -> str:
    p = provider or providers()[0]
    return LABELS.get(p, p.replace("ExecutionProvider", ""))


def info() -> dict:
    """What the Engine page shows."""
    rt = runtime()
    prov = providers()[0] if rt == "onnx" else None
    return {
        "runtime": rt, "requested_runtime": requested_runtime(), "requested_ep": requested_ep(),
        "provider": label(prov) if prov else None, "gpu": bool(prov and prov in GPU_PROVIDERS),
        "available": [label(p) for p in available_providers()],
        "fallbacks": dict(_fallbacks),
    }

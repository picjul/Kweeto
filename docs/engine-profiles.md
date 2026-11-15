# Engine profiles and GPU acceleration

[← Back to the README](../README.md).

Pick an intention, not a model: **Engine → Engine profile** (or `KWEETO_PROFILE` on first start).

| Profile | Embedder | Segmenter | Automatic scan | For |
|---|---|---|---|---|
| `light` (default) | DINOv2 small | SlimSAM-77 | 6×6 grid + up to 16 refine prompts | laptops without a GPU |
| `balanced` | DINOv2 small | SAM 2.1 hiera-tiny | 8×8 + 24 | better click-to-box (SAM 2) |
| `accurate` | SigLIP base | SAM base | 12×12 + 32 | best regions, ideally with a GPU |
| `custom` | any registered embedder | any registered segmenter | your choice | trying other models, plugins |

**Custom** lets you pick the embedder and the segmenter yourself, each with a suggested checkpoint or any Hugging
Face id you type (the generic `hf` embedder takes any vision backbone or image-text model, e.g. SigLIP 2). The
choice is saved per project in `engine.json`; switching re-scans the images and, if the embedder changed,
re-learns your boxes with the new eyes.

The SAM mask decoder costs ~50 ms per prompt on a CPU whatever the model, so profiles differ in the image encoder
and in how many prompts they use: a sparse grid, then extra prompts only on areas no mask covered yet (thin or
small objects that fall between grid points).

## GPU acceleration: ONNX Runtime

The vision models run on **ONNX Runtime** with the best **execution provider** it finds (`app/runtime.py`): CUDA or
TensorRT on NVIDIA, **DirectML on any DirectX 12 GPU on Windows** (AMD, Intel, NVIDIA), ROCm / MIGraphX on AMD with Linux,
OpenVINO on Intel, CoreML on Apple Silicon, or the CPU. Each model is exported once from its PyTorch weights to a cached
ONNX graph (SAM as an image encoder plus one mask decoder per prompt kind); PyTorch stays installed for that export and
as the fallback (`KWEETO_RUNTIME=torch`). The Engine page shows what is in use. SAM 2 (`balanced`) still runs on PyTorch.

The ONNX graphs reproduce PyTorch (embedding cosine >= 0.99999, identical masks and boxes on every code path, and the
same learning curve on the CPU), so switching runtime never invalidates stored data. Measured on a desktop with an
8-core CPU and a mid-range AMD GPU (DirectML), compared with PyTorch on the CPU:

| | PyTorch, CPU | ONNX Runtime, CPU | ONNX Runtime, DirectML |
|---|---|---|---|
| DINOv2-small, per crop | 78 ms | 75 ms | **10 ms** |
| SlimSAM-77 scan (`light`), per image | 5.4 s | 4.1 s | **0.39 s** |
| SAM base scan (`accurate`), per image | 9.9 s | 9.2 s | **0.78 s** |
| Learning benchmark, `light`, 640×480 scenes, end to end | 229 s | 194 s | **53-62 s** |

On a GPU the arithmetic differs in the last digits, which can tip a borderline guess (in that benchmark: one object
more or less found at 10 lessons, identical at 20). Install the onnxruntime package that matches your hardware (they
exclude each other): `onnxruntime-directml` on Windows (the default in `requirements.txt`), `onnxruntime` elsewhere
(CPU; CoreML on macOS), `onnxruntime-gpu` for NVIDIA, `onnxruntime-openvino` for Intel.

Switching profile keeps everything you taught. Kweeto records in `DATA_DIR/engine.json` which models built the
stored data: if the segmenter changed it re-scans the images in the background; if the embedder changed it also
re-embeds your boxes (vectors from different models can't be compared). Rejections tied to the old regions are
dropped. The same check runs at start-up, so projects created with older versions upgrade themselves.

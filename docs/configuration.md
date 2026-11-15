# Configuration

[← Back to the README](../README.md). Environment variables, measured scan speed and troubleshooting.

| Variable | Default | |
|---|---|---|
| `KWEETO_DATA_DIR` | `backend/data` | root of all projects (one folder each) |
| `KWEETO_PROFILE` | `light` | engine profile on first start: `light`, `balanced`, `accurate` (then switch in the Engine page) |
| `KWEETO_EMBEDDER` | from profile | override: `dinov2`, `siglip`, or `pixels` for development without torch |
| `KWEETO_MODEL` | from profile | override: Hugging Face checkpoint of the embedder |
| `KWEETO_GRIDS` | `1,2` | candidate window grids; `1,2,3` = finer proposals but 2.5× slower |
| `KWEETO_CENTER_WINDOW` | `1` | adds the centre window |
| `KWEETO_EMBED_BATCH` | `16` | inference batch size |
| `KWEETO_CORS` | `http://localhost:3000,...` | allowed origins |
| `KWEETO_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | host names the backend and the frontend answer to (DNS-rebinding guard); add yours behind a reverse proxy, `*` disables it |
| `KWEETO_SEGMENTER` | from profile (`simple` with the fake embedder) | override: `sam` (SAM / SlimSAM), `sam2`, or `simple` (colour-based, no torch) |
| `KWEETO_SAM_MODEL` | from profile | override: Hugging Face SAM / SAM 2 checkpoint |
| `KWEETO_PROPOSER` | `segments` | object regions from the segmenter (slow with SAM on CPU); `windows` = fixed grid |
| `KWEETO_SAM_POINTS` | from profile | override: first-pass prompt grid (N×N) of the automatic scan |
| `KWEETO_SAM_REFINE` | from profile | override: max extra prompts on areas no mask covered yet |
| `KWEETO_MAX_SEGMENTS` | `24` | regions kept per image (all granularities) |
| `KWEETO_MAX_UNIONS` | `6` | merged-fragment regions per image |
| `KWEETO_QUEUE_SEED` | off | makes the Lesson order reproducible (benchmarks) |
| `KWEETO_USE_PROBE` | `1` | linear probe next to the kNN (also switchable in the Engine page) |
| `KWEETO_PROBE` | `linear` | which learner next to the kNN: `linear`, `mlp` or a plugin's (also on the Engine page) |
| `KWEETO_PLUGINS` | none | comma-separated importable modules that register models (see [Extending Kweeto](extending.md)) |
| `KWEETO_PLUGINS_DIR` | `backend/plugins` | folder whose `*.py` plugins are loaded at start-up |
| `KWEETO_TRUSTSTORE` | off | `1` = trust the OS certificate store for model downloads (TLS-intercepting proxies) |
| `KWEETO_RUNTIME` | `auto` | `onnx` (ONNX Runtime, the default when installed) or `torch` (PyTorch fallback) |
| `KWEETO_EP` | `auto` | ONNX Runtime execution provider: `cpu`, `cuda`, `tensorrt`, `dml` (DirectML), `coreml`, `openvino`, `rocm`, `migraphx`. `auto` = the first GPU provider installed, else the CPU |
| `KWEETO_DETECTOR_WEIGHTS` | `DATA_DIR/libreyolo` | where the pretrained LibreYOLO weights are downloaded (shared by all projects) |
| `KWEETO_USE_DETECTOR` | `1` | Pixel uses the project's active detector as a second opinion (also switchable on the Training / Engine pages) |
| `KWEETO_ONNX_DIR` | `DATA_DIR/onnx` | cache of the ONNX graphs exported from the PyTorch weights (once per model) |

**Measured on a 16-thread laptop CPU, no GPU** (scan = segment + embed, once per image, in the background):

| Profile | Scan per image |
|---|---|
| `light` | ~5.6 s |
| `balanced` | ~8.4 s |
| `accurate` | ~15 s (synthetic 640×480 scenes) |

Click-to-box / snapping after the first click: ~150 ms.
Measure your own data with `python -m bench.simulate --profile light --coco ... --images-dir ...`.

**Behind a TLS-intercepting proxy/antivirus**: `pip install --use-feature=truststore ...`; if npm fails with `ECONNRESET`, `npm install --maxsockets=3 --fetch-retries=6`.

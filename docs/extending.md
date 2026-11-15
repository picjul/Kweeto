# Extending Kweeto

[← Back to the README](../README.md). Plugins for embedders, segmenters, learners, detector families and engine profiles.

Every model Kweeto uses is a **registered component** (`backend/app/plugins.py`), so new ones plug in without
touching the engine:

| Extension point | Base class | What you implement | Where it shows up |
|---|---|---|---|
| Embedder (crop → vector) | `embedders.TransformersEmbedder` (any Hugging Face model) or `embedders.Embedder` | `backbone()` + `pool(out)`, or `embed(images)` | Engine → Custom profile |
| Segmenter (regions, click-to-box, masks) | `segmenter.PromptableSegmenter` (SAM-like) or `segmenter.Segmenter` | `load`, `encode`, `decode_raw` (+ `resize`), or `segment` / `mask_in_box` / `auto_boxes` | Engine → Custom profile |
| Learner next to the kNN | `probes.ProbeTrainer` | `fit(X, y, weights, init)` → an object with `predict_proba` | Engine → thresholds → Learner |
| Detector family (Training page) | `detector_catalog.DetectorFamily` | a registration: LibreYOLO family, weights prefix, sizes, license | Training → New training |
| Engine profile | `profiles.register_profile` | an `EngineConfig` + title | Engine → Engine profile |

A plugin is a Python file in `backend/plugins/` (loaded at start-up; files starting with `_` are skipped) or an
importable module listed in `KWEETO_PLUGINS`. Start from `backend/plugins/_example_plugin.py` (a ConvNeXt
embedder, a nearest-centre learner and an extra LibreYOLO family): copy it without the underscore. A plugin that
fails to load is listed on the Engine page ("Models and plugins") and the app keeps running.

```python
from app.embedders import TransformersEmbedder
from app.plugins import EMBEDDERS, option

@EMBEDDERS.register
class ConvNextEmbedder(TransformersEmbedder):
    id, title, license = "convnext", "ConvNeXt", "Apache-2.0"
    models = (option("facebook/convnext-tiny-224", "ConvNeXt tiny", "Apache-2.0"),)
    default_model = "facebook/convnext-tiny-224"
    graph_name = "embedding-convnext"

    def backbone(self):
        from transformers import ConvNextModel
        return ConvNextModel.from_pretrained(self.model)

    def pool(self, out):
        return out.pooler_output   # the L2 norm, the ONNX export and the PyTorch fallback are inherited
```

Rules that still apply to plugins: every model needs a license compatible with Apache-2.0 (say which in `license`);
a learner must re-learn from **all** the examples on every `fit` (deleting an example has to unlearn it); engine
changes are judged with `bench.simulate`, e.g. `--set probe=mlp` (measured: equal to the linear probe with real
models, F1 0.944 at 30 lessons, slightly ahead early on; 1.000 vs 0.979 at 10 lessons on the synthetic scenes; the
linear probe stays the default).

"""Example Kweeto plugin. Copy it to a name WITHOUT the leading underscore (e.g. `my_models.py`) to load it.

Every file in this folder whose name does not start with "_" is imported at start-up; components it registers
appear on the Engine page (Custom profile, learner) and on the Training page (detector families). A plugin that
fails to load is listed on the Engine page and the app keeps working.

Each model must have a license compatible with Apache-2.0 (code and weights): write it in `license`.
"""
from __future__ import annotations

import numpy as np

from app.detector_catalog import DetectorFamily
from app.embedders import TransformersEmbedder
from app.plugins import DETECTORS, EMBEDDERS, PROBES, option
from app.probes import ProbeTrainer
from app.segmenter import PromptableSegmenter  # noqa: F401  (subclass it for a SAM-like model, see segmenter.py)


# 1. An embedder: any Hugging Face vision backbone in ~15 lines. ONNX export and PyTorch fallback are inherited.
@EMBEDDERS.register
class ConvNextEmbedder(TransformersEmbedder):
    id = "convnext"
    title = "ConvNeXt"
    summary = "A convolutional ImageNet backbone: global average of the last feature map."
    license = "Apache-2.0"
    models = (option("facebook/convnext-tiny-224", "ConvNeXt tiny", "Apache-2.0"),)
    default_model = "facebook/convnext-tiny-224"
    graph_name = "embedding-convnext"   # the exported ONNX file (per checkpoint)

    def backbone(self):
        from transformers import ConvNextModel

        return ConvNextModel.from_pretrained(self.model)

    def pool(self, out):
        return out.pooler_output          # (batch, dim); the L2 norm is added for you


# 2. A learner next to the kNN memory: must refit on ALL the examples every time (product rule 8).
@PROBES.register
class NearestCentroidTrainer(ProbeTrainer):
    id = "centroid"
    title = "Nearest class centre"
    summary = "Each class is the mean of its examples: very stable with few examples, no training loop."

    def fit(self, X, y, sample_weight, init=None):
        classes = np.unique(y)
        if len(classes) < 2:
            return None
        centres = np.stack([X[y == c].mean(axis=0) for c in classes])

        class Probe:
            pass

        p = Probe()
        p.classes, p.n, p.steps, p.use_geometry = classes, len(X), 1, False

        def predict_proba(Q):
            z = -((Q[:, None, :] - centres[None]) ** 2).sum(axis=2) * 5.0
            z -= z.max(axis=1, keepdims=True)
            e = np.exp(z)
            return e / e.sum(axis=1, keepdims=True)

        p.predict_proba = predict_proba
        p.has_bg = int(classes[0]) == 0
        p.train_acc = float((predict_proba(X).argmax(axis=1) == np.searchsorted(classes, y)).mean())
        return p


# 3. Another LibreYOLO family on the Training page. Check its license (code AND pretrained weights) first, then
#    try a short run: the Training page lists the families LibreYOLO has that Kweeto does not offer yet.
#    RF-DETR (Apache-2.0 for n / s / m) needs the extra package: pip install "libreyolo[rfdetr]".
DETECTORS.register(DetectorFamily(
    id="rfdetr", title="RF-DETR", prefix="LibreRFDETR", license="Apache-2.0", kind="transformer",
    summary="Roboflow's DINOv2-based detection transformer: fine-tunes well from few images. Not checked here.",
    sizes={"n": ("Nano", "Smallest RF-DETR."), "s": ("Small", "More accurate; GPU recommended.")}))

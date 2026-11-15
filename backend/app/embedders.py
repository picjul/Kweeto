"""Embedders: turn crops into L2-normalised vectors (Pixel's "eyes"). Registered in plugins.EMBEDDERS.

Built-in (all Apache-2.0):
- "dinov2": DINOv2. Vector = [CLS token, mean of patch tokens]: purely visual features, strong for telling
  objects apart by shape and texture. Crops are squashed to 224x224, never centre-cropped, so elongated objects
  stay whole.
- "siglip": SigLIP vision tower, pooled output.
- "hf":     any Hugging Face vision backbone or image-text model (its vision tower is used): pooled output when
            the model has one, else [CLS, mean of patch tokens]. Type the checkpoint in the Custom profile.
- "pixels": fake 16x16 RGB embedding for development/tests without torch.

Adding a model = subclassing `TransformersEmbedder` (or `Embedder` for anything else) and registering it:

    @EMBEDDERS.register
    class MyEmbedder(TransformersEmbedder):
        id, title, license = "mine", "My model", "Apache-2.0"
        models = (option("org/checkpoint", "My model base", "Apache-2.0"),)
        default_model = "org/checkpoint"

        def backbone(self):            # a torch.nn.Module taking pixel_values
            from transformers import AutoModel
            return AutoModel.from_pretrained(self.model)

        def pool(self, out):           # (batch, dim) float tensor, before the L2 norm
            return out.pooler_output

The real embedders run as ONNX graphs (runtime.py: the best execution provider available) or, as a fallback,
in PyTorch; both compute the same vector because the pooling and the L2 norm are part of the exported graph.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from . import runtime
from .config import EMBED_BATCH
from .plugins import EMBEDDERS, option


class Embedder:
    """Base class. Subclasses set the metadata and implement `embed`."""
    id = ""
    title = ""
    summary = ""
    license = ""
    models: tuple[dict, ...] = ()   # suggested checkpoints (plugins.option)
    default_model = ""
    needs_torch = True
    custom_model = True             # any checkpoint id may be typed in the Custom profile

    def __init__(self, model: str) -> None:
        self.model = model or self.default_model
        self.device = "cpu"

    @classmethod
    def available(cls) -> bool:
        """Can it run here (dependencies installed)?"""
        if not cls.needs_torch:
            return True
        import importlib.util

        return importlib.util.find_spec("torch") is not None and importlib.util.find_spec("transformers") is not None

    @classmethod
    def signature_of(cls, model: str) -> str:
        """Identity of the embedding space: vectors with different signatures can't be compared."""
        return f"{cls.id}:{model}"

    def load(self) -> None:
        """Loads the weights (called once, under the embedder lock)."""

    def embed(self, images: list[Image.Image]) -> np.ndarray:
        """(N, D) float32, L2-normalised rows."""
        raise NotImplementedError


class TransformersEmbedder(Embedder):
    """A Hugging Face vision model: preprocessing by its image processor, the network + pooling + L2 norm
    exported once to ONNX (fallback: PyTorch). Subclasses implement `backbone` and `pool`."""
    graph_name = "embedding"  # file name of the exported graph (per checkpoint): change it if `pool` changes

    def __init__(self, model: str) -> None:
        super().__init__(model)
        self._processor = None
        self._graph = None
        self._torch = None

    # ---- hooks
    def processor(self):
        from transformers import AutoImageProcessor

        return AutoImageProcessor.from_pretrained(self.model)

    def backbone(self):
        raise NotImplementedError

    def pool(self, out):
        raise NotImplementedError

    def preprocess(self, images: list[Image.Image]):
        return self._processor(images=images, return_tensors="pt")["pixel_values"]

    def input_size(self) -> int:
        return 224

    # ---- machinery
    def network(self):
        """backbone + pooling + L2 norm, as one torch module (what gets exported)."""
        import torch

        emb = self

        class Head(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.backbone = emb.backbone()

            def forward(self, pixel_values):
                feats = emb.pool(self.backbone(pixel_values=pixel_values)).float()
                return torch.nn.functional.normalize(feats, dim=-1)

        return Head().eval()

    def _export(self):
        def run(path):
            import torch

            n = self.input_size()
            runtime.export_onnx(self.network(), (torch.randn(2, 3, n, n),), path, ["pixel_values"], ["embedding"],
                                {"pixel_values": {0: "batch"}, "embedding": {0: "batch"}})
        return run

    def load(self) -> None:
        self._processor = self.processor()
        self._graph = self._torch = None
        if runtime.runtime() == "onnx":
            try:
                self._graph = runtime.graph(self.model, self.graph_name, self._export())
                self.device = runtime.label(self._graph.provider)
            except Exception as e:  # export or session failed: PyTorch still works
                runtime.note_fallback("embedder", f"{type(e).__name__}: {e}")
        if self._graph is None:
            self.device = _torch_device()
            self._torch = self.network().to(self.device)

    def embed(self, images: list[Image.Image]) -> np.ndarray:
        outs = []
        for s in range(0, len(images), EMBED_BATCH):
            pv = self.preprocess(images[s:s + EMBED_BATCH])
            if self._graph is not None:
                outs.append(self._graph.run({"pixel_values": pv.numpy().astype(np.float32)})[0])
            else:
                import torch

                with torch.inference_mode():
                    outs.append(self._torch(pv.to(self.device)).cpu().numpy())
        return np.concatenate(outs).astype(np.float32)


def _torch_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _cls_mean(out):
    import torch

    tok = out.last_hidden_state.float()
    return torch.cat([tok[:, 0], tok[:, 1:].mean(dim=1)], dim=-1)


@EMBEDDERS.register
class Dinov2Embedder(TransformersEmbedder):
    id = "dinov2"
    title = "DINOv2"
    summary = "Self-supervised visual features (Meta): strong on shape and texture. [CLS, mean of patches]."
    license = "Apache-2.0"
    models = (option("facebook/dinov2-small", "DINOv2 small", "Apache-2.0", "the light/balanced profiles"),
              option("facebook/dinov2-base", "DINOv2 base", "Apache-2.0"),
              option("facebook/dinov2-with-registers-small", "DINOv2 small + registers", "Apache-2.0"))
    default_model = "facebook/dinov2-small"

    def processor(self):  # squashed, never centre-cropped: elongated objects stay whole
        from transformers import AutoImageProcessor

        return AutoImageProcessor.from_pretrained(self.model, do_center_crop=False, size={"height": 224, "width": 224})

    def backbone(self):
        from transformers import AutoModel

        return AutoModel.from_pretrained(self.model)

    def pool(self, out):
        return _cls_mean(out)


@EMBEDDERS.register
class SiglipEmbedder(TransformersEmbedder):
    id = "siglip"
    title = "SigLIP"
    summary = "Google's image-text model, vision tower only: pooled output."
    license = "Apache-2.0"
    models = (option("google/siglip-base-patch16-224", "SigLIP base", "Apache-2.0", "the accurate profile"),)
    default_model = "google/siglip-base-patch16-224"

    def backbone(self):
        from transformers import SiglipVisionModel

        return SiglipVisionModel.from_pretrained(self.model)

    def pool(self, out):
        return out.pooler_output


@EMBEDDERS.register
class HFEmbedder(TransformersEmbedder):
    """Any Hugging Face vision checkpoint: a vision backbone, or an image-text model whose vision tower is used."""
    id = "hf"
    title = "Any Hugging Face model"
    summary = ("Type a checkpoint: vision backbones (ViT, DINOv2, ConvNeXt...) or image-text models (SigLIP 2, "
               "CLIP...). Pooled output when there is one, else [CLS, mean of patches]. Check its license.")
    license = "depends on the checkpoint"
    models = (option("google/siglip2-base-patch16-224", "SigLIP 2 base", "Apache-2.0"),
              option("facebook/dinov2-base", "DINOv2 base", "Apache-2.0"),
              option("facebook/dinov2-with-registers-base", "DINOv2 base + registers", "Apache-2.0"))
    default_model = "google/siglip2-base-patch16-224"
    graph_name = "embedding-hf"

    def backbone(self):
        from transformers import AutoModel

        m = AutoModel.from_pretrained(self.model)
        return getattr(m, "vision_model", None) or m  # image-text model: its vision tower

    def network(self):
        import torch

        emb = self

        class Head(torch.nn.Module):  # same as the base, plus spatial pooling for convolutional backbones
            def __init__(self):
                super().__init__()
                self.backbone = emb.backbone()

            def forward(self, pixel_values):
                out = self.backbone(pixel_values=pixel_values)
                hs = getattr(out, "last_hidden_state", None)
                pooled = getattr(out, "pooler_output", None)
                if pooled is not None and pooled.dim() > 2:
                    pooled = pooled.flatten(1)
                if pooled is None and hs is not None and hs.dim() == 4:
                    pooled = hs.mean(dim=(2, 3))
                feats = pooled if pooled is not None else _cls_mean(out)
                return torch.nn.functional.normalize(feats.float(), dim=-1)

        return Head().eval()


@EMBEDDERS.register
class PixelsEmbedder(Embedder):
    """16x16 RGB thumbnail, centred and normalised: development and tests without torch."""
    id = "pixels"
    title = "Pixels (test)"
    summary = "A 16x16 colour thumbnail as the vector: no model, no torch. For development and tests only."
    license = "n/a"
    needs_torch = False
    custom_model = False

    @classmethod
    def signature_of(cls, model: str) -> str:
        return "pixels"

    def embed(self, images: list[Image.Image]) -> np.ndarray:
        vecs = []
        for im in images:
            a = np.asarray(im.resize((16, 16), Image.BILINEAR), dtype=np.float32).reshape(-1) / 255.0
            a = a - a.mean()
            n = float(np.linalg.norm(a)) or 1.0
            vecs.append(a / n)
        return np.stack(vecs).astype(np.float32)

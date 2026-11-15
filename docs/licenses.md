# Model and dependency licenses

[← Back to the README](../README.md).

Everything Kweeto downloads or depends on is under a license compatible with Apache 2.0 (checked on the model
cards and package metadata):

| Component | License |
|---|---|
| `facebook/dinov2-small` (DINOv2) | Apache-2.0 |
| `google/siglip-base-patch16-224` (SigLIP) | Apache-2.0 |
| `facebook/sam-vit-base` (SAM) | Apache-2.0 |
| `nielsr/slimsam-77-uniform` (SlimSAM) | Apache-2.0 |
| `facebook/sam2.1-hiera-tiny` (SAM 2.1) | Apache-2.0 |
| transformers, huggingface_hub, safetensors, tokenizers, python-multipart, torch | Apache-2.0 (torch: BSD-style + Apache-2.0) |
| torchvision, numpy, uvicorn, httpx | BSD-3-Clause |
| fastapi, sqlalchemy, faiss-cpu, truststore, pytest | MIT |
| Pillow | MIT-CMU (HPND) |
| Next.js, React, Tailwind CSS, Radix Slot, clsx, tailwind-merge | MIT |
| lucide-react | ISC |
| three.js, React Three Fiber, drei (3D Pixels) and their dependencies | MIT (a few ISC / Apache-2.0 / BSD-3-Clause) |
| onnxruntime (all variants: CPU, DirectML, GPU, OpenVINO), onnxscript | MIT |
| onnx | Apache-2.0 |
| libreyolo (detector training) | MIT |
| LibreYOLO pretrained weights: YOLOv9 t/s/m · YOLOX n/s, RTMDet t/s, D-FINE n/s, DEIM n/s, RT-DETRv2 r18/r34 | MIT · Apache-2.0 (families with restrictive weights are not offered) |
| opencv-python, pycocotools, scipy, PyYAML, typer, mss, cloudpickle (libreyolo dependencies) | Apache-2.0 (OpenCV; its wheels bundle LGPL libraries), BSD, MIT |
| class-variance-authority, TypeScript | Apache-2.0 |
| Plus Jakarta Sans (font) | SIL OFL 1.1 |

Datasets you benchmark with keep their own license and are never copied into the repository.

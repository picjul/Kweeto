# Changelog

All notable changes to Kweeto. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/): from 1.0 on, the HTTP API, the plugin interfaces
(`app.plugins` registries, `TransformersEmbedder`, `PromptableSegmenter`, probes, detector families) and the project
folder layout only change in a backwards-compatible way within a major version.

## [1.0.0] - 2026-11-15

First stable release. Everything below is new compared with the earlier, unversioned snapshots.

### Teaching
- **Lesson** with a big zoomable canvas (wheel zoom up to 16x, minimap, pan), click-to-box with SAM, box snapping,
  move/resize handles, undo/redo, focus mode and full keyboard control.
- **Propagation**: every gesture re-evaluates the whole dataset; the images that change (⚡) are attributed to the
  gesture that caused them.
- **Harvest** of confident guesses grouped by origin, with hidden checks; **Apprentice Questions** (few examples,
  never-seen images, confused classes).
- **Honest confidence**: words (sure / maybe / guess) backed by the real track record, never a raw percentage.
- **Lesson recap, before / after**: Pixel's judged guesses at the start vs the end of a lesson, and the images where
  it changed its mind.

### Data
- **Projects**, one per dataset, each with its own Pixel.
- **Import** of existing datasets: COCO, YOLO, Pascal VOC, Label Studio and CVAT, with a preview before anything is
  imported.
- **Dataset health**: class balance, near-duplicate images, and a hunt for label errors (boxes that look like another
  class, odd sizes, double boxes, slips).
- **Export** to COCO, YOLO (+ segmentation), Pascal VOC, CSV and PNG masks.
- One-click **demo project** with a guided tour.

### Engine
- Ingest scan (multi-granularity segments + merged fragments), kNN + linear probe with a learned background class,
  instance selection (pile vs broken object).
- Engine profiles `light` (default), `balanced`, `accurate` and `custom`; **ONNX Runtime** as the standard inference
  runtime (CPU, DirectML, CUDA, TensorRT, OpenVINO, CoreML...) with a PyTorch fallback.
- **Detector training** with LibreYOLO (YOLOv9, YOLOX, RTMDet, D-FINE, DEIM, RT-DETRv2), used as Pixel's second
  opinion; Pixel suggests training one when its guesses stop improving.
- **Plugins** for embedders, segmenters, learners, detector families and profiles.
- Learning benchmark (`bench.simulate`) with a simulated teacher and held-out curves.

### Interface
- 3D Pixels that grow with the project (egg → sage), playground home, light and dark themes, synthesised sounds,
  command palette (`Ctrl K`), Pixel's shareable card, WCAG AA contrast and screen-reader support.

### Security
- Docker Compose publishes the app on `127.0.0.1` only (it has no authentication); see `SECURITY.md`.
- Other websites open in the same browser can no longer change data: requests that modify anything need the
  `X-Kweeto` header sent by the app's own pages (CSRF protection).
- Requests for unknown host names are refused by the backend and the frontend server (DNS-rebinding protection,
  `KWEETO_ALLOWED_HOSTS`).
- Image URLs can no longer reach files outside the project folder (a drive letter in the name on Windows).

### API
- `GET /api/health` is a liveness probe (used by the Docker `HEALTHCHECK`); the dataset health report is at
  `GET /api/dataset-health`.


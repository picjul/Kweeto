# Kweeto: notes for Claude Code

Loaded at the start of every session. It holds the context needed to pick the work up without the original conversation.

> Product/strategy documents live in `documentation/`, which is **private and git-ignored**. Never commit `documentation/`
> or strategic content, and never commit personal data (names, e-mails, local paths, machine details).
> If `documentation/` is missing, work from the information below.

## What it is

Kweeto is an image-annotation tool for computer vision that **does not compete on automation** but on the
**annotator's experience**: annotating becomes teaching an AI apprentice called **Pixel**.
Product thesis: *"every correction is worth 30 labels, and you can see it"*. The metaphor is the tone; the leverage is the point.

Code, UI, Pixel's messages and documentation are in **English**.

## Current state

- ✅ **Version 1.0.0** (2026-11-15), **Apache-2.0** (`LICENSE`, `NOTICE`, copyright "The Kweeto authors": never a real
  name). One version: `backend/app/__init__.py` `__version__` = `frontend/package.json` (+ lockfile root) =
  `NEXT_PUBLIC_KWEETO_VERSION` (next.config.ts, shown at the bottom of the Engine page); bump all three and add a
  `CHANGELOG.md` entry. From 1.0 the HTTP API, plugin interfaces and project folder layout follow semver.
  `GET /api/health` = liveness (Docker HEALTHCHECK); the dataset report is `/api/dataset-health`.
  CI `.github/workflows/ci.yml`: light install (no torch) + `ruff check .` (`backend/ruff.toml`) + pytest, `tsc` + build.
  `CONTRIBUTING.md`, `SECURITY.md` (no auth: Docker Compose publishes on 127.0.0.1 only), issue/PR templates.
  **Cross-site guards** (`main.py`): non-GET browser requests (Origin or Sec-Fetch-Site present) need `X-Kweeto: 1`
  (sent by `req()` in `lib/api.ts` for non-GET; any new client code that changes data must go through `req()`);
  `TrustedHostMiddleware` + `frontend/src/middleware.ts` = `KWEETO_ALLOWED_HOSTS` (tests: `tests/conftest.py` adds
  `testserver`; the benchmark too); `_file` refuses `:` (Windows drive) and anything but a plain name. `tests/test_security.py`.
  The 1.0 is published from another repository (the user's call); the old GitHub repo (TeachMe) is not the release one.
- ✅ Backend (FastAPI + SQLite + SigLIP/FAISS) complete; `pytest` passes (55 tests; 4 need real models and are skipped
  without torch), including end-to-end runs with the fake embedder.
- ✅ Frontend (Next.js 15): `tsc` and `next build` pass. Sidebar layout, light/dark themes, "wow" visual layer,
  playful-but-honest Pixel interactions (gaze, poke, combo, level-up, confetti). Demo GIF re-recorded with the new UI.
- ✅ Pipeline = **Ingest** (once/image: multi-granularity segments + merged fragments → `regions`) → **Learning**
  (after every gesture: kNN + linear probe **with a background class**, refitted on all examples, warm-started) →
  **Prediction** (class × familiarity × objectness, then `engine.select_instances`: pile vs broken object).
  Modules: `regions.py` (candidates), `learning.py` (examples, probe cache, size priors, track record), `engine.py`.
- ✅ "Not an object" is learned from **verified** images (Lesson "Save & next" → `verifications` table): unboxed regions
  that are parts (inside a box), groups (contain ≥2 boxes) or clutter. Harvest boxes do NOT verify an image.
- ✅ Honest confidence: `outcomes` table (every judged guess, hidden checks excluded) → levels sure/maybe/guess +
  "right N of M lately" (`pixel.track_line`), never a raw %. Home compares first vs latest judged guesses.
- ✅ **Projects** (`app/workspace.py` registry + Pixel traits, `app/projects.py` open/delete, `routers/projects.py`,
  `/projects` page): one folder per dataset under `DATA_DIR/projects/<id>/` with its own DB, images, `engine.json` and
  Pixel (name, colour = UI accent via `--pixel`, shape, eyes, accessory). One active project; `db.SessionLocal()` and
  `workspace.images_dir()` always point at it. Legacy `data/teachme.db` is migrated to "My project" on start.
  Deleting images: `services.delete_images` (rows, vectors, files); deleting a project hides it at once and removes
  the folder when Windows releases the files. Frontend: `components/project-context.tsx` (`useProject`,
  `usePixelTraits`), `pixel-editor.tsx`; `PixelAvatar` takes `traits` or the active project's.
- ✅ **No default project**: start-up re-opens the last project (or the migrated legacy one), otherwise none; deleting
  the open project leaves none open (`projects.close_project`). Project endpoints then raise `db.NoProjectOpen` → 409
  `{"code": "no_project"}`; the shell gates project pages (`NO_PROJECT_PAGES` = Home, Projects).
- ✅ **Playground** = `/` alone, full screen, no sidebar (`components/playground.tsx`; the shell bypasses `/`): one
  R3F scene (walker at distance z → `position.z = -z`), ground + grid + hills + instanced flowers, low-poly trees/rocks,
  sun with real shadows, fog into the CSS sky, 3D egg, mouse parallax on the camera; Pixels turn to walk, face each
  other to chat and face the camera when idle; labels/bubbles via drei `Html`; sr-only buttons for keyboard. Pixels meet and say TRUE facts (`facts()`). Hover = card,
  click = open the project → `/overview` (the project dashboard, `app/overview/page.tsx`). Egg = `/projects?new=1`.
- ✅ **3D Pixels** (`components/pixel3d.tsx`, three.js + @react-three/fiber + drei, all MIT): `PixelModel` = procedural
  character (rounded body per shape, visor whose face is a canvas texture redrawn from the same drawings as the SVG
  face: blink, gaze; arms, feet, antenna sprouts, 3D accessories, egg shell / badge / crown per stage, mood gestures and
  extras, walk cycle, jump, poke squish). `PixelAvatar` uses it from 72 px up (`render="auto"|"2d"|"3d"`) on its own
  small transparent canvas (`Pixel3DCanvas`, lazy chunk, SVG = placeholder + fallback, max 8 live WebGL contexts);
  smaller avatars stay SVG. No HDR downloads: lighting = local `Lightformer`s. R3F's default camera looks at the
  origin: pass `rotation` when framing by position.
- ✅ **Growth stages** (`pixel.tsx` `stageOf`/`STAGES`): baby 1-2 (egg shell), child 3-4, teen 5-6, adult 7-9 (badge),
  sage 10+ (crown); level = `levelFromBoxes`. `PixelAvatar` defaults to the open project's live level (context
  `activeBoxes`); pass `level` for other projects' Pixels. Mood body language: `.mood-*` CSS on an inner wrapper.
- ✅ **Sounds** (`lib/sound.ts`): Web Audio synthesised cues, per-Pixel voice (`voiceOf`), toggle `SoundToggle`
  (localStorage `kweeto-sound`), only after a user gesture, `minGapMs` throttle in the field.
- ✅ **Exports** (`app/export.py`, `routers/exports.py`, `/export` page): COCO, YOLO (+ `yolo-seg`), Pascal VOC, CSV,
  PNG masks; background job with progress, zip in `<project>/exports/`. Masks = segmenter inside each box
  (`segmenter.mask_in_box`: single SAM mask first, then the 3 proposals; clipped to the box; box fallback if IoU<0.5),
  polygons via `geometry.mask_polygons` (Moore tracing + RDP, no OpenCV), cached in `box_masks`. EXIF-rotated images are re-encoded upright in the zip.
- ✅ Engine **profiles** (`app/profiles.py`, Engine page): `light` (DINOv2-small + SlimSAM-77, 6×6+16 prompts, **default**: best trade-off on a CPU),
  `balanced` (DINOv2-small + SAM 2.1 tiny, 8×8+24), `accurate` (SigLIP base + SAM base, 12×12+32).
  `DATA_DIR/engine.json` records which models built the data; `services.sync_engine` re-scans (segmenter changed) or
  also re-embeds boxes (embedder changed) at start-up and on switch. Env vars still override single fields.
- ✅ **ONNX Runtime = standard inference** (`app/runtime.py`): `KWEETO_RUNTIME=auto|onnx|torch`, `KWEETO_EP=auto|cpu|cuda|
  tensorrt|dml|coreml|openvino|rocm|migraphx` (auto skips TensorRT and CoreML), graphs exported once from the PyTorch weights
  (`torch.onnx.export`, `dynamo=False`, opset 18) into `KWEETO_ONNX_DIR` (default `DATA_DIR/onnx`, file name has
  `EXPORT_VERSION`: bump it when a wrapper changes). Embedder = one graph (backbone + head + L2 norm); SAM v1 = encoder +
  one decoder per prompt kind (`decoder-{p,b,pb}-{multi,single}`); SAM 2 stays on PyTorch. Any export/session failure
  falls back to PyTorch (`runtime.note_fallback`, shown on the Engine page). DirectML needs serialised runs (`Graph` lock).
  Parity: cosine >= 0.99999, identical boxes/masks; bench `light` identical on ORT-CPU, DirectML differs by one object at
  10 lessons (GPU float order), same at 20; 229 s (torch CPU) -> 53-62 s (DirectML). `tests/test_runtime.py`; the real-model
  parity test runs with `KWEETO_TEST_MODELS=1`. Requirements: `onnxruntime-directml` on win32, `onnxruntime` elsewhere.
- ✅ **Detector training** (`app/detector.py`, `app/detector_job.py`, `routers/training.py`, `/training` page): LibreYOLO
  (MIT) YOLOv9 t/s/m + YOLOX n/s, on command. Dataset = ONLY verified images (complete annotation; unfinished ones would
  teach unboxed objects as background), YOLO format with upright images (`export._image_bytes`), deterministic 80/20
  split, min 10 images. One run at a time, subprocess at below-normal priority (`python -m app.detector_job <dir> train|
  resume|export`), status in `<project>/training/<run>/status.json` (epoch, history mAP50/mAP50-95, ETA), `eval_interval=1`,
  stop = terminate (last.pt every epoch; best.pt else last.pt), resume, ONNX export at the end or on download. Weights in
  `DATA_DIR/libreyolo` (truststore injected in the job). LibreYOLO's 'metrics/precision' equals mAP50-95: show mAP only.
  Trains on CUDA/MPS/CPU (no DirectML for training); inference of the exported ONNX can use our runtime (DirectML parity
  checked: 16/16 identical, 29 ms vs 142 ms torch-CPU). While a run is live Pixel works out (`activity` prop: dumbbells
  "lift" / "run", sweatband, sweat, `effort` face) on the Training page and in the Playground. Active detector per
  project (`<project>/training/active.json`, `app/detector_infer.py`, "Use in Kweeto" on a run): runs on our ONNX runtime
  (LibreYOLO OnnxBackend with its session swapped for `runtime.Graph`), classes mapped by NAME, results cached; shown on the
  image page (views Pixel / Detector / Both + panel). Scores are uncalibrated: plain numbers, never %, threshold 0.1 (faint
  under 0.3). Plateau advice (`detector.suggestion`, in `/api/stats` -> `suggestion`, Pixel's home line + Overview card):
  when the last 3 blocks of 30 judged guesses (outcomes; counted only AFTER the last training started, job.json
  `outcomes_at_start`, or after "Not now", `training/suggestion.json`) still have >= 10% errors and dropped by < 5 points,
  Pixel says so with the real numbers and proposes a detector (or finishing images first). Phase 2 (done):
  the active detector is Pixel's **second opinion** (`settings.use_detector`, default ON, weight/veto 0.3). The worker
  (`_detector_pass`) runs it once per `embedded` image (tables `detections` + `detector_scans`, per run) and adds a
  `Region(kind="detect")` (store `KIND_DETECTOR`) where a box with score >= 0.25 has no window at IoU >= 0.8.
  `engine.predict(detections=...)`: matched box (IoU >= 0.5) pulls class + objectness by weight x score, other class =
  x0.75, scanned but nothing = objectness x (1 - veto); familiarity untouched (never proposes on the detector alone).
  Off = identical to before (detect regions are not candidates; they are never learning examples). `proposal.detector`
  = its opinion, shown in the Lesson. Bench (`--detector`, `--detector-variants`): light/real models, held-out F1
  0.94 -> 0.99 and 0.91 -> 0.98 (2 seeds), gain mostly from the extra regions (ceiling 0.87-0.89 -> 0.96).
- ✅ **Annotation canvas** (`components/box-canvas.tsx`): fitted viewport with zoom (wheel around the pointer, `+`/`-`/`0`,
  up to 16×) and pan (Space+drag / middle button; left drag when `readOnly`), minimap. The zoomed layer is laid out at its real
  size (NOT a CSS `scale`: sub-pixel borders would be rounded up and look thick). Click a box = select (Alt+click = magic box);
  selected box: move/resize handles, floating toolbar (class, zoom to box, delete). Lesson page (`/annotate`, full width in
  the shell): undo/redo (Ctrl+Z/Y, history of boxes + rejected guesses per image), arrows nudge, Tab cycles boxes, H hides
  guesses, F focus mode (canvas fixed full screen), box list with per-box class menu ("was X" when Pixel's class was corrected).
- ✅ **Extensible models** (`app/plugins.py`): registries `EMBEDDERS`, `SEGMENTERS`, `PROBES`, `DETECTORS`, filled by the
  built-ins (`embedders.py`, `segmenter.py`, `probes.py`, `detector_catalog.py`) and by plugins (`backend/plugins/*.py`,
  `_`-prefixed skipped; `KWEETO_PLUGINS` modules); a failing plugin is listed on the Engine page, never fatal.
  `embedder.py` / `segmenter.py` module functions are facades over the active profile's component (same API as before).
  Embedders: `TransformersEmbedder` (backbone + pool exported with the L2 norm as one ONNX graph, `graph_name`), built-ins
  dinov2, siglip, `hf` (any HF checkpoint; image-text models use their vision tower), pixels. Segmenters:
  `PromptableSegmenter` (encode once + `decode_raw`; auto scan, click, box mask shared), built-ins sam (ONNX), sam2, simple.
  Signatures come from the components (`signature_of`, `scan_signature_of`) and are byte-identical to the old ones for
  the built-ins (no re-scan of old projects: tested). Profile `custom` (any registered embedder + segmenter + checkpoints,
  saved in engine.json `custom`), `profiles.register_profile` for plugins. Probes: `settings.probe` (`linear` default,
  `mlp` one hidden layer, numpy, deterministic, refit on all examples + warm start; bench: = linear on real models,
  0.775 vs 0.759 at 3 lessons, 1.000 vs 0.979 at 10 lessons synthetic). LibreYOLO: `detector_catalog` =
  curated families (license of code AND weights checked) verified end to end (1-epoch job, ONNX export, inference):
  YOLOv9 t/s/m, YOLOX n/s, RTMDet t/s, D-FINE n/s, DEIM n/s, RT-DETRv2 r18/r34 (`fixed_imgsz=640`: exports only at
  640). `not_offered()` lists the other trainable LibreYOLO families (licenses to check: YOLO-NAS non-commercial, YOLOv7
  GPL, EC, DEIMv2 l/x DINOv3 license...). RF-DETR needs `libreyolo[rfdetr]` (example plugin). Model ids stay
  "<family>-<size>".
- ✅ Segmenter (`app/segmenter.py`): SAM v1 family / SAM 2 (one code path: encode once, batched prompts, boxes from
  256 px masks, second pass only on uncovered areas) or torch-free `simple` (splits touching objects: distance peaks + seams).
  On CPU the mask decoder costs ~50 ms/prompt whatever the model: the prompt count matters more than the model.
- ✅ Measured scan speed (CPU, no GPU): `light` ~5.6 s/image, `balanced` ~8.4 s, `accurate` ~15 s. Do not name or describe
  any real dataset used for local testing in tracked files (README, CLAUDE.md, code): keep such details in the private `documentation/`.
- ✅ **Learning benchmark** `backend/bench/` (simulated teacher, held-out curve, touching/broken recall, segmentation ceiling,
  COCO input). Fake embedder: F1 0.70 → 0.99 in 25 lessons; regression-tested by `tests/test_learning.py`.
- ✅ **Import** (`app/importer.py`, `routers/imports.py`, `/import`): staging area `<project>/imports/<id>/` (files sent with
  their relative path as name, zips extracted with sanitised paths), `preview` = detected formats (COCO, YOLO + data.yaml/
  classes.txt, VOC, Label Studio full/MIN, CVAT for images) + matching (staged path suffix, LS `8hex-` prefix stripped, YOLO
  labels/→images/ by stem, else project images by file name; staged images hashed: already-present ones are not added
  twice), `commit` = background job. Boxes `source="import"` (examples, rule 1 = human labels from another tool; LS
  predictions and COCO crowd skipped). `complete` (default on) verifies images with boxes; empty records verified only
  with `empty_negative`. Images that already have boxes keep them. px boxes on the raw size of an EXIF-rotated photo are
  rotated (`_orient`). The worker now sets pending images with boxes/verification to `annotated`. `services.store_image`.
- ✅ **Health** (`app/health.py`, `routers/health.py`, `/health`): balance, near-duplicates (dHash of the thumbnail <= 6
  bits, confirmed by 32x32 grey MAD <= 4; cached per stored_name), suspects: `looks_like` (leave-one-out kNN on box vectors,
  K=30: N boxes of another class before the first of its own, N >= min(5, max(3, n_other//3)), own class >= 3 boxes),
  `size` (robust z of log area >= 3.5 and >= 8x), `double`/`conflict` (IoU >= 0.85), `tiny` (< 3 px). Dismissals in
  `health_dismissals`; routes `/api/dataset-health[/dismiss|/restore]`; `PATCH /api/boxes/{id}` = correct event +
  recompute; `DELETE /api/boxes/{id}`.
- ✅ **Lesson recap** (`app/sessions.py`, `/recap?s=`): `lesson_sessions` row created/resumed by the Lesson (sessionStorage
  `kweeto-lesson:<project>`), snapshot of guesses on `embedded` images + event/outcome id ranges. Accuracy = first vs
  last block (<= 10) of outcomes in the session (>= 10 judged), else last ones before vs during (>= 5), else none. Changed
  images = snapshot vs current proposals on images still `embedded`. `end` freezes the recap in `summary`. Overview shows
  the last one. Pixel lines in `pixel.py` (`import_line`, `health_*`, `recap_line`).
- ⚠️ Real models (SigLIP + SAM) measured only on synthetic scenes so far (see README); needs a real labelled dataset.

Suggested next steps:
1. Run `bench.simulate --coco` on a real labelled dataset; compare SigLIP vs DINOv2, segments vs windows, with/without background.
2. Fragments of 3+ pieces (unions are pairs only); SAM-prompted re-segmentation where the probe fires but no region exists.
3. "Boundary" question; class suggestion for hand-drawn boxes; health on real models (tune `looks_like` thresholds).
4. VLM "learning by examples" (provider: none/local/api); import from a server-side folder path (huge datasets).

## Running

```powershell
.\scripts\setup.ps1            # venv + backend deps + frontend deps + .env.local  (-Light skips torch)
.\scripts\dev.ps1              # backend on :8000 and frontend on :3000 in two windows (-Fake = fake embedder)
```

Or double-click `scripts\dev.bat` (`fake` argument = fake embedder). macOS/Linux/Git Bash: `./scripts/setup.sh [--light]`,
then `./scripts/dev.sh [--fake]` (both servers in one terminal, Ctrl+C stops both, including npm's child processes).

Docker: `docker compose up -d` (one container, `Dockerfile` + `docker/entrypoint.sh`: uvicorn on 127.0.0.1:8000 inside,
Next.js standalone on :3000; built with `KWEETO_STANDALONE=1` + empty `NEXT_PUBLIC_API_URL`, so `next.config.ts`
rewrites `/api` and `/files` to the backend; volumes `/data` and `/models` = `HF_HOME`; `--build-arg TORCH=none` =
light image, the entrypoint then defaults to embedder `pixels` + segmenter `simple`). Docker is not installed on the
dev machine: the image itself was never built here (the standalone build + proxy were tested locally).

Tests: `cd backend; $env:KWEETO_EMBEDDER="pixels"; .\.venv\Scripts\python.exe -m pytest -q` (run from `backend/`);
lint: `python -m ruff check .` (ruff is in requirements-dev.txt; install it in the venv once).
Learning benchmark: `cd backend; .\.venv\Scripts\python.exe -m bench.simulate` (add `--embedder siglip --segmenter sam --size 640x480` for real models).
Frontend: `cd frontend; npx tsc --noEmit; npm run build`.
Demo GIF, README pictures, promo video: local-only tooling outside the repo (git-ignored `scripts/demo/`),
documented in the private `documentation/05-demo-assets.md`.

## Architecture in short

- **Backend** `backend/app/`: `main.py` (lifespan: create DB, load vector store into RAM, start worker), `engine.py` (kNN with rejection and negatives, FAISS with numpy fallback, k-means),
  `services.py` (`recompute()` = re-learn + full recomputation of proposals; the **delta** is the ⚡ propagation, attributed to the originating event),
  `regions.py` (ingest candidates), `learning.py` (training set, probe, track record), `worker.py` (scan thread; also re-scans images
  without regions after `/api/rescan`), `questions.py`, `pixel.py` (Pixel's voice), `routers/`.
- **Frontend** `frontend/src/`: pages in `app/` (Home, Upload, Gallery, Detail, Lesson `/annotate`, Questions, Harvest `/batch`, Engine `/settings`),
  components in `components/` (`pixel.tsx` = SVG avatar with moods, `box-canvas.tsx`, `batch-group.tsx`, `question-card.tsx`, `class-path.tsx`), typed API client in `lib/api.ts`.
- Box coordinates are **normalised 0..1**. Images are served by the backend under `/files/images` and `/files/thumbs`.

## Rules (product decisions)

1. **No feedback loop**: the kNN learns ONLY from human-confirmed boxes (`boxes`), never from `proposals`.
2. **Pixel is honest**: every Pixel sentence maps to a real model event. No fake emotions or progress, no uncalibrated error estimates.
   Messages are deterministic templates in `backend/app/pixel.py`.
3. **The ⚡ counter only counts** images whose proposal actually changed above threshold.
4. **Hidden checks** in the Harvest are proposals with `is_control=True` pointing at `kind="box"` regions. They must never become boxes
   (the server also recognises them by region kind). The client must not know which items are checks.
5. **No guilt** (no streaks, no "you abandoned me"), **keyboard first** (one-key shortcuts), low verbosity.
6. Prefer simplicity and speed of implementation. Single user, local only.
7. **Engine changes are judged by the benchmark** (`bench.simulate`), not by feel: report the held-out curve before/after,
   and check the segmentation ceiling first when a recall metric is stuck. Keep `tests/test_learning.py` green.
8. The probe is always **refitted on all examples** (warm start for speed), never order-dependent `partial_fit`: deleting an
   example must be able to unlearn it.

## UI style (aim: a "wow" UI, visually and functionally)

- Layout: `components/app-shell.tsx` = sidebar grouped Overview / Teach (Lesson, Harvest, Questions) / Data (Gallery, Upload) / Settings (Engine),
  live Harvest badge, Pixel card with level bar and theme toggle; top bar on mobile. Page titles via `components/page-header.tsx`.
- Themes: light/dark/system via CSS variables in `globals.css` (`:root` and `.dark`), `lib/theme.ts` (inline init script = no flash),
  `components/theme-toggle.tsx` (`ThemeToggle`, `ThemePicker`). Never hard-code `bg-white`: use `bg-card`/`bg-muted` or add `dark:` variants.
- Palette: violet `--pixel` for primary actions, amber for ⚡, emerald for the Harvest; dotted-grid background; dark annotation canvas (`.canvas-grid`).
  Font: Plus Jakarta Sans (`next/font`). Effects: `.aurora` blobs (`components/fx.tsx` `Aurora`), `.glass`, `.text-gradient`, `.lift`, `.stagger`, `CountUp`.
- Pixel (`components/pixel.tsx`): `PixelAvatar` (moods `idle|happy|curious|thinking|surprised|sleepy|proud`, eyes follow the pointer,
  `bounce` prop = jump, `onPoke` = clickable squish), `PixelSays` (typewriter bubble), `PixelBurst` (pixel confetti), `pokeLines()` (truthful fun facts from stats).
  Fun but honest: combo = consecutive correct top guesses in a Lesson; level-up toast in the shell; confetti on big propagations and caught checks.
- Navigation feedback (`components/nav-progress.tsx`, mounted in `app/layout.tsx`): top progress bar started on link
  clicks (capture listener), back/forward and `navStart()` (call it before every `router.push`), finished when the
  pathname/search changes; `html.nav-pending` = progress cursor; `LinkPending` (`useLinkStatus`) = spinner inside sidebar
  links. Page waits use `components/page-loading.tsx` (`PageLoading`, also `app/loading.tsx`).
- Command palette (`components/command-palette.tsx`, mounted in the layout; `openPalette()`): pages, actions, projects,
  images by name (`/api/images?q=`, literal LIKE with `!` escape). Input uses `autoFocus` (keys typed right after Ctrl+K
  must not be lost). Pixel's card (`components/share-card.tsx`, `openShareCard()`): canvas 1200x630 from the 2D SVG avatar
  (serialised) + /api/stats numbers only.
- Accessibility: readable accent = `lib/contrast.ts` (`readableAccent`): `--pixel` fill (nudged <=5 pts for white text,
  else lightened for near-black), `--pixel-on` (text on fills; CSS `.bg-pixel.text-white`), `--pixel-fg` (Tailwind
  `text-pixel` = accent as text, AA on bg + cards). Recomputed per project in `project-context.applyAccent`. Skip link,
  `main#content`, `aria-current`, `:focus-visible` outline. Lesson keyboard: canvas is `role="application"` with
  `data-canvas` (Tab cycles boxes only when the canvas ITSELF has focus, then moves focus out), N new box, Ctrl+arrows
  resize, G cycles guesses (A/X act on the highlighted one), `say()` -> sr-only aria-live region. Never use
  `text-white/NN` on `bg-pixel` (not covered by the readable colour).
- UI tests while the user's `dev.ps1` may run: `KWEETO_DIST_DIR=.next-test NEXT_PUBLIC_API_URL=http://127.0.0.1:8100
  npx next build` + `next start -p 3100` and a backend on :8100 with a temp `KWEETO_DATA_DIR` (and `KWEETO_CORS`);
  `next build` rewrites tsconfig.json/next-env.d.ts for the dist dir: `git checkout` them afterwards.
- Demo + tour: `app/demo.py` (`POST /api/projects/demo`): 36 scenes from `app/demo_scenes.py` (moved from bench/scenes.py,
  which now re-exports it: the Docker image only ships app/), classes tomato/lime/pipe, custom profile = default
  embedder (pixels without torch) + `simple` segmenter: ready ~25 s after the click on this laptop (DirectML), first
  guesses after ONE taught image. `components/demo.tsx` (`DemoButton`, `useStartDemo`), `components/tour.tsx` (steps on
  `data-tour` anchors / `[data-canvas]`, localStorage `kweeto-tour`; steps that need an action wait for
  `tourEvent("box"|"saved"|"guesses")` emitted by the Lesson, so the tour never claims what did not happen).
  `services.next_image` returns "waiting" (not "done") while images are still pending: the Lesson waits and polls.
  The shell polls /api/stats and the playground /api/training only with an open project (no 409s on a first launch).
- All animations are disabled under `prefers-reduced-motion`.
- shadcn/ui components hand-written in `components/ui/` (`components.json` is set up for `npx shadcn add`).
- Visual checks: screenshot every page in light + dark on throw-away servers (local tooling, see the private docs).

## Environment gotchas

- Behind a TLS-intercepting proxy or antivirus: use `pip install --use-feature=truststore ...` (OS certificate store);
  if npm fails with `ECONNRESET`, use `npm install --maxsockets=3 --fetch-retries=6`.
- Windows PowerShell 5.1: no `&&`; `Invoke-WebRequest` needs `-UseBasicParsing`; prefer script files over inline `python -c` with quotes.
- torch + faiss on Windows: `KMP_DUPLICATE_LIB_OK=TRUE` is set in `backend/app/__init__.py`.
- Embedders are no longer mixed by accident: a changed embedder triggers a full re-embed via `engine.json`
  (old databases without it are assumed to be SigLIP base).
- Licenses: every model and dependency must be Apache-2.0 compatible (see `docs/licenses.md`).
- SAM 2 in transformers needs `torchvision`; the HF `sam2.1-*` checkpoints log a harmless "sam2_video → sam2" warning.
- Model downloads behind a TLS-intercepting proxy: `KWEETO_TRUSTSTORE=1` (uses `truststore`).
- On Windows prefer `127.0.0.1` over `localhost` in HTTP clients/tests: `localhost` may try IPv6 first and stall ~2 s per connection.
- SAM in transformers returns 3 nested masks; the whole object usually has a *lower* score than sub-parts,
  hence `segmenter._pick_whole_object` (largest reliable mask). Don't "fix" it back to argmax.
- Don't re-record `assets/demo.gif` unless explicitly asked (re-recorded 2026-11-15; how: private docs).
- README images (`assets/playground-*.png`, `pixel-growth.png`, `pixel-moods.png`) are screenshots of the real app (3D, Edge +
  SwiftShader); the playground's levels are SIMULATED for the picture (rewritten API answers in the browser).
  The README is the short front page; reference material lives in the PUBLIC `docs/` folder (`architecture`, `configuration`, `engine-profiles`, `extending`, `api`, `database`, `licenses`; tests in CONTRIBUTING.md). Keep the README short: new reference material goes in `docs/`, linked from the README's Documentation table.

## Naming

The app is called **Kweeto** (an invented word: a chick's chirp). The character is **Pixel**. Env vars `KWEETO_*`, Docker
image/volumes `kweeto-*`, localStorage keys `kweeto-*`; there are no aliases for earlier names. Deliberately kept: the per-project
SQLite file is still named `teachme.db` (renaming it would orphan existing projects).

## Data outside git

`backend/data/` (all projects: DBs, images, thumbnails) is git-ignored. To move one project to another machine, copy its
`backend/data/projects/<id>/` folder manually
(same embedder/model) or re-upload the images. The same applies to the private `documentation/` folder.

# Architecture

[← Back to the README](../README.md). Repository layout, how the engine learns, and the learning benchmark.

```
├── backend/
│   ├── app/
│   │   ├── main.py                 FastAPI app, lifespan (DB, vector store, worker), static files, /api/health
│   │   ├── config.py               paths, windows, thresholds (Settings, environment variables)
│   │   ├── db.py, models.py        SQLite (WAL) + SQLAlchemy schema
│   │   ├── schemas.py              Pydantic request models
│   │   ├── workspace.py, projects.py   projects: registry, Pixel's traits, open / close / delete
│   │   ├── worker.py               background thread: ingest scan, box re-embedding, detector pass
│   │   │  engine
│   │   ├── profiles.py             engine profiles (light / balanced / accurate / custom) + engine.json
│   │   ├── runtime.py              ONNX Runtime sessions and execution providers, PyTorch fallback
│   │   ├── plugins.py              extension points: embedders, segmenters, probes, detector families
│   │   ├── embedders.py, embedder.py   embedder components (DINOv2, SigLIP, any HF model, fake "pixels") + facade
│   │   ├── segmenter.py            segmenter components (SAM, SAM 2.1, "simple"), click-to-box, snapping
│   │   ├── regions.py, geometry.py ingest-time candidate regions; mask polygons
│   │   ├── engine.py               vector store, kNN + probe with background, instance selection
│   │   ├── probes.py, learning.py  learners (linear, MLP); training examples, probe cache, track record
│   │   ├── services.py             recomputation and propagation (⚡), lesson queue, serialisation
│   │   │  teaching and data
│   │   ├── questions.py            Apprentice Questions
│   │   ├── sessions.py             lesson sessions and their before / after recap
│   │   ├── importer.py, export.py  dataset import (COCO, YOLO, VOC, Label Studio, CVAT) and export
│   │   ├── health.py               dataset health: balance, near-duplicates, suspicious boxes
│   │   ├── detector*.py            LibreYOLO training jobs, catalogue, inference as Pixel's second opinion
│   │   ├── demo.py, demo_scenes.py one-click demo project (synthetic scenes, also the benchmark's ground truth)
│   │   ├── pixel.py                Pixel's voice: every sentence is a template over real counts
│   │   └── routers/                HTTP endpoints, one file per area
│   ├── plugins/                    your own models: *.py files loaded at start-up (see _example_plugin.py)
│   ├── bench/                      learning benchmark: simulated teacher on scenes with ground truth (or COCO)
│   └── tests/                      unit, end-to-end and learning-regression tests (fake embedder, no PyTorch)
├── frontend/src/
│   ├── app/                        one folder per page (Playground, Overview, Lesson, Harvest, Questions, Training,
│   │                               Gallery, Upload, Import, Health, Export, Projects, Engine, Recap, image detail)
│   ├── components/                 pixel + pixel3d (the character), playground, box-canvas, app-shell, ui/ (shadcn)
│   └── lib/                        typed API client, sounds, theme, contrast
├── docker/, Dockerfile, docker-compose.yml   one-container image (backend + Next.js standalone)
├── scripts/                        setup and dev scripts
├── assets/                         README images
└── .github/                        CI (tests, lint, types, build), issue and PR templates
```

# How the engine works

The pipeline has three phases. The expensive vision work happens once per image; learning and prediction
are cheap and run after every gesture.

1. **Ingest (once per image, background).** The segmenter finds object regions at **several granularities**
   (a pile *and* each item in it; with SAM, the sub-part, part and whole-object masks of a grid of points).
   Nearby look-alike pieces are also merged into **union** regions (an object broken in two by an occluder).
   Plus the whole image. Each region is cropped with 10% context, embedded (SigLIP) and stored
   (`regions` table + in-RAM vector store). `KWEETO_PROPOSER=windows` uses a fixed grid instead.
2. **Learning (after every gesture, milliseconds).** Examples come only from what you confirmed:
   - *positives*: your boxes, plus the ingest region that matches each box (IoU >= 0.6);
   - *background* ("not an object"): on images you **finished** in a Lesson, the regions you did not box
     (pieces of an object, piles of several objects, clutter) and the guesses you rejected.

   A **kNN memory** (instant, few-shot) and a **linear probe** with a background class (multinomial logistic
   regression on embedding + size/shape/"contains other regions") are fitted on **all** examples every time:
   warm-started so it costs a few dozen steps, but deterministic and able to forget a deleted example. The
   probe's say in the class choice grows with the examples (`probe_ramp`); its background probability gates
   every region from the first finished image on. This is how Pixel learns the right *granularity* per class.
3. **Prediction.** Every region of every unannotated image gets a confidence = class vote x familiarity x
   "is an object". **Instance selection** then keeps one proposal per object: a region that contains several
   regions of the same class is either a **pile** (keep the items) or **one broken object** (keep the whole),
   decided by the class's typical size learned from your boxes (or, without it, by count and confidence);
   then overlap suppression. Negatives ("this region is not X") block class X.
4. **Propagation**: new proposals are compared with the previous ones. Changed images are the **⚡ delta** and are
   attributed to the gesture that caused them, so the Harvest can group "from your correction Nut → Washer".
5. **Honest confidence**: every guess you judge (Lesson, Harvest, Questions; hidden checks excluded) is logged in
   `outcomes`. Pixel shows a level (*sure / maybe / guess*) and how often guesses of that level were right lately,
   never a raw percentage. The Home page compares its first and latest judged guesses.
6. **No feedback loop**: Pixel learns **only** from human-confirmed boxes and finished images, never from proposals.

## Measuring it: the learning benchmark

`backend/bench/simulate.py` runs a simulated teacher through the real API: it accepts correct guesses, relabels
wrong ones, rejects the rest and draws what Pixel missed, never seeing a held-out set. It reports precision /
recall / F1, recall on **touching** and **broken** objects, "count ok" (exactly one proposal per object), the
teacher's effort and the **segmentation ceiling** (objects that have a candidate region at all: nothing learned
can beat it). Synthetic scenes (`bench/scenes.py`: piles of tomatoes, broken pipes, look-alike limes) or a COCO
dataset.

```powershell
cd backend
python -m bench.simulate                                            # fake embedder, ~20 s
python -m bench.simulate --embedder siglip --segmenter sam --size 640x480 --images 45 --lessons 30
python -m bench.simulate --coco instances.json --images-dir images  # your own labelled data
python -m bench.simulate --set use_background=false                 # ablation of one setting
python -m bench.simulate --profile light --size 640x480 --images 60 --holdout 20 --lessons 30 \
    --detector yolo9-t --detector-after 15 --detector-variants 0.3:0.3,0.5:0.5   # Pixel + a trained detector
```

With `--detector`, a real LibreYOLO detector is trained on the finished images after `--detector-after` lessons and
every later checkpoint is measured with and without it (`det` column: `off`, or the `weight:veto` tried).

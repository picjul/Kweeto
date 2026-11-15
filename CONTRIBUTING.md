# Contributing to Kweeto

Thanks for helping! Bug reports, ideas and pull requests are all welcome, whether you write the code by hand or with
an AI assistant (Kweeto itself is vibe-coded: see the README).

## Set up

```bash
./scripts/setup.sh            # macOS / Linux / Git Bash   (--light skips PyTorch: fake embedder only)
.\scripts\setup.ps1           # Windows PowerShell          (-Light)
./scripts/dev.sh --fake       # backend :8000 + frontend :3000 with the fake embedder (no model download)
```

The fake `pixels` embedder and the `simple` segmenter need no PyTorch and make the whole app run in seconds: use them
for UI work and tests. Real models are only needed to judge the engine.

## Before you open a pull request

```bash
cd backend
KWEETO_EMBEDDER=pixels python -m pytest -q         # all tests (the real-model ones are skipped without torch)
python -m ruff check .                             # lint (config in backend/ruff.toml)
cd ../frontend
npx tsc --noEmit && npm run build                  # types + production build
```

The same checks run in CI on every push and pull request.

## Product rules (please keep them)

These are what Kweeto is about; a change that breaks one needs a good reason in the PR description.

1. **No feedback loop**: Pixel learns only from boxes a human confirmed, never from its own guesses.
2. **Pixel is honest**: every sentence it says maps to a real model event or count (`backend/app/pixel.py`). No fake
   emotions or progress, no uncalibrated percentages.
3. The ⚡ counter only counts images whose guesses really changed.
4. Hidden checks in the Harvest never become boxes, and the client never knows which items are checks.
5. No guilt mechanics (streaks, "you abandoned me"); keyboard first; low verbosity.
6. **Engine changes are judged by the benchmark**, not by feel: run `python -m bench.simulate` before and after and put
   the held-out curves in the PR. Keep `tests/test_learning.py` green.
7. A learner always re-learns from **all** the examples (deleting an example must unlearn it).

## Code and style

- Backend: FastAPI + SQLAlchemy in `backend/app/`, one module per concern; Pixel's sentences in `pixel.py`.
- Frontend: Next.js (App Router) in `frontend/src/`; colours through the CSS variables (`bg-card`, `text-pixel`...),
  never hard-coded `bg-white`; every animation must respect `prefers-reduced-motion`.
- Code, UI text and docs are in English. Box coordinates are normalised to 0..1.
- **Licenses**: every model and dependency must be compatible with Apache-2.0. Name the license in the PR (and in the
  plugin's `license` field for new models).
- Never commit datasets, model weights, or anything from `backend/data/`.

## Extending without forking

New embedders, segmenters, learners, detector families and engine profiles can be added as plugins: see
[docs/extending.md](docs/extending.md) and `backend/plugins/_example_plugin.py`.

## Reporting bugs

Open an issue with what you did, what you expected and what happened, plus the engine line from the Engine page
(profile, runtime, device). For security issues see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the Apache License 2.0.

## Running the tests

```powershell
cd backend
pip install -r requirements-dev.txt
$env:KWEETO_EMBEDDER="pixels"; python -m pytest -q
python -m ruff check .
```

The tests need no PyTorch and no model download (the fake embedder): the real-model checks are skipped unless the
models are installed. CI (`.github/workflows/ci.yml`) runs them, the lint, the TypeScript check and the production
build on every push.

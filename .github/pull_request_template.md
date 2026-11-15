## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## Checklist

- [ ] `KWEETO_EMBEDDER=pixels python -m pytest -q` and `ruff check .` pass (in `backend/`)
- [ ] `npx tsc --noEmit` and `npm run build` pass (in `frontend/`)
- [ ] Engine change? Held-out curves of `python -m bench.simulate` before / after are below
- [ ] New model or dependency? Its license is Apache-2.0 compatible and named here
- [ ] Pixel's new sentences (if any) map to real events or counts

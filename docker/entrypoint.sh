#!/usr/bin/env bash
# Starts the backend (internal) and the frontend (published) and stops the container if either exits.
set -euo pipefail

# Without PyTorch (image built with TORCH=none) fall back to the torch-free engine, unless chosen explicitly.
if ! python -c "import torch" >/dev/null 2>&1; then
  export KWEETO_EMBEDDER="${KWEETO_EMBEDDER:-pixels}"
  export KWEETO_SEGMENTER="${KWEETO_SEGMENTER:-simple}"
  echo "Kweeto: PyTorch not installed, using the test engine (embedder=$KWEETO_EMBEDDER, segmenter=$KWEETO_SEGMENTER)"
fi

cd /app/backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers &
backend=$!

cd /app/frontend
node server.js &
frontend=$!

stop() { kill -TERM "$backend" "$frontend" 2>/dev/null || true; wait || true; }
trap stop INT TERM

echo "Kweeto: open http://localhost:${PORT:-3000} (or the port you published)"
# exit as soon as one of the two dies, so Docker can restart the container
wait -n "$backend" "$frontend" || true
stop
exit 1

#!/usr/bin/env bash
# Kweeto setup on macOS/Linux.  Usage: ./scripts/setup.sh [--light]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIGHT="${1:-}"

echo "==> Backend"
cd "$ROOT/backend"
[ -d .venv ] || python3 -m venv .venv
PIP=".venv/bin/python -m pip install --disable-pip-version-check"
if [ "$LIGHT" = "--light" ]; then
  $PIP fastapi "uvicorn[standard]" sqlalchemy pillow numpy python-multipart faiss-cpu
else
  $PIP -r requirements.txt
fi
$PIP -r requirements-dev.txt

echo "==> Frontend"
cd "$ROOT/frontend"
command -v npm >/dev/null || { echo "Node.js not found: install Node 22 LTS (see .nvmrc)"; exit 1; }
[ -f .env.local ] || cp .env.local.example .env.local
npm install --no-fund --no-audit

echo
echo "Done. Start:"
echo "  cd backend && source .venv/bin/activate && uvicorn app.main:app --reload"
echo "  cd frontend && npm run dev"
[ "$LIGHT" = "--light" ] && echo "  (light mode: export KWEETO_EMBEDDER=pixels before uvicorn)"

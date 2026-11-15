#!/usr/bin/env bash
# Kweeto: starts the backend (http://127.0.0.1:8000) and the frontend (http://localhost:3000)
# in this terminal, then opens the browser. Ctrl+C stops both.
#   ./scripts/dev.sh          real models (engine profile from the Engine page, default "light")
#   ./scripts/dev.sh --fake   fake "pixels" embedder (no torch), data in backend/data-fake
# Works on macOS, Linux and Git Bash on Windows. KWEETO_NO_BROWSER=1 skips opening the browser.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -x "$ROOT/backend/.venv/bin/python" ]; then
  PY="$ROOT/backend/.venv/bin/python"
elif [ -x "$ROOT/backend/.venv/Scripts/python.exe" ]; then
  PY="$ROOT/backend/.venv/Scripts/python.exe"
else
  echo "Backend not set up: run ./scripts/setup.sh first (on Windows: scripts\\setup.ps1)." >&2
  exit 1
fi
[ -d "$ROOT/frontend/node_modules" ] || { echo "Frontend not set up: run ./scripts/setup.sh first." >&2; exit 1; }

if [ "${1:-}" = "--fake" ]; then
  export KWEETO_EMBEDDER=pixels
  export KWEETO_DATA_DIR="$ROOT/backend/data-fake"
fi

pids=()
stop_tree() {  # stops a server and everything it spawned (uvicorn reloader, npm -> next dev)
  local p=$1
  if [ -r "/proc/$p/winpid" ] && command -v taskkill >/dev/null 2>&1; then
    taskkill //PID "$(cat "/proc/$p/winpid")" //T //F >/dev/null 2>&1 || true  # Git Bash: native Windows processes
  fi
  kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true      # whole process group on macOS/Linux
}
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping Kweeto..."
  for p in "${pids[@]}"; do stop_tree "$p"; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

set -m  # each server in its own process group, so it can be stopped as a whole
(cd "$ROOT/backend" && exec "$PY" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000) &
pids+=($!)
(cd "$ROOT/frontend" && exec npm run dev) &
pids+=($!)
set +m

wait_for() {  # url, seconds
  for _ in $(seq 1 "$2"); do
    curl -s -o /dev/null "$1" && return 0
    sleep 1
  done
  return 1
}

echo "Starting Kweeto (backend + frontend)..."
wait_for http://127.0.0.1:8000/ 60 && echo "Backend is up."
wait_for http://localhost:3000/ 60 || true
URL=http://localhost:3000
if [ -n "${KWEETO_NO_BROWSER:-}" ]; then :
elif command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$URL"
fi
echo "Kweeto is running at $URL (models load in the background on first start). Ctrl+C to stop."
wait

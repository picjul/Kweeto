# Kweeto in one container: FastAPI backend (internal, :8000) + Next.js frontend (exposed, :3000).
# The frontend forwards /api and /files to the backend, so only port 3000 is published.
#
#   docker compose up -d                                      # then open http://localhost:3000
#   docker build -t kweeto .                                 # full image (CPU PyTorch, real models)
#   docker build -t kweeto:light --build-arg TORCH=none .    # small image, no PyTorch (test embedder)
#
# Data (projects, images, exports) lives in /data, downloaded models in /models: mount volumes on both.

ARG PYTHON_VERSION=3.11
ARG NODE_VERSION=22

# ---------- 1. frontend build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# empty API URL = same origin (the Next.js server proxies to the backend)
ENV NEXT_PUBLIC_API_URL="" \
    KWEETO_STANDALONE=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- 2. Node.js runtime (only the binary is copied into the final image) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS node

# ---------- 3. final image ----------
FROM python:${PYTHON_VERSION}-slim-bookworm
# cpu  = PyTorch CPU build: real models (DINOv2, SAM...), downloaded on first use into /models (~2 GB image)
# none = no PyTorch: test embedder + simple segmenter, for trying the UI (~400 MB image)
ARG TORCH=cpu
# ONNX Runtime package (the inference runtime). Default: CPU. NVIDIA GPU (untested; run with `--gpus all`):
#   --build-arg ORT_PACKAGE="onnxruntime-gpu[cuda,cudnn]"
ARG ORT_PACKAGE=onnxruntime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    KWEETO_DATA_DIR=/data \
    HF_HOME=/models \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN apt-get update  && apt-get install -y --no-install-recommends libstdc++6 libgomp1 libgl1 libglib2.0-0  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN set -eux; \
    if [ "$TORCH" = "cpu" ]; then \
      pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision; \
      grep -v '^onnxruntime' requirements.txt > /tmp/req.txt; \
      pip install -r /tmp/req.txt "$ORT_PACKAGE"; \
    else \
      grep -viE '^(torch|torchvision|transformers|onnx|libreyolo)' requirements.txt > /tmp/req.txt; \
      pip install -r /tmp/req.txt; \
    fi

COPY backend/app ./app
COPY --from=frontend /src/.next/standalone /app/frontend
COPY --from=frontend /src/.next/static /app/frontend/.next/static
COPY docker/entrypoint.sh /usr/local/bin/kweeto-entrypoint
RUN set -eux; \
    chmod +x /usr/local/bin/kweeto-entrypoint; \
    useradd --create-home --uid 1000 kweeto; \
    mkdir -p /data /models; \
    chown -R kweeto:kweeto /data /models

USER kweeto
VOLUME ["/data", "/models"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["kweeto-entrypoint"]

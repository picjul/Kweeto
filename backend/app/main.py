"""FastAPI entry point: uvicorn app.main:app --reload"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import __version__, projects, workspace
from .db import NoProjectOpen
from .config import ALLOWED_HOSTS, CORS_ORIGINS
from .routers import batch, classes, exports, health, images, imports, questions, system, training
from .routers import projects as projects_router
from .worker import worker

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("kweeto")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    projects.startup()  # migrates old data, opens the last active project (DB, vectors, engine profile)
    worker.start()
    yield


app = FastAPI(title="Kweeto API", version=__version__, lifespan=lifespan)

# Kweeto has no authentication (single user, local): these guards keep OTHER websites, open in the same browser,
# from reaching it. See SECURITY.md.
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CSRF_HEADER = "x-kweeto"


@app.middleware("http")
async def _cross_site_guard(request: Request, call_next):
    """A browser request that changes data must carry the X-Kweeto header, which the app's own client always sends.

    A foreign page cannot add it without a CORS preflight, which the origin allow-list refuses, so a cross-site form
    or fetch cannot reset, delete or upload anything (CSRF). Requests without browser headers (Origin,
    Sec-Fetch-Site), such as scripts and tests, are not affected: they are not driven by a web page.
    """
    if request.method in UNSAFE_METHODS:
        from_browser = "origin" in request.headers or "sec-fetch-site" in request.headers
        if from_browser and request.headers.get(CSRF_HEADER) != "1":
            return JSONResponse(status_code=403, content={"detail": "Cross-site request refused", "code": "cross_site"})
    return await call_next(request)


app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
# outermost: requests for another host name (DNS rebinding) never reach the app
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)


@app.exception_handler(NoProjectOpen)
async def _no_project(_request: Request, exc: NoProjectOpen):
    return JSONResponse(status_code=409, content={"detail": str(exc), "code": "no_project"})


def _file(folder, name: str) -> FileResponse:
    # a plain file name of this folder only: no separators, no "..", no drive ("D:x" would leave it on Windows)
    if not name or "/" in name or "\\" in name or ":" in name or name.startswith("."):
        raise HTTPException(404)
    path = folder / name
    if path.parent != folder or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/files/images/{name}")
def image_file(name: str):
    """Files of the ACTIVE project (names are random UUIDs, so they never clash between projects)."""
    if workspace.current is None:
        raise HTTPException(404)
    return _file(workspace.images_dir(), name)


@app.get("/files/thumbs/{name}")
def thumb_file(name: str):
    if workspace.current is None:
        raise HTTPException(404)
    return _file(workspace.thumbs_dir(), name)


for r in (images.router, classes.router, batch.router, questions.router, system.router, projects_router.router,
          exports.router, training.router, imports.router, health.router):
    app.include_router(r)


@app.get("/")
def root():
    return {"name": "Kweeto", "version": __version__, "docs": "/docs",
            "project": workspace.current.id if workspace.current else None}


@app.get("/api/health")
def liveness():
    """Liveness probe (Docker HEALTHCHECK, scripts): answers without touching any project."""
    return {"status": "ok", "version": __version__, "project": workspace.current.id if workspace.current else None}

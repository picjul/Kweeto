"""Opening, creating and deleting projects (the active project's database, vectors and models)."""
from __future__ import annotations

import logging
import shutil
import sqlite3
import threading
import time

import numpy as np
from sqlalchemy import select

from . import db, learning, profiles, services, workspace
from . import engine as eng
from .models import Region
from .worker import worker

log = logging.getLogger("kweeto.projects")
DELETED_MARK = ".deleted"


def load_store() -> None:
    """Loads the active project's region vectors into the in-RAM store."""
    eng.store.clear()
    with db.SessionLocal() as s:
        rows = s.execute(select(Region.id, Region.image_id, Region.kind, Region.x, Region.y, Region.w, Region.h,
                                Region.is_full, Region.embedding)).yield_per(2000)
        batch = []
        for rid, iid, kind, x, y, w, h, full, emb in rows:
            k = eng.KIND_BOX if kind == "box" else eng.KIND_DETECTOR if kind == "detect" else eng.KIND_WINDOW
            batch.append((rid, iid, k, (x, y, w, h), bool(full), np.frombuffer(emb, dtype="float32")))
            if len(batch) >= 2000:
                eng.store.add(batch)
                batch = []
        eng.store.add(batch)
    log.info("Project %s: %d regions loaded", workspace.current.id, eng.store.size())


def open_project(p: workspace.Project) -> dict:
    """Makes `p` the active project. Work in progress on the previous one is discarded by the worker."""
    with workspace.lock:
        workspace.current = p
        workspace.remember_active(p.id)
        for sub in ("images", "thumbs"):
            (p.dir / sub).mkdir(parents=True, exist_ok=True)
        db.connect(workspace.db_path())
        profiles.load_for_project()  # also bumps the generation: in-flight worker results are dropped
        learning.reset_cache()
        worker.reset_progress()
        with db.SessionLocal() as s:
            redo = services.sync_engine(s)
        load_store()
        with db.SessionLocal() as s:
            services.recompute(s)
    worker.wake()
    return redo


def close_project() -> None:
    """No project open (fresh install, or the open project was deleted): the user picks one on the Home."""
    with workspace.lock:
        workspace.current = None
        workspace.remember_active(None)
        db.dispose()
        eng.store.clear()
        learning.reset_cache()
        profiles.load_for_project()  # bumps the generation: the worker drops what it was doing
        worker.reset_progress()


def startup() -> None:
    """Re-opens the project used last time. Nothing is created by default: with no project (or a stale
    registry) the app starts with no project open and the Home invites to create or pick one."""
    migrated = workspace.migrate_legacy()  # data from before projects existed: kept, as "My project"
    if migrated:
        log.info("Moved the existing data into project %r", migrated.name)
    _purge_deleted()
    p = migrated or workspace.get(workspace.stored_active() or "")
    if p is not None and not _is_deleted(p):
        open_project(p)
    else:
        close_project()


def _is_deleted(p: workspace.Project) -> bool:
    return (p.dir / DELETED_MARK).exists()


def visible_projects() -> list[workspace.Project]:
    return [p for p in workspace.list_projects() if not _is_deleted(p)]


def delete_project(pid: str) -> bool:
    """Deletes a project and all its files. If it is the open one, no project stays open afterwards."""
    p = workspace.get(pid)
    if p is None or _is_deleted(p):
        return False
    if workspace.current is not None and workspace.current.id == pid:
        close_project()
    (p.dir / DELETED_MARK).write_text("deleted", encoding="utf-8")  # hidden at once, even if files are busy
    threading.Thread(target=_remove_when_free, args=(pid,), daemon=True, name=f"delete-{pid}").start()
    return True


def _remove_when_free(pid: str, attempts: int = 120) -> None:
    """Windows keeps files of an open SQLite connection locked: retry until the worker lets go."""
    for _ in range(attempts):
        p = workspace.get(pid)
        if p is None:
            return
        try:
            shutil.rmtree(p.dir)
            log.info("Project %s deleted", pid)
            return
        except OSError:
            time.sleep(1)
    log.warning("Project %s is hidden but some files could not be deleted yet", pid)


def _purge_deleted() -> None:
    for p in workspace.list_projects():
        if _is_deleted(p):
            shutil.rmtree(p.dir, ignore_errors=True)


def stats_of(p: workspace.Project) -> dict:
    """Quick counts read straight from a project's database (works for inactive projects too)."""
    path = p.dir / "teachme.db"
    if not path.exists():
        return {"images": 0, "boxes": 0, "classes": 0}
    try:
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=2)
        try:
            q = lambda sql: con.execute(sql).fetchone()[0]  # noqa: E731
            return {"images": q("select count(*) from images"), "boxes": q("select count(*) from boxes"),
                    "classes": q("select count(*) from classes")}
        finally:
            con.close()
    except sqlite3.Error:
        return {"images": 0, "boxes": 0, "classes": 0}

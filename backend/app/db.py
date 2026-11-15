"""SQLite connection of the ACTIVE project (swapped when the user switches project)."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

_engine = None
_session = None


class NoProjectOpen(RuntimeError):
    """Raised by project-scoped work when no project is open (answered with HTTP 409 by the API)."""


class Base(DeclarativeBase):
    pass


def _sqlite_pragmas(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA busy_timeout=10000")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


def connect(path: Path) -> None:
    """Opens (and creates, if needed) the database of a project; closes the previous one."""
    global _engine, _session
    from . import models  # registers the tables on Base.metadata
    _ = models

    dispose()
    eng = create_engine(f"sqlite:///{path.as_posix()}", connect_args={"check_same_thread": False})
    event.listen(eng, "connect", _sqlite_pragmas)
    Base.metadata.create_all(eng)
    _engine = eng
    _session = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)


def dispose() -> None:
    """Closes the pooled connections (needed on Windows before deleting a project's files)."""
    global _engine, _session
    if _engine is not None:
        _engine.dispose()
    _engine = _session = None


def SessionLocal() -> Session:  # noqa: N802 (kept the familiar name)
    if _session is None:
        raise NoProjectOpen("No project is open: create or open one first")
    return _session()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

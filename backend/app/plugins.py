"""Extension points: the models Kweeto can use are looked up here, never hard-coded.

Four registries, filled by the built-in modules and by plugins:
- EMBEDDERS   crop -> vector (Pixel's "eyes"); subclass `embedders.Embedder` (or `TransformersEmbedder`
              for any Hugging Face vision backbone: ~10 lines);
- SEGMENTERS  candidate regions, click-to-box, masks; subclass `segmenter.Segmenter` (or
              `PromptableSegmenter` for SAM-like models: encode once, decode prompts);
- PROBES      the learner next to the kNN memory; subclass `probes.ProbeTrainer`;
- DETECTORS   LibreYOLO detector families trainable on the Training page (`detector_catalog.DetectorFamily`).

Plugins are plain Python modules that import this module and call `register`:

    from app.plugins import EMBEDDERS
    from app.embedders import TransformersEmbedder

    @EMBEDDERS.register
    class MyEmbedder(TransformersEmbedder):
        id = "my-embedder"
        ...

They are loaded from `backend/plugins/*.py` (files starting with "_" are skipped; folder overridable with
KWEETO_PLUGINS_DIR) and from the modules listed in KWEETO_PLUGINS (comma separated, importable names).
A plugin that fails to load is reported on the Engine page instead of stopping the app. Every model must have
an Apache-2.0 compatible license: say which one in its `license` attribute.
"""
from __future__ import annotations

import importlib
import importlib.util
import logging
import os
import sys
import threading
import traceback
from pathlib import Path
from typing import Any, Generic, TypeVar

log = logging.getLogger("kweeto.plugins")

T = TypeVar("T")

BUILTINS = ("app.embedders", "app.segmenter", "app.probes", "app.detector_catalog")
PLUGINS_DIR = Path(os.getenv("KWEETO_PLUGINS_DIR") or Path(__file__).resolve().parent.parent / "plugins")

_lock = threading.RLock()
_state = {"loaded": False, "loading": False}
loaded_plugins: list[str] = []
errors: list[dict] = []  # [{"plugin", "error"}]: shown on the Engine page


class Registry(Generic[T]):
    """id -> component (a class, or an object with an `id`). Later registrations replace earlier ones."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self._items: dict[str, T] = {}

    def register(self, item: T) -> T:
        """Usable as a decorator on a class with an `id` attribute, or called with an object having an `id`."""
        key = str(getattr(item, "id", "") or "")
        if not key:
            raise ValueError(f"A {self.kind} needs a non-empty `id`")
        if key in self._items and self._items[key] is not item:
            log.info("%s %r replaced by %s", self.kind, key, getattr(item, "__module__", item))
        self._items[key] = item
        return item

    def get(self, key: str) -> T:
        ensure_loaded()
        try:
            return self._items[key]
        except KeyError:
            raise ValueError(f"Unknown {self.kind} {key!r}: choose one of {', '.join(sorted(self._items))}") from None

    def __contains__(self, key: object) -> bool:
        ensure_loaded()
        return key in self._items

    def all(self) -> list[T]:
        ensure_loaded()
        return list(self._items.values())

    def ids(self) -> list[str]:
        ensure_loaded()
        return list(self._items)


EMBEDDERS: Registry[Any] = Registry("embedder")
SEGMENTERS: Registry[Any] = Registry("segmenter")
PROBES: Registry[Any] = Registry("probe")
DETECTORS: Registry[Any] = Registry("detector family")


def _note(plugin: str, e: BaseException) -> None:
    errors.append({"plugin": plugin, "error": f"{type(e).__name__}: {e}"})
    log.error("plugin %s failed to load:\n%s", plugin, traceback.format_exc())


def _load_file(path: Path) -> None:
    name = f"kweeto_plugin_{path.stem}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)


def load_plugin_file(path: str | Path) -> bool:
    """Loads one plugin file now (also after start-up). Returns False (and records the error) if it fails."""
    ensure_loaded()
    path = Path(path)
    try:
        _load_file(path)
        loaded_plugins.append(path.name)
        return True
    except Exception as e:
        _note(path.name, e)
        return False


def ensure_loaded() -> None:
    """Imports the built-in components, then the plugins (once)."""
    if _state["loaded"] or _state["loading"]:
        return
    with _lock:
        if _state["loaded"] or _state["loading"]:
            return
        _state["loading"] = True
        try:
            for mod in BUILTINS:
                importlib.import_module(mod)
            for mod in [m.strip() for m in os.getenv("KWEETO_PLUGINS", "").split(",") if m.strip()]:
                try:
                    importlib.import_module(mod)
                    loaded_plugins.append(mod)
                except Exception as e:
                    _note(mod, e)
            if PLUGINS_DIR.is_dir():
                for path in sorted(PLUGINS_DIR.glob("*.py")):
                    if path.name.startswith("_"):
                        continue
                    try:
                        _load_file(path)
                        loaded_plugins.append(path.name)
                    except Exception as e:
                        _note(path.name, e)
        finally:
            _state["loading"] = False
            _state["loaded"] = True


def option(model_id: str, title: str = "", license: str = "", note: str = "") -> dict:
    """A suggested checkpoint of a component (shown in the Custom profile)."""
    return {"id": model_id, "title": title or model_id.split("/")[-1], "license": license, "note": note}


def describe_component(cls) -> dict:
    """Public metadata of an embedder / segmenter / probe class."""
    return {"id": cls.id, "title": getattr(cls, "title", cls.id), "summary": getattr(cls, "summary", ""),
            "license": getattr(cls, "license", ""), "models": list(getattr(cls, "models", ())),
            "default_model": getattr(cls, "default_model", ""), "needs_torch": getattr(cls, "needs_torch", True),
            "custom_model": getattr(cls, "custom_model", True), "builtin": cls.__module__.startswith("app."),
            "available": _available(cls)}


def _available(cls) -> bool:
    try:
        return bool(cls.available())
    except Exception:
        return False


def describe() -> dict:
    """Everything that is registered (Engine page)."""
    ensure_loaded()
    return {"embedders": [describe_component(c) for c in EMBEDDERS.all()],
            "segmenters": [describe_component(c) for c in SEGMENTERS.all()],
            "probes": [describe_component(c) for c in PROBES.all()],
            "plugins": list(loaded_plugins), "errors": list(errors), "plugins_dir": str(PLUGINS_DIR)}

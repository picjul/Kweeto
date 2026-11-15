"""The training process (one per run), started by detector.py: `python -m app.detector_job <run_dir> train|resume|export`.

It reads <run_dir>/job.json, trains with LibreYOLO and keeps <run_dir>/status.json up to date after every epoch
(state, epoch, metrics on the validation images, ETA), so the app can show the progress without talking to it.
At the end the best checkpoint is exported to <run_dir>/model.onnx. Stopping = terminating this process: LibreYOLO
writes last.pt after every epoch, so a run can be resumed from where it was.
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

from . import detector  # noqa: F401  (also applies app/__init__: OpenMP workaround)
from .detector import write_json

try:  # weights come from Hugging Face: trust the OS certificate store (works behind TLS-intercepting proxies too)
    import truststore

    truststore.inject_into_ssl()
except Exception:  # pragma: no cover
    pass


def _status(d: Path) -> dict:
    try:
        return json.loads((d / "status.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def _update(d: Path, **kw) -> None:
    write_json(d / "status.json", {**_status(d), **kw})


def _metric(m, *names):
    for n in names:
        if n in m and m[n] is not None:
            return float(m[n])
    return None


class Progress:
    """LibreYOLO training callback -> status.json."""

    def __init__(self, d: Path):
        self.d = d

    def on_train_start(self, e):
        _update(self.d, state="running", phase="training", epoch=max(0, e.start_epoch - 1), total_epochs=e.total_epochs)

    def on_train_epoch_end(self, e):
        st = _status(self.d)
        m = dict(e.val_metrics)
        entry = {"epoch": e.epoch, "loss": round(float(e.train_loss), 4), "seconds": round(float(e.epoch_seconds), 1),
                 "map50": _metric(m, "metrics/mAP50(B)", "metrics/mAP50"),
                 "map50_95": _metric(m, "metrics/mAP50-95(B)", "metrics/mAP50-95"),
                 "precision": _metric(m, "metrics/precision(B)", "metrics/precision"),
                 "recall": _metric(m, "metrics/recall(B)", "metrics/recall")}
        hist = [h for h in st.get("history", []) if h["epoch"] < e.epoch] + [entry]
        secs = [h["seconds"] for h in hist[-5:]]
        left = e.total_epochs - e.epoch
        best = max((h for h in hist if h["map50_95"] is not None), key=lambda h: h["map50_95"], default=None)
        _update(self.d, state="running", phase="training", epoch=e.epoch, total_epochs=e.total_epochs, history=hist,
                eta_s=round(sum(secs) / len(secs) * left) if secs else None,
                best=best and {k: best[k] for k in ("epoch", "map50", "map50_95", "precision", "recall")})

    def on_train_end(self, e):
        _update(self.d, completed_epochs=e.completed_epochs)


def _export(d: Path, job: dict) -> None:
    from libreyolo import LibreYOLO

    model = LibreYOLO(str(detector.checkpoint(d)), device="cpu")
    model.export(format="onnx", output_path=str(d / "model.onnx"), imgsz=job["imgsz"])


def main(d: Path, mode: str) -> None:
    job = json.loads((d / "job.json").read_text(encoding="utf-8"))
    if mode == "export":
        _export(d, job)
        return
    try:
        _update(d, state="preparing", phase="loading the model (the first time it is downloaded)")
        from libreyolo import LibreYOLO

        last = d / "run" / "weights" / "last.pt"
        model = LibreYOLO(str(last) if mode == "resume" else job["weights"])
        kw = dict(data=str(d / "dataset" / "data.yaml"), epochs=job["epochs"], imgsz=job["imgsz"], batch=job["batch"],
                  patience=job["patience"], device="", workers=0 if sys.platform == "win32" else 2,
                  eval_interval=1,  # validate every epoch: live metrics, and a stopped run keeps its best model
                  project=str(d), name="run", exist_ok=True, callbacks=[Progress(d)])
        if mode == "resume":
            kw["resume"] = str(last)
        model.train(**kw)
        _update(d, state="preparing", phase="exporting the model to ONNX")
        try:
            _export(d, job)
        except Exception as e:  # the .pt is still there; ONNX can be exported again later
            _update(d, export_error=f"{type(e).__name__}: {e}")
        st = _status(d)
        early = (st.get("completed_epochs") or st.get("epoch") or 0) < job["epochs"]
        _update(d, state="done", phase=None, finished_at=time.time(), stopped_early=early)
    except Exception as e:
        traceback.print_exc()
        _update(d, state="failed", phase=None, finished_at=time.time(), error=f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "train")

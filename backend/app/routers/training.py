"""Ad-hoc detector training (LibreYOLO): dataset readiness, runs, start / stop / resume, downloads."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import detector, detector_catalog, detector_infer, workspace
from ..db import get_db

router = APIRouter(prefix="/api/training", tags=["training"])


class TrainingIn(BaseModel):
    model: str = "yolo9-t"
    epochs: int = Field(100, ge=1, le=2000)
    imgsz: int = Field(640, ge=160, le=1600)
    patience: int = Field(30, ge=0, le=1000)
    batch: int = Field(8, ge=1, le=256)


@router.get("")
def overview(db: Session = Depends(get_db)):
    ok, why = detector.available()
    return {"available": ok, "unavailable_reason": why, "device": detector.training_device() if ok else None,
            "models": [{"id": k, **v} for k, v in detector_catalog.models().items()],
            "more_families": detector_catalog.not_offered(), "dataset": detector.readiness(db),
            "runs": detector.list_runs(), "busy": detector.busy(), "active": detector_infer.active_id()}


@router.post("")
def start(body: TrainingIn, db: Session = Depends(get_db)):
    try:
        return detector.start(db, body.model, body.epochs, body.imgsz, body.patience, body.batch)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


def _run(run_id: str):
    try:
        return detector.run_dir(run_id)
    except KeyError as e:
        raise HTTPException(404, "Training run not found") from e


@router.post("/dismiss-suggestion")
def dismiss_suggestion(db: Session = Depends(get_db)):
    """'Not now': Pixel stays quiet until as many new judgments are still not improving."""
    detector.dismiss_suggestion(db)
    return {"ok": True}


@router.post("/deactivate")
def deactivate():
    """No active detector for this project any more."""
    return {"active": detector_infer.set_active(None)}


@router.get("/{run_id}")
def status(run_id: str):
    return detector.run_out(_run(run_id))


@router.post("/{run_id}/stop")
def stop(run_id: str):
    _run(run_id)
    return detector.stop(run_id)


@router.post("/{run_id}/resume")
def resume(run_id: str):
    _run(run_id)
    try:
        return detector.resume(run_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


@router.post("/{run_id}/activate")
def activate(run_id: str):
    """Makes this trained detector the project's one: its boxes are shown next to Pixel's guesses."""
    _run(run_id)
    try:
        return {"active": detector_infer.set_active(run_id)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


@router.delete("/{run_id}")
def delete(run_id: str):
    _run(run_id)
    if detector_infer.active_id() == run_id:
        detector_infer.set_active(None)
    try:
        detector.delete(run_id)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {"deleted": run_id}


@router.get("/{run_id}/download")
def download(run_id: str, format: str = "onnx"):
    d = _run(run_id)
    name = f"{workspace.require().id}-{run_id}"
    if format == "pt":
        ckpt = detector.checkpoint(d)
        if ckpt is None:
            raise HTTPException(404, "This run has no trained model yet.")
        return FileResponse(ckpt, filename=f"{name}.pt", media_type="application/octet-stream")
    if format != "onnx":
        raise HTTPException(400, "format must be onnx or pt")
    try:
        return FileResponse(detector.onnx_file(run_id), filename=f"{name}.onnx", media_type="application/octet-stream")
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e

"""Import of existing datasets (COCO, YOLO, Pascal VOC, Label Studio, CVAT): stage, preview, commit."""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from .. import importer
from ..schemas import ImportCommitIn

router = APIRouter(prefix="/api/imports", tags=["imports"])


def _job(job_id: str):
    try:
        return importer.get(job_id)
    except KeyError as e:
        raise HTTPException(404, "Import not found") from e


@router.get("/formats")
def formats():
    return importer.FORMATS


@router.post("")
def create_import():
    return importer.create().out()


@router.post("/{job_id}/files")
def add_files(job_id: str, files: list[UploadFile] = File(...)):
    """Adds files to the staging area. Send the relative path as the file name to keep folders (YOLO labels/)."""
    _job(job_id)
    n = 0
    try:
        for f in files:
            n += importer.add_file(job_id, f.filename or "file", f.file)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    except Exception as e:  # a broken zip
        raise HTTPException(400, f"Could not read {f.filename}: {type(e).__name__}") from e
    return {"added": n}


@router.get("/{job_id}/preview")
def preview(job_id: str, format: str | None = Query(None)):
    _job(job_id)
    return importer.preview(job_id, format)


@router.post("/{job_id}/commit")
def commit(job_id: str, body: ImportCommitIn):
    _job(job_id)
    try:
        return importer.commit(job_id, body.format, body.complete, body.empty_negative, body.skip_classes).out()
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


@router.get("/{job_id}")
def status(job_id: str):
    return _job(job_id).out()


@router.delete("/{job_id}")
def discard(job_id: str):
    _job(job_id)
    importer.discard(job_id)
    return {"ok": True}

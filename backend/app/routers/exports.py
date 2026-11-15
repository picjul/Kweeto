"""Exports of the open project's annotations (COCO, YOLO, Pascal VOC, CSV, PNG masks)."""
from __future__ import annotations

import re
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import export, workspace
from ..schemas import ExportIn

router = APIRouter(prefix="/api/exports", tags=["exports"])


@router.get("")
def list_exports():
    return {"formats": export.FORMATS, "candidates": export.candidates(), "jobs": export.list_jobs()}


@router.post("")
def create_export(body: ExportIn):
    opts = export.ExportOptions(formats=body.formats, masks=body.masks, images=body.images, scope=body.scope,
                                split=(body.train, body.val, body.test), seed=body.seed)
    try:
        return export.start(opts).out()
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


@router.get("/{job_id}")
def export_status(job_id: str):
    j = export.get(job_id)
    if j is None:
        raise HTTPException(404, "Export not found")
    return j


@router.get("/{job_id}/download")
def download(job_id: str):
    j = export.get(job_id)
    if j is None or j["status"] != "done" or not export.zip_path(job_id).exists():
        raise HTTPException(404, "Export not ready")
    slug = re.sub(r"[^\w\-]+", "-", workspace.require().name).strip("-").lower() or "project"
    stamp = datetime.fromisoformat(j["created_at"]).strftime("%Y%m%d-%H%M")
    return FileResponse(export.zip_path(job_id), media_type="application/zip", filename=f"kweeto-{slug}-{stamp}.zip")


@router.delete("/{job_id}")
def delete_export(job_id: str):
    if not export.delete(job_id):
        raise HTTPException(404, "Export not found")
    return {"deleted": job_id}

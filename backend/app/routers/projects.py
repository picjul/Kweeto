"""Projects (one per dataset), each with its own Pixel."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import projects, workspace
from ..schemas import PixelIn, ProjectCreate, ProjectPatch

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _traits(base: workspace.PixelTraits, p: PixelIn | None) -> workspace.PixelTraits:
    if p is None:
        return base
    d = {**base.__dict__, **{k: v for k, v in p.model_dump().items() if v is not None}}
    return workspace.PixelTraits(**d).validated()


def _out(p: workspace.Project) -> dict:
    return {**p.out(), "stats": projects.stats_of(p),
            "active": workspace.current is not None and workspace.current.id == p.id}


def _options() -> dict:
    return {"colors": {k: {"light": f"{h} {s}% {l1}%", "dark": f"{h} {s}% {l2}%"}
                       for k, (h, s, l1, l2) in workspace.PALETTES.items()},
            "shapes": list(workspace.SHAPES), "eyes": list(workspace.EYES),
            "accessories": list(workspace.ACCESSORIES), "names": list(workspace.NAMES)}


@router.get("")
def list_projects():
    return {"active": workspace.current.id if workspace.current else None,
            "projects": [_out(p) for p in projects.visible_projects()], "pixel_options": _options()}


@router.get("/active")
def active_project():
    return _out(workspace.current) if workspace.current else None


@router.post("")
def create_project(body: ProjectCreate):
    p = workspace.create(body.name)
    if body.pixel is not None:
        p = workspace.update(p.id, pixel=_traits(p.pixel, body.pixel))
    if body.open:
        projects.open_project(p)
    return _out(p)


@router.post("/demo")
def create_demo():
    """The demo project (synthetic images, three classes), opened: see demo.py."""
    from .. import demo

    return _out(demo.create())


@router.patch("/{pid}")
def update_project(pid: str, body: ProjectPatch):
    p = workspace.get(pid)
    if p is None:
        raise HTTPException(404, "Project not found")
    p = workspace.update(pid, name=body.name, pixel=_traits(p.pixel, body.pixel) if body.pixel else None)
    return _out(p)


@router.post("/{pid}/open")
def open_project(pid: str):
    p = workspace.get(pid)
    if p is None:
        raise HTTPException(404, "Project not found")
    redo = projects.open_project(p)
    return {**_out(p), **redo}


@router.delete("/{pid}")
def delete_project(pid: str):
    if not projects.delete_project(pid):
        raise HTTPException(404, "Project not found")
    return {"deleted": pid, "active": workspace.current.id if workspace.current else None}

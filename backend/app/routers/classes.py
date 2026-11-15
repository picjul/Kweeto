from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import services
from ..db import get_db
from ..models import Box, LabelClass, Negative, Proposal
from ..schemas import ClassIn, ClassPatch

router = APIRouter(prefix="/api/classes", tags=["classes"])


@router.get("")
def list_classes(db: Session = Depends(get_db)):
    return services.classes_out(db)


@router.post("")
def create_class(body: ClassIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    if db.scalar(select(LabelClass.id).where(func.lower(LabelClass.name) == name.lower())):
        raise HTTPException(409, "A class with this name already exists")
    n = db.scalar(select(func.count(LabelClass.id))) or 0
    c = LabelClass(name=name, color=body.color or services.PALETTE[n % len(services.PALETTE)])
    db.add(c)
    db.commit()
    return {"id": c.id, "name": c.name, "color": c.color, "box_count": 0}


@router.patch("/{class_id}")
def update_class(class_id: int, body: ClassPatch, db: Session = Depends(get_db)):
    c = db.get(LabelClass, class_id)
    if c is None:
        raise HTTPException(404, "Class not found")
    if body.name:
        c.name = body.name.strip()
    if body.color:
        c.color = body.color
    db.commit()
    return {"id": c.id, "name": c.name, "color": c.color}


@router.delete("/{class_id}")
def delete_class(class_id: int, db: Session = Depends(get_db)):
    c = db.get(LabelClass, class_id)
    if c is None:
        raise HTTPException(404, "Class not found")
    if db.scalar(select(func.count(Box.id)).where(Box.class_id == class_id)):
        raise HTTPException(409, "This class has annotations: remove them first")
    db.query(Negative).filter(Negative.class_id == class_id).delete()
    db.query(Proposal).filter(Proposal.class_id == class_id).delete()
    db.delete(c)
    db.commit()
    return {"ok": True}

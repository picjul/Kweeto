from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import questions as qs
from ..db import get_db
from ..models import Question
from ..schemas import QuestionAnswerIn

router = APIRouter(prefix="/api/questions", tags=["questions"])


@router.get("")
def list_questions(db: Session = Depends(get_db)):
    return {"questions": [qs.question_out(q) for q in qs.generate(db)]}


@router.post("/{question_id}/answer")
def answer_question(question_id: int, body: QuestionAnswerIn, db: Session = Depends(get_db)):
    q = db.get(Question, question_id)
    if q is None or q.status != "open":
        raise HTTPException(404, "Question no longer available: reload the page")
    return qs.answer(db, q, body.action, body.assignments)


@router.post("/{question_id}/dismiss")
def dismiss_question(question_id: int, db: Session = Depends(get_db)):
    q = db.get(Question, question_id)
    if q is None:
        raise HTTPException(404, "Question not found")
    q.status = "dismissed"
    db.commit()
    return {"ok": True}

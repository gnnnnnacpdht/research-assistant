"""问答接口：接收问题，走完整 RAG 流水线，返回带页码锚点的答案与原文来源。"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import rag

router = APIRouter(prefix="/api", tags=["问答"])


class AskRequest(BaseModel):
    """问答请求体；长度上下限用于挡住空提问和超长 prompt 注入。"""

    question: str = Field(min_length=1, max_length=500, description="用户问题")


@router.post("/ask")
def ask(payload: AskRequest) -> dict:
    """返回 {"answer": 答案文本, "sources": [{paper_id, filename, page, text}]}。"""
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="问题不能为空")

    try:
        return rag.answer_question(question)
    except RuntimeError as exc:
        # 密钥缺失、模型接口报错等属于依赖问题，用 503 区分于用户输入错误。
        raise HTTPException(status_code=503, detail=str(exc)) from exc

"""问答接口：接收问题，走 Agent 状态机，返回带页码锚点的答案、来源与推理轨迹。"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import agent

router = APIRouter(prefix="/api", tags=["问答"])


class AskRequest(BaseModel):
    """问答请求体；长度上下限用于挡住空提问和超长 prompt 注入。"""

    question: str = Field(min_length=1, max_length=500, description="用户问题")
    # 指定论文 id 时只在该论文内检索；为空表示全库检索。
    paper_id: int | None = Field(default=None, description="限定检索的论文 id")


@router.post("/ask")
def ask(payload: AskRequest) -> dict:
    """返回 {"answer", "sources", "trajectory"}；trajectory 记录各阶段耗时与自检结果。"""
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="问题不能为空")

    try:
        return agent.run_agent(question, paper_id=payload.paper_id)
    except RuntimeError as exc:
        # 密钥缺失、模型接口报错等属于依赖问题，用 503 区分于用户输入错误。
        raise HTTPException(status_code=503, detail=str(exc)) from exc

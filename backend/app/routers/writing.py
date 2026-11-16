"""学术写作接口：无幻觉论文框架 + Mermaid/TikZ 绘图脚本。"""

from fastapi import APIRouter, HTTPException

from .. import writing

router = APIRouter(prefix="/api/writing", tags=["写作"])


@router.post("/framework")
def generate_framework(payload: dict) -> dict:
    """根据研究想法生成六节框架与绘图代码；引用仅限本地库内论文。"""
    idea = str(payload.get("idea") or "").strip()
    if not idea:
        raise HTTPException(status_code=400, detail="idea 不能为空")
    if len(idea) > 2000:
        raise HTTPException(status_code=413, detail="idea 不能超过 2000 字符")

    try:
        return writing.build_framework(idea)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

"""翻译接口：英文论文段落 → 中文学术文风，带进程内缓存避免重复计费。"""

import threading
from collections import OrderedDict

from fastapi import APIRouter, HTTPException

from .. import llm_client

router = APIRouter(prefix="/api", tags=["翻译"])

# 翻译结果缓存：同一段原文只调一次模型。论文正文重复率不高，
# 但翻页往返、多人看同一页时会明显命中，512 条足够且内存占用很小。
_CACHE_LIMIT = 512
_cache: OrderedDict[str, str] = OrderedDict()
_cache_lock = threading.Lock()

SYSTEM_PROMPT = (
    "你是学术论文翻译助手。把用户给出的英文论文原文翻译成中文，要求："
    "1) 学术书面语，术语使用领域通行译法（如 Transformer、attention、BLEU 可保留英文）；"
    "2) 保留原文中的引用标记（如 [1]、[2,3]）、公式编号和数字，位置不变；"
    "3) 保留段落换行结构，不要添加解释、不要总结、不要输出任何额外说明；"
    "4) 只输出译文本身。"
)


def _cache_get(text: str) -> str | None:
    with _cache_lock:
        value = _cache.get(text)
        if value is not None:
            _cache.move_to_end(text)
        return value


def _cache_put(text: str, translated: str) -> None:
    with _cache_lock:
        _cache[text] = translated
        _cache.move_to_end(text)
        while len(_cache) > _CACHE_LIMIT:
            _cache.popitem(last=False)  # 淘汰最久未使用的


@router.post("/translate")
def translate(payload: dict) -> dict:
    """把英文文本翻译成中文；相同文本命中缓存时不调用模型。"""
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if len(text) > 8000:
        # 单次请求限制长度，避免一次翻整篇论文导致超时和费用失控。
        raise HTTPException(status_code=413, detail="单次翻译文本不能超过 8000 字符")

    cached = _cache_get(text)
    if cached is not None:
        return {"translation": cached, "cached": True}

    try:
        translated = llm_client.chat(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            temperature=0.1,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if translated:
        _cache_put(text, translated)
    return {"translation": translated, "cached": False}


@router.get("/translate/cache-stats")
def cache_stats() -> dict:
    """缓存命中情况，便于演示"省钱"这一点。"""
    with _cache_lock:
        return {"size": len(_cache), "limit": _CACHE_LIMIT}

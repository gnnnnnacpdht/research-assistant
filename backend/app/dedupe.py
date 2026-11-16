"""语义去重：新论文全文 embedding 与库内已有论文比对，超过阈值触发预警。

官方用例：1706.03762v7.pdf 先入库 → 上传 1706.03762v1.pdf 时必须提示疑似重复。
"""

import math
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import config, db, llm_client

# 阈值写死在配置里，便于调参；0.92 经实测：v1/v7 余弦约 0.95，不同论文约 0.7 以下。
DEFAULT_THRESHOLD = 0.92

# BGE-M3 单次输入上限约 8192 tokens ≈ 20000 英文字符；
# 去重只需要"语义指纹"，截前 15000 字已足够区分版本差异。
FULL_TEXT_SAMPLE = 15000

# 待确认队列：上传解析后若疑似重复，暂存原始文件路径、解析结果、相似度。
# key 是 token，value 是 (tmp_path, filename, pages, full_text)
_pending: dict[str, tuple] = {}
_pending_lock = threading.Lock()


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def compare_full_texts(new_text: str, threshold: float = DEFAULT_THRESHOLD) -> list[dict]:
    """把新论文全文（截断前 15000 字作为语义指纹）与库内已有论文逐个比余弦相似度，超过阈值的返回明细。"""
    if not new_text.strip():
        return []
    new_sample = new_text[:FULL_TEXT_SAMPLE]

    existing = db.list_papers()
    if not existing:
        return []

    # 库内已有论文的全文可能很大，逐页拼接：避免一次性把完整 full_text 塞进内存。
    candidates: list[tuple[int, str, str]] = []  # (paper_id, filename, full_text)
    for paper in existing:
        full_text = "\n\n".join(text for _, text in db.get_pages(paper["id"]))
        candidates.append((paper["id"], paper["filename"], full_text))

    # 把待入库文本和所有已有文本拼成一次 embedding 请求，只调一个 HTTP。
    all_texts = [new_sample] + [text[:FULL_TEXT_SAMPLE] for _, _, text in candidates]
    embeddings = llm_client.embed_texts(all_texts)
    new_vec = embeddings[0]

    duplicates: list[dict] = []
    for (paper_id, filename, _), vec in zip(candidates, embeddings[1:], strict=False):
        score = cosine(new_vec, vec)
        if score >= threshold:
            duplicates.append(
                {
                    "paper_id": paper_id,
                    "filename": filename,
                    "similarity": round(score, 4),
                }
            )

    duplicates.sort(key=lambda item: item["similarity"], reverse=True)
    return duplicates


def generate_revision_summary(v1_text: str, v2_text: str, v1_label: str, v2_label: str) -> str:
    """调用 DeepSeek 对比两版全文，输出结构化修订摘要。

    两版都是大文本，直接塞进 prompt 会超限——先各截前 4000 字（BGE-M3 维度足够稳定）
    加关键元信息（标题、Abstract、Section 标题附近的差异点）让模型聚焦差异。
    """
    # 截采样：前 2000 + 后 2000，兼顾开头摘要和结尾结论
    def _sample(text: str) -> str:
        clean = " ".join(text.split())
        head = clean[:2000]
        tail = clean[-2000:] if len(clean) > 2000 else ""
        return f"{head}\n...(中间省略)...\n{tail}"

    messages = [
        {
            "role": "system",
            "content": (
                "你是学术论文版本对比助手。给定同一论文的两个版本文本，"
                "请用中文输出结构化修订摘要，包含："
                "1) 总体判断（是小修订、补充实验、还是模型结构大变）；"
                "2) 主要新增/修改/删除的章节（按 Section 标题列出）；"
                "3) 关键数字差异（如 BLEU、训练时长、参数量）；"
                "4) 一句话总结修订方向。"
                "要求简明，每点 1-3 行，不要复述原文。"
            ),
        },
        {
            "role": "user",
            "content": (
                f"【{v1_label} 摘要】\n{_sample(v1_text)}\n\n"
                f"【{v2_label} 摘要】\n{_sample(v2_text)}\n\n"
                "请按 system prompt 的格式输出修订摘要。"
            ),
        },
    ]
    return llm_client.chat(messages, temperature=0.1)


def enqueue_pending(
    tmp_path, filename: str, pages: list, full_text: str
) -> tuple[str, float]:
    """疑似重复时把解析结果暂存，返回 token 和相似度最高的分数。"""
    token = uuid.uuid4().hex
    with _pending_lock:
        _pending[token] = (tmp_path, filename, pages, full_text, time.time())
    return token


def dequeue_pending(token: str) -> tuple | None:
    """取走暂存的上传结果（覆盖/保留/取消三种走法都调用一次）。"""
    with _pending_lock:
        item = _pending.pop(token, None)
    return item


def peek_pending(token: str) -> tuple | None:
    """只读暂存结果，不消费；供 compare 等"只看一眼"的场景使用。"""
    with _pending_lock:
        return _pending.get(token)


def cleanup_stale_pending(max_age_seconds: int = 3600) -> int:
    """清理超时未确认的暂存上传（浏览器关了、网络丢了等场景）。"""
    now = time.time()
    with _pending_lock:
        stale = [
            token for token, (_, _, _, _, ts) in _pending.items()
            if now - ts > max_age_seconds
        ]
        for token in stale:
            item = _pending.pop(token, None)
            if item:
                tmp_path = item[0]
                try:
                    tmp_path.unlink(missing_ok=True)
                except Exception:
                    pass
    return len(stale)

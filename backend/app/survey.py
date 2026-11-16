"""自动综述与前沿探索：论文本体 + 引用图谱 → DeepSeek → 领域综述 + 三个 Future Work 方向。

设计取舍：
- 素材不塞全文：只给标题/摘要、Top 参考文献、Future Work/Limitation 段落，
  既省 token，又逼模型围绕"可验证的引用编号"写，减少幻觉。
- 结果落库缓存：同一论文只调用一次 DeepSeek，图谱页反复打开不再花钱。
"""

import json
import logging
import re

from . import citations, db, llm_client

logger = logging.getLogger(__name__)

# Future Work 段落通常不长，截断避免 541 页教材把 prompt 撑爆
MAX_FUTURE_CHARS = 2500
TOP_REFERENCES = 8

_HEADING_RE = re.compile(
    r"(?im)^\s*(?:\d+(?:\.\d+)*\.?\s*)?(future\s+work|limitations?|discussion)\b"
)

_PROMPT = """你是资深学术综述作者。根据给定材料，写一份简短综述并提炼未来方向。

硬性要求：
1. 只使用材料中出现的参考文献编号（形如 [3]），每个论断后面必须标注至少一个编号；
   不要编造材料里没有的文献、年份或结论。
2. 综述 300-500 字，必须分三段，每段以固定标签开头：
   "研究脉络："（该领域如何一步步演进）
   "主流方法："（当前主要技术路线及差异）
   "代表工作："（点名材料中的基石文献，并说明它在脉络中的位置）
3. 未来方向恰好 3 条，每条包含：
   - title：方向名称（15 字内）
   - why：为什么值得做（结合论文的 future work/limitation，或引用文献尚未解决的空白）
   - prior_work：已有工作做到哪一步（明确说明哪些坑已被填，避免重复旧 idea）
4. 只输出一个 JSON 对象，不要 Markdown 代码块：
{"overview": "研究脉络：...\\n主流方法：...\\n代表工作：...", "directions": [{"title": "...", "why": "...", "prior_work": "..."}]}
"""


def _future_passages(pages: list[tuple[int, str]]) -> str:
    """抓 Future Work / Limitation 段落；论文没写就退回最后两页（通常是结论/展望）。"""
    found: list[tuple[int, str]] = []
    for number, text in pages:
        matched = _HEADING_RE.search(text)
        if matched:
            found.append((number, text[matched.start() : matched.start() + 1000]))
    if not found:
        tail = pages[-2:] if len(pages) > 2 else pages
        found = [(number, text[:1000]) for number, text in tail]

    cleaned = []
    for number, text in found:
        cleaned.append(f"[第{number}页] " + re.sub(r"\s+", " ", text).strip())
    return "\n\n".join(cleaned)[:MAX_FUTURE_CHARS]


def _paper_meta(paper_id: int, filename: str) -> tuple[str, str]:
    """取结构化抽取出的标题与摘要；缺失时用文件名兜底。"""
    items = db.get_structure(paper_id)
    title = next((item["content"] for item in items if item["type"] == "title"), "")
    abstract = next((item["content"] for item in items if item["type"] == "abstract"), "")
    return title or filename, abstract[:1500]


def _build_material(paper_id: int, filename: str, graph: dict | None) -> str:
    title, abstract = _paper_meta(paper_id, filename)
    lines = [f"本论文标题：{title}", f"本论文摘要：{abstract or '（未抽取到摘要）'}"]

    references = (graph or {}).get("top5") or []
    lines.append("\n重点参考文献（按引用图谱重要性排序）：")
    for node in references[:TOP_REFERENCES]:
        year = node.get("year") or "年份未知"
        lines.append(
            f"[{node['index']}] {node.get('authors', '')} ({year}) {node.get('title', '')}"
            f"；正文提及 {node.get('mentions', 0)} 次，重要性 {node.get('importance', 0)}"
        )

    lines.append("\n论文的 Future Work / Limitation 相关原文：")
    lines.append(_future_passages(db.get_pages(paper_id)) or "（未找到相关段落）")
    return "\n".join(lines)


def _parse_response(raw: str) -> dict | None:
    """模型偶尔会用代码块包 JSON，这里做一次宽松提取。"""
    matched = re.search(r"\{.*\}", raw, re.S)
    if not matched:
        return None
    try:
        return json.loads(matched.group(0))
    except json.JSONDecodeError:
        return None


def build_survey(paper_id: int, refresh: bool = False) -> dict:
    """生成（或读取缓存）论文综述与未来方向。"""
    paper = db.get_paper(paper_id)
    if paper is None:
        raise LookupError("论文不存在")

    if not refresh:
        cached = db.get_survey(paper_id)
        if cached is not None:
            return {
                "paper_id": paper_id,
                "filename": paper["filename"],
                "cached": True,
                "created_at": cached["created_at"],
                **json.loads(cached["content"]),
            }

    # 引用图谱只是素材，构建失败（如没有任何参考文献）不该阻塞综述生成
    try:
        graph = citations.build_citation_graph(paper_id)
    except Exception:
        logger.warning("论文 %s 引用图谱构建失败，综述将不带参考文献素材", paper_id)
        graph = None

    material = _build_material(paper_id, paper["filename"], graph)
    raw = llm_client.chat(
        [
            {"role": "system", "content": _PROMPT},
            {"role": "user", "content": material},
        ],
        temperature=0.3,
    )

    parsed = _parse_response(raw)
    if not parsed or not parsed.get("overview"):
        raise RuntimeError("综述生成失败：模型返回内容无法解析，请稍后重试")

    payload = {
        "overview": str(parsed.get("overview", "")).strip(),
        "directions": [
            {
                "title": str(item.get("title", "")).strip(),
                "why": str(item.get("why", "")).strip(),
                "prior_work": str(item.get("prior_work", "")).strip(),
            }
            for item in (parsed.get("directions") or [])
            if isinstance(item, dict)
        ][:3],
        "reference_count": len((graph or {}).get("nodes", [])) - 1 if graph else 0,
    }
    db.save_survey(paper_id, json.dumps(payload, ensure_ascii=False))

    return {
        "paper_id": paper_id,
        "filename": paper["filename"],
        "cached": False,
        "created_at": db.get_survey(paper_id)["created_at"],
        **payload,
    }

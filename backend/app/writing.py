"""学术写作 Copilot：基于本地文献库生成"无幻觉"论文框架与绘图脚本。

关键约束：Related Work 的引用编号只能来自本地库（papers 表 + 结构化标题），
模型输出的引用键会在后端二次校验，库内不存在的编号直接丢弃，
因此前端看到的"参考文献"一定能在论文库里找到对应 PDF。
"""

import json
import logging
import re

from . import db, llm_client

logger = logging.getLogger(__name__)

# 六个标准章节，顺序固定；模型漏写的章节前端也能显示占位
SECTIONS = [
    ("abstract", "Abstract"),
    ("introduction", "Introduction"),
    ("method", "Method"),
    ("experiment", "Experiment"),
    ("conclusion", "Conclusion"),
]

# 模型没给出合法 Mermaid 时的兜底图，保证前端预览不空白
FALLBACK_MERMAID = """flowchart TD
  A[输入数据 / Input] --> B[特征提取 / Feature Extraction]
  B --> C[核心方法 / Proposed Method]
  C --> D[实验与评估 / Evaluation]
  D --> E[结论与展望 / Conclusion]"""

_PROMPT = """你是学术写作助手。根据用户的研究想法和"本地文献库清单"，给出论文框架。

硬性要求：
1. Related Work 只能引用清单中出现的文献，引用键必须写成 "L<数字>"（如 L12）；
   清单里没有的文献一律不许出现，不要编造标题、作者或年份。
2. 每节 3-5 条要点，用中文写（术语可保留英文），具体可执行，不要空话。
3. diagram_code 必须是合法的 Mermaid flowchart 语法（以 "flowchart TD" 开头），
   节点文字用中文并加英文术语，不要用 Markdown 代码块包裹。
4. tikz_code 可选：给出一段可直接编译的 TikZ 图代码，写不出就给空字符串。
5. 只输出一个 JSON 对象，不要任何解释文字：
{
  "sections": {
    "abstract": ["要点1", "要点2", "要点3"],
    "introduction": [...],
    "method": [...],
    "experiment": [...],
    "conclusion": [...]
  },
  "related_work": [
    {"point": "该工作与本文的关系", "citations": ["L3", "L7"]}
  ],
  "diagram_code": "flowchart TD\\n  A[输入] --> B[方法]",
  "tikz_code": ""
}
"""


def _clean_code_block(text: str) -> str:
    """去掉模型偶尔加的 ```mermaid / ```latex 包裹。"""
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    return cleaned


def _parse_json(raw: str) -> dict | None:
    matched = re.search(r"\{.*\}", raw or "", re.S)
    if not matched:
        return None
    try:
        return json.loads(matched.group(0))
    except json.JSONDecodeError:
        return None


def _normalize_sections(parsed: dict) -> list[dict]:
    """兼容模型把章节写在顶层或 sections 里两种形态。"""
    nested = parsed.get("sections") or {}
    result = []
    for key, label in SECTIONS:
        points = nested.get(key) or parsed.get(key) or []
        if isinstance(points, str):
            points = [points]
        clean = [str(point).strip() for point in points if str(point).strip()][:5]
        result.append({"key": key, "title": label, "points": clean})
    return result


def _filter_related_work(parsed: dict, library: list[dict]) -> tuple[list[dict], list[dict]]:
    """把模型的引用键映射到库内论文；库内不存在的键直接丢弃（防编造）。"""
    by_id = {paper["id"]: paper for paper in library}
    used: dict[int, dict] = {}
    related: list[dict] = []

    for item in parsed.get("related_work") or []:
        if not isinstance(item, dict):
            continue
        citations = []
        for key in item.get("citations") or []:
            matched = re.search(r"L?\s*(\d+)", str(key), re.IGNORECASE)
            if not matched:
                continue
            paper = by_id.get(int(matched.group(1)))
            if paper is None:
                continue  # 库内没有这条文献：丢弃，绝不输出
            citations.append(
                {
                    "id": paper["id"],
                    "title": paper["title"],
                    "year": paper["year"],
                    "filename": paper["filename"],
                }
            )
            used[paper["id"]] = paper
        related.append({"point": str(item.get("point", "")).strip(), "citations": citations})

    return related, list(used.values())


def build_framework(idea: str) -> dict:
    """生成论文框架：六节要点 + 仅来自本地库的 Related Work + Mermaid/TikZ 代码。"""
    library = db.list_library_references()
    if library:
        catalogue = "\n".join(
            f"L{paper['id']} | {paper['title']} | {paper['year'] or '年份未知'}"
            for paper in library
        )
    else:
        catalogue = "（本地库为空，related_work 请返回空数组）"

    prompt_user = f"研究想法：{idea}\n\n本地文献库清单（只能从这里引用）：\n{catalogue}"
    raw = llm_client.chat(
        [
            {"role": "system", "content": _PROMPT},
            {"role": "user", "content": prompt_user},
        ],
        temperature=0.4,
    )

    parsed = _parse_json(raw)
    if not parsed:
        raise RuntimeError("框架生成失败：模型返回内容无法解析，请重试")

    related, references = _filter_related_work(parsed, library)

    diagram = _clean_code_block(str(parsed.get("diagram_code") or ""))
    if not re.match(r"(?i)^(flowchart|graph)\s+(TD|TB|LR|RL|BT)", diagram):
        logger.warning("模型返回的 Mermaid 代码不合法，使用兜底架构图")
        diagram = FALLBACK_MERMAID

    return {
        "idea": idea,
        "sections": _normalize_sections(parsed),
        "related_work": related,
        "references": references,
        "diagram_code": diagram,
        "tikz_code": _clean_code_block(str(parsed.get("tikz_code") or "")),
        "library_size": len(library),
    }

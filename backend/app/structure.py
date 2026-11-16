"""细粒度结构化抽取：标题、作者机构、摘要、章节标题树、表格、公式、参考文献。

为什么规则优先：这些信息大多是版式约定（标题位置、小节编号、表格线、方括号编号），
规则可解释、可复现、零调用成本；只有首页标题/作者规则完全抽不到时，才请 LLM 兜底一次。
"""

import logging
import re
from collections import Counter
from pathlib import Path

import pymupdf

from . import db, llm_client

logger = logging.getLogger(__name__)

# 正文引用与参考文献共用的编号格式，图谱模块也复用它。
CITATION_RE = re.compile(r"\[(\d{1,3})\]")

# 章节编号：v7 这类 PDF 会把 "3.1" 和 "Encoder and Decoder Stacks" 排成上下两行。
_NUMBER_LINE_RE = re.compile(r"^[0-9]{1,2}(?:\.[0-9]{1,2}){0,2}$")
# 另一类 PDF 直接把编号和标题写在同一行。
_INLINE_HEADING_RE = re.compile(
    r"^([0-9]{1,2}(?:\.[0-9]{1,2}){0,2})\.?\s+([A-Z][A-Za-z0-9 ,\-:&/'()]{2,70})$"
)

# 首页不属于标题的行：版权声明、arXiv 页眉、会议信息等。
_FRONT_SKIP_RE = re.compile(
    r"(?i)arxiv|doi|copyright|permission|attribution|reproduce|preprint|"
    r"under review|all rights reserved|proceedings of"
)
_INSTITUTION_RE = re.compile(
    r"(?i)university|institute|department|college|academy|laborator|\blab\b|"
    r"google|microsoft|meta|facebook|amazon|deepmind|research|\binc\b|\bltd\b|"
    r"school|cent(er|re)|hospital"
)
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

# 公式兜底的判据：数学符号、数学函数、英文虚词（虚词出现即视为正文句子）。
_MATH_SYMBOL_RE = re.compile(r"[=√∑∏⊤⊥≤≥≠≈∈∞∂∇αβγδεθλμσϕωπ−]")
_MATH_FUNC_RE = re.compile(r"(?i)\b(softmax|concat|exp|log|sqrt|sin|cos|tanh|max|min)\b")
_STOPWORD_RE = re.compile(
    r"(?i)\b(the|of|we|is|are|was|were|with|that|this|in|and|for|to|from|by|on|as|be|but|it|its|their|has|have|been|not)\b"
)

_LLM_FRONT_PROMPT = """从论文首页文本中抽取元信息，只输出一个 JSON 对象：
{"title": "论文标题", "authors": "作者与机构，一行概括"}
找不到的字段填空字符串，不要解释，不要输出 Markdown 代码块。"""


def _lines(text: str) -> list[str]:
    """按行切分并去掉空行，后续规则都基于"视觉行"判断。"""
    return [line.strip() for line in (text or "").splitlines() if line.strip()]


def parse_references(pages: list[tuple[int, str]]) -> dict:
    """从分页文本里解析参考文献条目与正文首现页码。

    Returns:
        entries: [{index, page, text}]，按 [n] 切分出的条目
        first_pages: {编号: 正文首次出现页码}
        reference_page: References 标题所在页码
    """
    start = None
    for position, (_, text) in enumerate(pages):
        if re.search(r"(?m)^\s*References\s*$", text):
            # 取最后一次出现：正文里出现 "References" 字样（如表格列名）不算参考文献区
            start = position

    entries: list[dict] = []
    if start is not None:
        # 拼接 References 及之后的所有页面，并记录每段文本对应的页码
        spans: list[tuple[int, int, int]] = []
        pieces: list[str] = []
        cursor = 0
        for number, text in pages[start:]:
            piece = text + "\n"
            spans.append((cursor, cursor + len(piece), number))
            pieces.append(piece)
            cursor += len(piece)
        joined = "".join(pieces)

        matches = list(CITATION_RE.finditer(joined))
        for position, match in enumerate(matches):
            end = matches[position + 1].start() if position + 1 < len(matches) else len(joined)
            body = re.sub(r"\s+", " ", joined[match.end():end]).strip()
            if len(body) < 10:
                continue  # 跳过 "[2]" 这种孤立的编号残片
            page = next(p for begin, finish, p in spans if begin <= match.start() < finish)
            entries.append({"index": int(match.group(1)), "page": page, "text": body[:600]})

        # 同一编号可能重复出现（跨页被切断），保留文本最长的一条，并按编号排序
        unique: dict[int, dict] = {}
        for entry in entries:
            kept = unique.get(entry["index"])
            if kept is None or len(entry["text"]) > len(kept["text"]):
                unique[entry["index"]] = entry
        entries = [unique[key] for key in sorted(unique)]

    # 正文首现页：只看 References 之前的部分
    body_pages = pages[:start] if start is not None else pages
    first_pages: dict[int, int] = {}
    for number, text in body_pages:
        for match in CITATION_RE.finditer(text):
            index = int(match.group(1))
            first_pages.setdefault(index, number)

    return {
        "entries": entries,
        "first_pages": {str(key): value for key, value in sorted(first_pages.items())},
        "reference_page": pages[start][0] if start is not None else None,
    }


def _extract_title(lines: list[str], page_no: int) -> dict | None:
    """首页第一段"像标题"的文字：跳过版权/页眉，取第一个正常句子。"""
    for index, line in enumerate(lines[:18]):
        if _FRONT_SKIP_RE.search(line):
            continue
        if "@" in line or len(line) < 8 or not re.search(r"[A-Za-z]{3,}", line):
            continue
        if line.endswith((".", "。")):
            continue
        title = line
        # 标题可能跨两行，但下一行一旦出现作者符号/机构/邮箱就不再拼接
        if index + 1 < len(lines) and len(title) < 45:
            nxt = lines[index + 1]
            if (
                3 <= len(nxt) <= 80
                and "@" not in nxt
                and not any(mark in nxt for mark in ("∗", "†", "‡", "*"))
                and not _INSTITUTION_RE.search(nxt)
                and nxt[0].isupper()
                and not nxt.endswith(".")
            ):
                title = f"{title} {nxt}"
        return {"type": "title", "content": title[:300], "level": 0, "page_num": page_no}
    return None


def _extract_authors(lines: list[str], title_line_index: int, page_no: int) -> dict | None:
    """标题之后、Abstract 之前是作者区：按姓名/机构/邮箱三类分别归并。"""
    names: list[str] = []
    orgs: list[str] = []
    emails: list[str] = []

    for line in lines[title_line_index + 1 : title_line_index + 30]:
        if re.match(r"(?i)^abstract\b", line):
            break
        emails.extend(_EMAIL_RE.findall(line))
        cleaned = _EMAIL_RE.sub("", line).strip(" ∗†‡*")
        if not cleaned:
            continue
        if _INSTITUTION_RE.search(cleaned):
            orgs.append(cleaned)
            continue
        words = cleaned.split()
        # 姓名：首字母大写、无数字、不超过 4 个词
        if (
            1 <= len(words) <= 4
            and cleaned[0].isupper()
            and not re.search(r"\d", cleaned)
            and not any(word.lower() in {"and", "the", "of"} for word in words)
        ):
            names.append(cleaned)

    parts = []
    if names:
        parts.append("作者：" + "、".join(dict.fromkeys(names)))
    if orgs:
        parts.append("机构：" + "、".join(dict.fromkeys(orgs)))
    if emails:
        parts.append("邮箱：" + "、".join(dict.fromkeys(emails)))
    if not parts:
        return None
    return {
        "type": "author",
        "content": "；".join(parts)[:800],
        "level": 0,
        "page_num": page_no,
    }


def _looks_like_heading_title(title: str) -> bool:
    """过滤表格行、参考文献条目等"假标题"。"""
    if not 2 <= len(title) <= 70 or not title[0].isupper():
        return False
    if title.endswith((".", "。")):
        return False
    # 表格行/文献条目常带方括号、括号、逗号、年份
    if re.search(r"[\[\]()∗†,]", title):
        return False
    if re.search(r"\b(19|20)\d{2}\b", title) or re.search(r"(?i)et al", title):
        return False
    return len(title.split()) <= 12


def _match_heading(lines: list[str], index: int) -> tuple[str, str] | None:
    """识别一行（或"编号行 + 标题行"两行）是否为章节标题。"""
    line = lines[index]
    number = title = None

    if _NUMBER_LINE_RE.match(line) and index + 1 < len(lines):
        candidate = lines[index + 1]
        if _looks_like_heading_title(candidate):
            number, title = line, candidate
    else:
        matched = _INLINE_HEADING_RE.match(line)
        if matched and _looks_like_heading_title(matched.group(2)):
            number, title = matched.group(1), matched.group(2)

    if number is None:
        return None
    parts = [int(part) for part in number.split(".")]
    # 表格里的数值（23.75、88.3）也会排成独立行，用"编号各部分不超过 20"排除
    if parts[0] > 20 or any(part > 20 for part in parts):
        return None
    return number, title.strip()


def _extract_headings(pages: list[tuple[int, str]], stop_page: int | None) -> list[dict]:
    """抽取章节标题，层级 = 编号里的点号层数（1 → 一级，3.1 → 二级）。"""
    items: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for page_no, text in pages:
        if stop_page is not None and page_no >= stop_page:
            break
        lines = _lines(text)
        for index in range(len(lines)):
            matched = _match_heading(lines, index)
            if matched is None:
                continue
            number, title = matched
            level = min(3, number.count(".") + 1)
            key = (level, title.lower())
            # 同一标题在页眉反复出现，只保留第一次
            if key in seen:
                continue
            seen.add(key)
            items.append(
                {"type": "heading", "content": title, "level": level, "page_num": page_no}
            )
    return items


def _table_to_markdown(rows: list[list[str]]) -> str:
    """把版式表格转成 Markdown，空列先剔除，至少两行两列才算表格。"""
    cleaned = [
        [re.sub(r"\s+", " ", (cell or "")).replace("|", "\\|").strip() for cell in row]
        for row in rows
    ]
    cleaned = [row for row in cleaned if any(row)]
    if len(cleaned) < 2:
        return ""

    width = max(len(row) for row in cleaned)
    cleaned = [row + [""] * (width - len(row)) for row in cleaned]
    keep = [index for index in range(width) if any(row[index] for row in cleaned)]
    if len(keep) < 2:
        return ""
    cleaned = [[row[index] for index in keep] for row in cleaned]

    lines = [
        "| " + " | ".join(cleaned[0]) + " |",
        "| " + " | ".join(["---"] * len(cleaned[0])) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in cleaned[1:])
    return "\n".join(lines)[:4000]


def _extract_tables(pdf_path: Path | None, pages: list[tuple[int, str]]) -> list[dict]:
    """用 PyMuPDF 的版面分析读表格：比按空格猜列可靠得多。

    只在带 "Table N" 标题的页上做版式分析，并限制最多 30 页，
    避免 541 页教材把后台任务拖到分钟级。表题所在页可能同时是参考文献起始页，
    因此这里不再按 References 截断。
    """
    if pdf_path is None:
        return []
    caption_re = re.compile(r"(?i)\btable\s*[0-9]+")
    candidates = [page_no for page_no, text in pages if caption_re.search(text)]
    if not candidates:
        return []

    items: list[dict] = []
    with pymupdf.open(pdf_path) as document:
        for page_no in candidates[:30]:
            try:
                found = document[page_no - 1].find_tables()
            except Exception:  # 个别页面的版面分析会失败，跳过即可
                continue
            for table in found.tables:
                markdown = _table_to_markdown(table.extract())
                if markdown:
                    items.append(
                        {"type": "table", "content": markdown, "level": 0, "page_num": page_no}
                    )
    return items


def _add_formula(items: list[dict], seen: set[str], content: str, page_no: int) -> None:
    content = content.strip()
    if not content or content in seen or "http" in content.lower():
        return
    seen.add(content)
    items.append({"type": "formula", "content": content[:400], "level": 0, "page_num": page_no})


def _extract_formulas(pages: list[tuple[int, str]]) -> list[dict]:
    """先认 LaTeX 源码（$$...$$、\\begin{equation}），再用版式兜底识别展示公式。"""
    items: list[dict] = []
    seen: set[str] = set()

    for page_no, text in pages:
        for match in re.finditer(r"\$\$(.+?)\$\$", text, re.S):
            _add_formula(items, seen, " ".join(match.group(1).split()), page_no)
        for match in re.finditer(
            r"\\begin\{(equation\*?|align\*?|eqnarray\*?)\}(.+?)\\end\{\1\}", text, re.S
        ):
            env = match.group(1)
            _add_formula(
                items,
                seen,
                f"\\begin{{{env}}}{' '.join(match.group(2).split())}\\end{{{env}}}",
                page_no,
            )
        # PDF 文本层里公式是排版结果而非 LaTeX 源码：
        # 用"含等号 + 数学符号/函数/括号 + 无英文虚词"的独立行识别。
        for line in _lines(text):
            if not 6 <= len(line) <= 200 or "=" not in line:
                continue
            if not (_MATH_SYMBOL_RE.search(line) or _MATH_FUNC_RE.search(line) or "(" in line):
                continue
            if _STOPWORD_RE.search(line):
                continue
            _add_formula(items, seen, line, page_no)

    return items[:120]


def _extract_abstract(pages: list[tuple[int, str]]) -> dict | None:
    """Abstract 到 "1 Introduction" 之间是摘要；脚注符号（∗†‡）也视为结束。"""
    numbered: list[tuple[int, str]] = []
    for page_no, text in pages[:3]:
        numbered.extend((page_no, line) for line in _lines(text))

    for index, (page_no, line) in enumerate(numbered):
        if line.lower() != "abstract":
            continue
        collected: list[str] = []
        for cursor in range(index + 1, len(numbered)):
            current = numbered[cursor][1]
            if re.match(r"(?i)^(?:[0-9]{1,2}\s*\.?\s*)?introduction$", current):
                break
            if current.startswith(("∗", "†", "‡")):
                break
            if re.search(r"(?i)conference on neural|arxiv:", current):
                break
            # 遇到"编号行 + 标题行"说明下一节已经开始（如 "1" / "Introduction"）
            if _NUMBER_LINE_RE.match(current) and cursor + 1 < len(numbered):
                if _looks_like_heading_title(numbered[cursor + 1][1]):
                    break
            collected.append(current)
        content = " ".join(collected).strip()
        if len(content) >= 80:
            return {
                "type": "abstract",
                "content": content[:3000],
                "level": 0,
                "page_num": page_no,
            }
    return None


def _llm_front_matter(first_text: str) -> dict | None:
    """规则抽不到首页元信息时的兜底：只调用一次，失败就静默跳过。"""
    try:
        raw = llm_client.chat(
            [
                {"role": "system", "content": _LLM_FRONT_PROMPT},
                {"role": "user", "content": first_text[:4000]},
            ],
            temperature=0.0,
        )
    except RuntimeError:
        logger.warning("首页元信息 LLM 兜底失败，跳过")
        return None

    import json

    matched = re.search(r"\{.*\}", raw, re.S)
    if not matched:
        return None
    try:
        return json.loads(matched.group(0))
    except json.JSONDecodeError:
        return None


def extract_structure(
    pages: list[tuple[int, str]], pdf_path: Path | None = None
) -> list[dict]:
    """抽取一篇论文的全部结构化条目，按"首页元信息 → 标题树 → 表格 → 公式 → 参考文献"返回。"""
    if not pages:
        return []

    first_no, first_text = pages[0]
    first_lines = _lines(first_text)
    title = _extract_title(first_lines, first_no)

    title_line = None
    if title is not None:
        # 定位标题所在行，作者区从它后面开始
        for index, line in enumerate(first_lines):
            if line.startswith(title["content"][:20]):
                title_line = index
                break
    authors = (
        _extract_authors(first_lines, title_line, first_no)
        if title_line is not None
        else None
    )

    # 规则失败才请 LLM，避免每次上传都多一次网络请求
    if title is None or authors is None:
        fallback = _llm_front_matter(first_text)
        if fallback:
            if title is None and fallback.get("title"):
                title = {
                    "type": "title",
                    "content": str(fallback["title"])[:300],
                    "level": 0,
                    "page_num": first_no,
                }
            if authors is None and fallback.get("authors"):
                authors = {
                    "type": "author",
                    "content": str(fallback["authors"])[:800],
                    "level": 0,
                    "page_num": first_no,
                }

    parsed = parse_references(pages)
    stop_page = parsed.get("reference_page")

    front = [item for item in (title, authors, _extract_abstract(pages)) if item]
    references = [
        {
            "type": "reference",
            "content": f"[{entry['index']}] {entry['text']}",
            "level": 0,
            "page_num": entry["page"],
        }
        for entry in parsed["entries"]
    ]

    return (
        front
        + _extract_headings(pages, stop_page)
        + _extract_tables(pdf_path, pages)
        + _extract_formulas(pages)
        + references
    )


def extract_and_save(paper_id: int, pdf_path: Path | None = None) -> dict:
    """抽取并覆盖写入 structure 表；重复调用是幂等的。"""
    paper = db.get_paper(paper_id)
    if paper is None:
        raise ValueError(f"论文 {paper_id} 不存在")

    target = Path(pdf_path) if pdf_path else Path(paper["stored_path"])
    items = extract_structure(
        db.get_pages(paper_id), target if target.exists() else None
    )
    db.save_structure(paper_id, items)
    counts = Counter(item["type"] for item in items)
    logger.info("论文 %s 结构化完成：%s", paper_id, dict(counts))
    return {"paper_id": paper_id, "total": len(items), "counts": dict(counts)}


def extract_and_save_safely(paper_id: int, pdf_path: Path | None = None) -> None:
    """后台任务入口：结构化失败不能影响上传主流程。"""
    try:
        extract_and_save(paper_id, pdf_path)
    except Exception:  # 后台线程里的异常没人接收，必须在这里兜住
        logger.exception("论文 %s 结构化抽取失败", paper_id)

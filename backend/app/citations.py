"""引用图谱：解析参考文献 → networkx 建图 → 加权打分找基石文献。

同时提供"库内已收录"匹配：用 embedding 余弦相似度把本论文的每一条参考文献
与库内已有论文的标题/文件名做比对，>0.8 的节点标记 in_library=true，
让前端可以高亮出来"这条引用其实我们库内也有"。
"""

import math
import re

import networkx as nx

from . import db, llm_client
from .structure import CITATION_RE, parse_references

# 领域经典工作关键词 → 经典度（0-1）。命中即认为该文献在本领域影响面大。
FAMOUS_KEYWORDS: dict[str, float] = {
    "long short-term memory": 0.95,
    "lstm": 0.95,
    "adam": 0.95,
    "residual learning": 0.92,
    "resnet": 0.92,
    "deep residual": 0.92,
    "batch normalization": 0.9,
    "dropout": 0.88,
    "word2vec": 0.85,
    "generative adversarial": 0.85,
    "bert": 0.88,
    "convolutional": 0.7,
    "recurrent neural": 0.72,
    "imagenet": 0.72,
    "attention": 0.62,
    "deep learning": 0.65,
    "neural machine translation": 0.6,
    "sequence to sequence": 0.6,
    "encoder-decoder": 0.55,
}

# 顶会/顶刊加权，用于在关键词都没命中时区分普通引用
TOP_VENUES = ("nips", "neurips", "icml", "iclr", "acl", "emnlp", "naacl", "cvpr", "iccv", "eccv")

TITLE_RE = re.compile(r"^(?P<authors>.+?)\.\s(?P<title>[A-Z][^.]{6,}?)\.\s(?P<rest>.+)$")
YEAR_RE = re.compile(r"(?:19|20)\d{2}")

# 库内匹配阈值：超过这个余弦相似度就认为"这条引用指向的论文，库内也有"
IN_LIBRARY_THRESHOLD = 0.8


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _looks_like_authors(value: str) -> bool:
    """判断一段文本更像作者列表：含 "and" 或多个 "姓, 名" 结构。"""
    return bool(re.search(r"\band\b", value)) or bool(re.search(r"[A-Z][a-z]+,\s[A-Z]", value))


def _score_segment(segment: str) -> float:
    """给候选片段打分：标题通常小写词多、不含年份/arXiv/出版信息。"""
    words = segment.split()
    lower = sum(1 for word in words if word[:1].islower() and len(word) > 3)
    score = lower * 1.5 + min(len(words), 14) * 0.4
    if re.search(r"arxiv|proceedings|conference|doi|press|\b(19|20)\d{2}\b", segment, re.I):
        score -= 4
    return score


def _split_entry(text: str) -> dict:
    """把 "作者. 标题. 出处, 年份." 拆成结构化字段，拆不出来时退化为整段。"""
    matched = TITLE_RE.match(text)
    authors = title = rest = ""

    split_on_initial = bool(matched) and bool(
        re.search(r"(?:^|\s)[A-Z]\.?$", matched.group("authors").strip())
    )

    if matched and not split_on_initial and not _looks_like_authors(matched.group("title")):
        authors = matched.group("authors").strip()
        title = matched.group("title").strip()
        rest = matched.group("rest").strip()
    else:
        parts = [part.strip() for part in re.split(r"\.\s+", text) if part.strip()]
        if len(parts) >= 3:
            best_index, best_score = 1, float("-inf")
            for index in range(1, min(4, len(parts))):
                score = _score_segment(parts[index])
                if score > best_score:
                    best_index, best_score = index, score
            authors = ". ".join(parts[:best_index])
            title = parts[best_index]
            rest = ". ".join(parts[best_index + 1:])
        else:
            title = text[:120]

    years = YEAR_RE.findall(text)
    year = int(years[-1]) if years else None
    title = re.sub(r"(\w)- (\w)", r"\1\2", title)
    return {"authors": authors, "title": title, "venue": rest, "year": year}


def _fame_score(title: str, venue: str) -> float:
    lowered = f"{title} {venue}".lower()
    best = 0.0
    for keyword, weight in FAMOUS_KEYWORDS.items():
        if keyword in lowered:
            best = max(best, weight)
    if any(name in lowered for name in TOP_VENUES):
        best = max(best, 0.6)
    return round(best, 3)


def _match_in_library(
    ref_titles: list[str], max_candidates: int = 200
) -> list[dict]:
    """用 embedding 余弦相似度把参考文献标题与库内论文匹配。

    一次 batch 把 ref_titles + 所有库内 title 一起 embed，
    然后逐对算 cosine，超过 IN_LIBRARY_THRESHOLD 的记下 paper_id 和分数。

    返回与 ref_titles 等长的匹配列表：每个条目含 matched_paper_id 与 score，
    没匹配到时为空 dict。
    """
    if not ref_titles:
        return []

    library_refs = db.list_library_references()
    # 候选：每条库内论文用它的结构化 title（优先）+ 去掉扩展名的 filename 各算一个
    candidates: list[dict] = []
    seen: set[int] = set()
    for item in library_refs:
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        title_text = (item["title"] or "").strip()
        fname_stem = re.sub(r"\.pdf$", "", item["filename"] or "", flags=re.I).strip()
        if title_text:
            candidates.append({"paper_id": item["id"], "text": title_text.lower()})
        if fname_stem and fname_stem != title_text.lower():
            candidates.append({"paper_id": item["id"], "text": fname_stem.lower()})

    if not candidates:
        return [{} for _ in ref_titles]

    # 候选太多时截断，避免一次性 embed 超过 SiliconFlow 限制
    if len(candidates) > max_candidates:
        candidates = candidates[:max_candidates]

    texts_to_embed = [t.lower().strip() for t in ref_titles] + [c["text"] for c in candidates]
    try:
        vectors = llm_client.embed_texts(texts_to_embed)
    except Exception:
        # embedding 不可用时降级：返回空匹配，不要让整个图谱接口挂掉
        return [{} for _ in ref_titles]

    ref_vecs = vectors[: len(ref_titles)]
    cand_vecs = vectors[len(ref_titles) :]

    matches: list[dict] = []
    for ref_idx, ref_vec in enumerate(ref_vecs):
        best_paper_id: int | None = None
        best_score = 0.0
        for cand_idx, cand in enumerate(candidates):
            score = cosine(ref_vec, cand_vecs[cand_idx])
            # 同一 paper_id 的多个候选只保留分最高的
            if score > best_score and score >= IN_LIBRARY_THRESHOLD:
                # 如果已经有同一 paper_id 更先被匹配到，也允许更新为更高分
                if best_paper_id is None or candidates[cand_idx]["paper_id"] != best_paper_id or score > best_score:
                    best_score = score
                    best_paper_id = candidates[cand_idx]["paper_id"]

        if best_paper_id is not None:
            matches.append({
                "paper_id": best_paper_id,
                "score": round(best_score, 4),
            })
        else:
            matches.append({})

    return matches


def build_citation_graph(paper_id: int) -> dict:
    """构建以本论文为中心的引用图谱，并给出重要性分数与 Top5 基石文献。"""
    paper = db.get_paper(paper_id)
    if paper is None:
        raise LookupError("论文不存在")

    pages = db.get_pages(paper_id)
    parsed = parse_references(pages)
    entries = parsed["entries"]

    if not entries:
        # 没有参考文献：返回明确提示，让调用方知道不是网络或解析出错
        return {
            "paper_id": paper_id,
            "filename": paper["filename"],
            "nodes": [],
            "edges": [],
            "top5": [],
            "reference_page": None,
            "node_count": 0,
            "message": "该论文未解析到参考文献列表",
        }

    # 正文提及次数：只统计 References 之前的页面
    reference_page = parsed.get("reference_page")
    body_pages = [text for number, text in pages if reference_page is None or number < reference_page]
    mentions: dict[int, int] = {}
    for text in body_pages:
        for match in CITATION_RE.finditer(text):
            index = int(match.group(1))
            mentions[index] = mentions.get(index, 0) + 1

    # 建图：中心节点 → 每条被引文献，边权反映提及次数
    graph = nx.DiGraph()
    root_id = f"paper-{paper_id}"
    graph.add_node(root_id, kind="root")

    # 先截取最多 30 条，避免图太大；in_library 匹配也只要处理这部分
    max_entries = 30
    entries = entries[:max_entries]

    # 准备 in_library 匹配：拿到每条 entry 的 title
    entry_titles: list[str] = []
    node_meta: dict[str, dict] = {}
    for entry in entries:
        node_id = f"ref-{entry['index']}"
        detail = _split_entry(entry["text"])
        fame = _fame_score(detail["title"], detail["venue"])
        graph.add_node(node_id, kind="reference", fame=fame)
        # 边的 source_page = 这条引用在原论文里所在的参考文献页
        graph.add_edge(root_id, node_id, weight=1 + mentions.get(entry["index"], 0),
                       source_page=entry["page"])
        node_meta[node_id] = {
            "id": node_id,
            "index": entry["index"],
            "page": entry["page"],
            "source_page": entry["page"],  # 冗余一份，方便前端直接取
            "text": entry["text"],
            "mentions": mentions.get(entry["index"], 0),
            "fame": fame,
            **detail,
        }
        entry_titles.append(detail["title"])

    # 库内匹配
    try:
        match_results = _match_in_library(entry_titles)
    except Exception:
        match_results = [{} for _ in entry_titles]

    for offset, entry in enumerate(entries):
        node_id = f"ref-{entry['index']}"
        match = match_results[offset] if offset < len(match_results) else {}
        if match:
            node_meta[node_id]["in_library"] = True
            node_meta[node_id]["in_library_paper_id"] = match.get("paper_id")
            node_meta[node_id]["in_library_score"] = match.get("score")
        else:
            node_meta[node_id]["in_library"] = False

    # PageRank
    try:
        ranks = nx.pagerank(graph, weight="weight")
    except Exception:
        ranks = {node: 1 / max(len(graph), 1) for node in graph}

    max_rank = max((ranks.get(node, 0) for node in node_meta), default=1) or 1
    max_mentions = max((meta["mentions"] for meta in node_meta.values()), default=1) or 1
    current_year = max((meta["year"] or 0 for meta in node_meta.values()), default=0) or 2017

    nodes: list[dict] = []
    for node_id, meta in node_meta.items():
        rank_norm = ranks.get(node_id, 0) / max_rank
        mention_norm = meta["mentions"] / max_mentions
        recency = 0.0
        if meta["year"]:
            recency = max(0.0, 1 - (current_year - meta["year"]) / 20)

        importance = 100 * (
            0.35 * rank_norm + 0.15 * mention_norm + 0.40 * meta["fame"] + 0.10 * recency
        )
        nodes.append(
            {
                "kind": "reference",
                **meta,
                "importance": round(importance, 1),
                "pagerank": round(ranks.get(node_id, 0), 6),
            }
        )

    nodes.sort(key=lambda item: item["importance"], reverse=True)

    top5 = []
    for node in nodes[:5]:
        reasons = []
        if node["mentions"]:
            reasons.append(f"正文提及 {node['mentions']} 次")
        if node["fame"] >= 0.6:
            reasons.append("标题/出处命中领域经典工作")
        if node["year"]:
            reasons.append(f"{node['year']} 年发表")
        top5.append(
            {
                "index": node["index"],
                "title": node["title"],
                "authors": node["authors"],
                "year": node["year"],
                "importance": node["importance"],
                "mentions": node["mentions"],
                "pagerank": node["pagerank"],
                "reason": "；".join(reasons) or "综合图权重排序",
            }
        )

    root_node = {
        "id": root_id,
        "kind": "root",
        "title": paper["filename"],
        "index": 0,
        "authors": "",
        "year": None,
        "mentions": 0,
        "importance": 100.0,
        "page": 1,
        "source_page": 1,
        "text": f"本论文：{paper['filename']}",
        "in_library": False,
    }

    return {
        "paper_id": paper_id,
        "filename": paper["filename"],
        "nodes": [root_node] + nodes,
        "edges": [
            {
                "source": root_id,
                "target": node["id"],
                "weight": 1 + node["mentions"],
                "source_page": node["source_page"],
            }
            for node in nodes
        ],
        "top5": top5,
        "reference_page": reference_page,
        "node_count": len(nodes),
    }

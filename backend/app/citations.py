"""引用图谱：解析参考文献 → networkx 建图 → 加权打分找基石文献。

思路：
1. 正则把 References 拆成 {编号, 作者, 标题, 年份}；
2. 统计每个编号在正文里被提及的次数（mention），作为"作者重视程度"；
3. networkx 建有向图（本论文 → 被引文献），边权 = 1 + 提及次数，跑 PageRank；
4. 叠加"领域经典度"（标题命中 LSTM/ResNet/Adam 等标志性工作）与发表年份新鲜度，
   合成 0-100 的 importance 分数，取 Top5 作为基石文献。
"""

import re

import networkx as nx

from . import db
from .routers.papers import CITATION_RE, parse_references

# 领域经典工作关键词 → 经典度（0-1）。命中即认为该文献在本领域影响面大。
FAMOUS_KEYWORDS: dict[str, float] = {
    # 具体技术/架构的经典度更高；"attention" 这类通用词在 NMT 领域太普遍，权重压低
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

    # 作者名里的缩写（如 "Yann N. Dauphin"）会被误当成"作者. 标题"的分界，需要识别出来
    split_on_initial = bool(matched) and bool(
        re.search(r"(?:^|\s)[A-Z]\.?$", matched.group("authors").strip())
    )

    if matched and not split_on_initial and not _looks_like_authors(matched.group("title")):
        authors = matched.group("authors").strip()
        title = matched.group("title").strip()
        rest = matched.group("rest").strip()
    else:
        # 兜底：按 ". " 切分后给候选段落打分，挑最像标题的一段
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
    # 修复 PDF 断词造成的 "Convolu- tional" 这类粘连
    title = re.sub(r"(\w)- (\w)", r"\1\2", title)
    return {"authors": authors, "title": title, "venue": rest, "year": year}


def _fame_score(title: str, venue: str) -> float:
    """经典度：标题命中知名工作关键词，或发表在顶会/顶刊。"""
    lowered = f"{title} {venue}".lower()
    best = 0.0
    for keyword, weight in FAMOUS_KEYWORDS.items():
        if keyword in lowered:
            best = max(best, weight)
    if any(name in lowered for name in TOP_VENUES):
        best = max(best, 0.6)
    return round(best, 3)


def build_citation_graph(paper_id: int) -> dict:
    """构建以本论文为中心的引用图谱，并给出重要性分数与 Top5 基石文献。"""
    paper = db.get_paper(paper_id)
    if paper is None:
        raise LookupError("论文不存在")

    pages = db.get_pages(paper_id)
    parsed = parse_references(pages)
    entries = parsed["entries"]

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

    node_meta: dict[str, dict] = {}
    for entry in entries:
        node_id = f"ref-{entry['index']}"
        detail = _split_entry(entry["text"])
        fame = _fame_score(detail["title"], detail["venue"])
        graph.add_node(node_id, kind="reference", fame=fame)
        graph.add_edge(root_id, node_id, weight=1 + mentions.get(entry["index"], 0))
        node_meta[node_id] = {
            "id": node_id,
            "index": entry["index"],
            "page": entry["page"],
            "text": entry["text"],
            "mentions": mentions.get(entry["index"], 0),
            "fame": fame,
            **detail,
        }

    # PageRank：边权越大表示本论文越依赖该文献
    try:
        ranks = nx.pagerank(graph, weight="weight")
    except Exception:
        ranks = {node: 1 / max(len(graph), 1) for node in graph}

    max_rank = max((ranks.get(node, 0) for node in node_meta), default=1) or 1
    max_mentions = max((meta["mentions"] for meta in node_meta.values()), default=1) or 1
    current_year = max((meta["year"] or 0) for meta in node_meta.values()) or 2017

    nodes: list[dict] = []
    for node_id, meta in node_meta.items():
        rank_norm = ranks.get(node_id, 0) / max_rank
        mention_norm = meta["mentions"] / max_mentions
        # 年份新鲜度：越接近最新年份越高，老经典打折但不为零
        recency = 0.0
        if meta["year"]:
            recency = max(0.0, 1 - (current_year - meta["year"]) / 20)

        # 加权：图结构 35% + 被提及强度 15% + 领域经典度 40% + 新鲜度 10%
        importance = 100 * (
            0.35 * rank_norm + 0.15 * mention_norm + 0.40 * meta["fame"] + 0.10 * recency
        )
        nodes.append(
            {
                "kind": "reference",  # 前端据此区分中心节点与引用节点
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
        "text": f"本论文：{paper['filename']}",
    }

    return {
        "paper_id": paper_id,
        "filename": paper["filename"],
        "nodes": [root_node] + nodes,
        "edges": [
            {"source": root_id, "target": node["id"], "weight": 1 + node["mentions"]}
            for node in nodes
        ],
        "top5": top5,
        "reference_page": reference_page,
        "node_count": len(nodes),
    }

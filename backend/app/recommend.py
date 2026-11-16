"""论文推荐：用库内论文的关键词共现去找 arXiv 上相关的新论文。

为什么不用向量相似度：推荐是"发现库外新论文"，库外论文没有向量；
关键词共现可解释（前端能直接展示"共同关注 attention、transformer"），
也避免了每次推荐都额外调用 embedding 接口。
"""

import math
import re
from collections import Counter

from . import arxiv_client, db

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z\-]{3,}")

# 学术文本里高频但几乎没有区分度的词：参与统计只会把推荐拉向"任何一篇论文"。
STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
    "have", "has", "been", "which", "these", "those", "such", "than", "then",
    "also", "more", "most", "can", "may", "not", "but", "our", "their", "its",
    "paper", "papers", "work", "works", "approach", "approaches", "method",
    "methods", "result", "results", "show", "shows", "shown", "propose",
    "proposed", "present", "presented", "using", "used", "use", "based",
    "model", "models", "data", "dataset", "datasets", "training", "train",
    "performance", "experiment", "experiments", "evaluation", "table", "figure",
    "section", "et", "al", "however", "thus", "therefore", "between", "each",
    "other", "into", "when", "where", "while", "there", "here", "about",
    "would", "could", "should", "first", "second", "new", "two", "one", "all",
    "some", "many", "much", "very", "well", "only", "both", "over", "under",
    "introduction", "conclusion", "related", "recent", "research", "study",
    "case", "improving", "improve", "time", "years", "need", "you", "your",
    "understanding", "review", "survey", "toward", "towards", "university",
}


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _keywords_of(text: str) -> set[str]:
    return {
        token.lower()
        for token in _TOKEN_RE.findall(text or "")
        if token.lower() not in STOPWORDS
    }


def library_keywords(limit: int = 6) -> list[str]:
    """统计库内论文关键词：文档频率（出现在几篇论文里）为主，词频为辅。

    优先用结构化抽取出的标题——正文开头混着 arXiv 页眉、版权声明，
    统计出来的多是 introduction/recent 这类无区分度的词。
    只有一篇论文时没有共现可言，退化为该论文的自身关键词。
    """
    seen: set[str] = set()
    titles: list[str] = []
    for title in db.list_structure_titles():
        key = _normalize(title)
        # v1/v7 这类同一论文的不同版本标题相同，去重后再统计
        if key and key not in seen:
            seen.add(key)
            titles.append(title)

    if len(titles) < 2:
        samples = db.list_paper_samples()
        if not samples:
            return []
        counts = Counter()
        for sample in samples:
            for word in _keywords_of(sample["sample"]):
                counts[word] += 1
        return [word for word, _ in counts.most_common(limit)]

    document_frequency: Counter = Counter()
    term_frequency: Counter = Counter()
    for title in titles:
        words = _keywords_of(title)
        for word in words:
            document_frequency[word] += 1
            term_frequency[word] += 1

    scored = {
        word: document_frequency[word] * math.log(1 + term_frequency[word])
        for word, frequency in document_frequency.items()
        if frequency >= 2
    }
    if not scored:
        # 库内论文主题差异大时没有共现词，退化为"全部标题关键词"，
        # 至少让推荐基于当前领域，而不是直接返回空列表。
        scored = {
            word: math.log(1 + frequency)
            for word, frequency in term_frequency.items()
        }
    ranked = sorted(scored.items(), key=lambda item: item[1], reverse=True)
    return [word for word, _ in ranked[:limit]]


def _base_id(arxiv_id: str) -> str:
    """1706.03762v7 → 1706.03762，用于判断库内是否已有同一篇论文。"""
    return re.sub(r"v\d+$", "", (arxiv_id or "").split("/")[-1])


def _already_in_library(arxiv_id: str) -> bool:
    base = _base_id(arxiv_id)
    if not base:
        return False
    for paper in db.list_papers():
        if base in paper["filename"]:
            return True
    return False


def build_recommendations(limit: int = 3) -> dict:
    """返回推荐列表；库内不足两篇时给出明确提示，而不是硬凑结果。"""
    keywords = library_keywords()
    if not keywords:
        return {
            "keywords": [],
            "items": [],
            "message": "库内论文太少，暂无法统计关键词共现，请先导入至少一篇论文。",        }

    try:
        candidates = arxiv_client.search_multi(keywords, max_results=12)
    except Exception as exc:  # 网络/限流失败不能影响论文库页面打开
        return {"keywords": keywords, "items": [], "message": f"arXiv 检索失败：{exc}"}

    keyword_set = set(keywords)
    ranked: list[dict] = []
    for item in candidates:
        if _already_in_library(item["arxiv_id"]):
            continue
        haystack = _keywords_of(f"{item['title']} {item['summary']}")
        matched = [word for word in keywords if word in haystack]
        if not matched:
            continue
        ranked.append(
            {
                **item,
                "matched_keywords": matched,
                "match_score": round(len(matched) / len(keyword_set), 3),
                "has_github": bool(item["github_url"]),
            }
        )

    ranked.sort(key=lambda item: (item["match_score"], item["year"]), reverse=True)
    items = ranked[:limit]

    for item in items:
        words = "、".join(item["matched_keywords"])
        item["reason"] = f"与库内论文共同关注：{words}"
        if item["has_github"]:
            item["reason"] += "；已开源（含 GitHub 仓库）"

    return {"keywords": keywords, "items": items, "message": ""}

"""arXiv 检索与 PDF 下载：直接调用官方 Atom 接口，不额外引入 arXiv SDK。

两种入参模式：
1. arXiv ID（1706.03762、arXiv:1706.03762v7、hep-th/9901001）→ id_list 精确查询；
2. 标题/关键词 → search_query=all:... 相关度排序。
"""

import re
import xml.etree.ElementTree as ET

import httpx

from . import config

ARXIV_API = config.ARXIV_API_BASE
ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"

# 新式 ID：1706.03762 / 1706.03762v7；老式分类 ID：hep-th/9901001
_NEW_ID_RE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$", re.IGNORECASE)
_OLD_ID_RE = re.compile(r"^[a-z\-]+(\.[A-Z]{2})?/\d{7}(v\d+)?$", re.IGNORECASE)

# arXiv 摘要里常见的代码仓库链接；结尾的标点/`.git` 要剥掉，否则链接打不开。
_GITHUB_RE = re.compile(r"https?://(?:www\.)?github\.com/[\w.\-]+/[\w.\-]+", re.IGNORECASE)


def looks_like_id(query: str) -> bool:
    """判断输入是 arXiv ID 还是检索关键词。"""
    cleaned = re.sub(r"(?i)^arxiv:\s*", "", query.strip())
    return bool(_NEW_ID_RE.match(cleaned) or _OLD_ID_RE.match(cleaned))


def normalize_id(query: str) -> str:
    """去掉 arXiv: 前缀，保留版本号（下载 v1/v7 需要版本信息）。"""
    return re.sub(r"(?i)^arxiv:\s*", "", query.strip())


def extract_github_url(text: str) -> str:
    """从摘要/正文中提取第一个 GitHub 仓库链接，没有则返回空串。"""
    matched = _GITHUB_RE.search(text or "")
    if not matched:
        return ""
    url = matched.group(0).rstrip(".,;)]}>'\"")
    return url[:-4] if url.lower().endswith(".git") else url


def _quote_phrase(keyword: str) -> str:
    """关键词整体加引号，避免 arXiv 把多词短语拆成 OR 检索。"""
    return f'all:"{keyword}"' if " " in keyword else f"all:{keyword}"


def _build_params(query: str, max_results: int) -> dict:
    query = query.strip()
    if looks_like_id(query):
        return {"id_list": normalize_id(query), "max_results": max_results}
    return {
        "search_query": _quote_phrase(query),
        "start": 0,
        "max_results": max_results,
        "sortBy": "relevance",
        "sortOrder": "descending",
    }


def _parse_entry(entry: ET.Element) -> dict:
    """把 Atom 条目转成扁平 dict；缺字段一律给空值，调用方不必判空。"""
    title = " ".join((entry.findtext(f"{ATOM}title") or "").split())
    summary = " ".join((entry.findtext(f"{ATOM}summary") or "").split())
    published = entry.findtext(f"{ATOM}published") or ""
    abs_url = entry.findtext(f"{ATOM}id") or ""
    arxiv_id = abs_url.rsplit("/abs/", 1)[-1]
    authors = [
        (author.findtext(f"{ATOM}name") or "").strip()
        for author in entry.findall(f"{ATOM}author")
    ]
    pdf_url = ""
    for link in entry.findall(f"{ATOM}link"):
        if link.get("title") == "pdf":
            pdf_url = link.get("href") or ""
            break
    if not pdf_url and arxiv_id:
        pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
    # comment 里经常写"代码已开源：github.com/xxx"，是推荐接口判断是否有代码的依据之一
    comment = " ".join((entry.findtext(f"{ARXIV_NS}comment") or "").split())
    year = published[:4] if published else ""

    return {
        "arxiv_id": arxiv_id,
        "title": title,
        "authors": authors,
        "year": year,
        "summary": summary,
        "comment": comment,
        "abs_url": abs_url.replace("http://", "https://"),
        "pdf_url": pdf_url.replace("http://", "https://"),
        "github_url": extract_github_url(f"{summary} {comment}"),
    }


def _request(params: dict) -> list[dict]:
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        response = client.get(
            ARXIV_API,
            params=params,
            headers={"User-Agent": "research-assistant/1.0 (competition demo)"},
        )
        response.raise_for_status()
        root = ET.fromstring(response.text)

    return [
        _parse_entry(entry)
        for entry in root.findall(f"{ATOM}entry")
        if entry.findtext(f"{ATOM}title")
    ]


def search(query: str, max_results: int = 5) -> list[dict]:
    """检索 arXiv，按接口返回顺序（相关度）给出结果列表。"""
    return _request(_build_params(query, max_results))


def search_multi(keywords: list[str], max_results: int = 10) -> list[dict]:
    """多个关键词用 OR 拼接检索，供推荐接口按主题拓宽召回。"""
    if not keywords:
        return []
    params = {
        "search_query": " OR ".join(_quote_phrase(keyword) for keyword in keywords),
        "start": 0,
        "max_results": max_results,
        "sortBy": "relevance",
        "sortOrder": "descending",
    }
    return _request(params)


def download_pdf(pdf_url: str) -> bytes:
    """下载 arXiv PDF（约 1-5MB），校验文件头，防止把错误页当 PDF 入库。"""
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        response = client.get(
            pdf_url,
            headers={"User-Agent": "research-assistant/1.0 (competition demo)"},
        )
        response.raise_for_status()
        content = response.content

    if not content.startswith(b"%PDF"):
        raise RuntimeError("arXiv 返回的内容不是 PDF（可能限流或链接失效）")
    return content

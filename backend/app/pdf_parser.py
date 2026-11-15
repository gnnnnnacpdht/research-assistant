"""PDF 文本提取：用 PyMuPDF 逐页读取文本，供入库与后续 RAG 使用。"""

from pathlib import Path

import pymupdf


def extract_pages(pdf_path: Path) -> list[tuple[int, str]]:
    """返回 [(页码, 文本), ...]，页码从 1 开始，与阅读器页码一致。"""
    with pymupdf.open(pdf_path) as document:
        return [
            (page_number, page.get_text("text"))
            for page_number, page in enumerate(document, start=1)
        ]

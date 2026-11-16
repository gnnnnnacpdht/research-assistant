"""PDF 文本提取：用 PyMuPDF 逐页读取文本，扫描页转图片后走多模态 OCR。"""

import logging
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from . import config, ocr

logger = logging.getLogger(__name__)


@dataclass
class ParsedPage:
    """一页的解析结果：页码、正文、是否由 OCR 识别而来。"""

    page_number: int
    text: str
    ocr: bool


def extract_pages(pdf_path: Path) -> list[ParsedPage]:
    """逐页提取文本；某页文字少于阈值即判定为扫描页，渲染成图片后 OCR。

    返回页码从 1 开始，与阅读器页码一致。
    """
    pages: list[ParsedPage] = []
    scanned: list[tuple[int, bytes]] = []

    with pymupdf.open(pdf_path) as document:
        for page_number, page in enumerate(document, start=1):
            text = page.get_text("text")
            if len(text.strip()) >= config.OCR_MIN_CHARS:
                pages.append(ParsedPage(page_number, text, False))
                continue
            # 扫描页没有文字层，只能把像素交给多模态模型。
            png = page.get_pixmap(dpi=config.OCR_DPI).tobytes("png")
            pages.append(ParsedPage(page_number, text, True))
            scanned.append((page_number, png))

    if not scanned:
        return pages

    logger.info("检测到 %s 个扫描页，开始 OCR", len(scanned))
    recognized, failures = ocr.recognize_pages(scanned)

    for index, page in enumerate(pages):
        if not page.ocr:
            continue
        text = recognized.get(page.page_number, "").strip()
        if text:
            pages[index] = ParsedPage(page.page_number, text, True)
        else:
            # 识别失败：退回原始文本并把标记改回 False，避免把空内容标记成"已 OCR"。
            pages[index] = ParsedPage(page.page_number, page.text, False)

    if failures:
        logger.warning("OCR 失败页数：%s/%s", len(failures), len(scanned))
    return pages

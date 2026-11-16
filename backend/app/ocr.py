"""扫描页 OCR：把 PDF 页面渲染成图片，交给多模态模型识别成纯文本。

为什么用云端多模态模型而不是本地 OCR：
本地部署 PaddleOCR 等方案要额外下载模型、占用内存，在比赛的两天工期里
不划算；Qwen-VL / GPT-4o 对学术排版的公式、表格、双栏结构识别更稳。
"""

import base64
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

from . import config

logger = logging.getLogger(__name__)

# 指令要点：纯文本、按阅读顺序、不要 Markdown/LaTeX 标记。
# 早期版本允许 LaTeX，结果整页被包成 \begin{center}...，会污染后续检索与前端展示。
OCR_PROMPT = (
    "你是 OCR 引擎。请逐字提取这一页学术论文图片中的全部文字，按阅读顺序输出纯文本。"
    "要求：不要使用 LaTeX 命令、Markdown 或任何排版标记；表格按行输出；"
    "公式用普通 Unicode 字符近似表示；只输出识别到的正文内容。"
)


def ocr_png(png: bytes) -> str:
    """把一张页面图片交给多模态模型识别，返回纯文本。"""
    api_key = config.require_api_key("multimodal")
    image_url = "data:image/png;base64," + base64.b64encode(png).decode()

    with httpx.Client(timeout=180.0) as client:
        response = client.post(
            f"{config.MULTIMODAL_BASE_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": config.VISION_MODEL,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": image_url}},
                            {"type": "text", "text": OCR_PROMPT},
                        ],
                    }
                ],
                "temperature": 0.0,
            },
        )

    if response.status_code != 200:
        # 余额不足、模型未开通都会走到这里，原文透传便于定位。
        raise RuntimeError(
            f"OCR 调用失败（HTTP {response.status_code}）：{response.text[:300]}"
        )

    return response.json()["choices"][0]["message"]["content"].strip()


def recognize_pages(
    pages: list[tuple[int, bytes]]
) -> tuple[dict[int, str], dict[int, str]]:
    """并发识别多页，返回 (成功结果, 失败原因)。

    单页失败不影响其它页：失败页保留调用方原有的空文本，并在失败字典里带上原因。
    """
    results: dict[int, str] = {}
    failures: dict[int, str] = {}
    if not pages:
        return results, failures

    with ThreadPoolExecutor(max_workers=max(1, config.OCR_CONCURRENCY)) as pool:
        futures = {
            pool.submit(ocr_png, png): page_number for page_number, png in pages
        }
        for future in as_completed(futures):
            page_number = futures[future]
            try:
                results[page_number] = future.result()
            except Exception as exc:  # 单页异常要收集起来，不能让整篇解析失败
                logger.warning("第 %s 页 OCR 失败：%s", page_number, exc)
                failures[page_number] = str(exc)

    return results, failures

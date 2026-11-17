"""Playwright 验收截图脚本。

用途：一键截取系统 7 个关键页面，输出到 screenshots/验收/ 供验收核对与文档引用。

运行：
    backend\\.venv\\Scripts\\python.exe scripts\\screenshot.py

前置条件：
    1. 后端已在 http://localhost:8000 启动（脚本会先探测 /api/health）
    2. 已安装 playwright 与 chromium：
       python -m pip install playwright
       python -m playwright install chromium

设计说明：
    - 视口固定 1440x900，与文档排版宽度一致，截图可直接贴进技术文档。
    - waitUntil 用 networkidle，但阅读页由 PDF.js 持续发起 Range 请求，
      可能长时间不静默，所以超时后退回 domcontentloaded 再等 1.5 秒兜底。
    - 问答页会真实发一次请求，最多等 60 秒；等不到引用徽章也会截图，
      并在结果里标注“未检测到引用”，避免把失败截图当成功结果。
"""

import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:8000"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "screenshots" / "验收"

VIEWPORT = {"width": 1440, "height": 900}
SETTLE_MS = 1500        # 每次 goto 之后额外等待，确保图表/懒加载内容渲染完
NAV_TIMEOUT_MS = 45_000
ANSWER_TIMEOUT_MS = 60_000

QUESTION = "BERT-Large 有多少层 Transformer？隐藏维度是多少？"


def check_backend() -> bool:
    """探测后端健康检查接口，避免打开浏览器后看到一片白。"""
    try:
        with urllib.request.urlopen(f"{BASE_URL}/api/health", timeout=5) as resp:
            return resp.status == 200
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return False


def goto(page, path: str) -> None:
    """打开页面：优先等网络静默，超时退回 DOM 就绪，再统一等 1.5 秒。"""
    url = f"{BASE_URL}{path}"
    try:
        page.goto(url, wait_until="networkidle", timeout=NAV_TIMEOUT_MS)
    except PlaywrightTimeoutError:
        # PDF.js / 轮询请求会让 networkidle 一直不成立，降级即可
        page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    page.wait_for_timeout(SETTLE_MS)


def shot(page, filename: str, full_page: bool = False) -> Path:
    """截取当前视口（full_page=True 时截整页）并返回文件路径。"""
    path = OUT_DIR / filename
    page.screenshot(path=str(path), full_page=full_page)
    return path


def capture_home(page) -> Path:
    goto(page, "/")
    return shot(page, "01_首页.png")


def capture_papers(page) -> Path:
    goto(page, "/papers/")
    # 论文表格渲染完再截，避免只有表头
    page.wait_for_selector(".papers-table tbody tr", timeout=15_000)
    page.wait_for_timeout(SETTLE_MS)
    return shot(page, "02_论文库.png")


def capture_reader(page) -> Path:
    goto(page, "/read/?paper_id=27")
    # 等 PDF 画布真正画出来，比固定等待可靠
    page.wait_for_selector(".pdf-canvas-wrap canvas", timeout=30_000)
    page.wait_for_timeout(3_000)
    return shot(page, "03_阅读页.png")


def capture_graph_single(page) -> Path:
    goto(page, "/graph/")
    # 默认就是「单篇图谱」Tab；确认选中论文有值再截
    page.wait_for_selector(".graph-chart canvas", timeout=30_000)
    page.wait_for_function(
        """() => {
            const sel = document.querySelector('.paper-select');
            return !!sel && !!sel.value;
        }""",
        timeout=20_000,
    )
    page.wait_for_timeout(2_500)  # 力导向布局收敛
    return shot(page, "04_引用图谱_单篇.png")


def capture_graph_global(page) -> Path:
    goto(page, "/graph/")
    page.click(".graph-tab-btn:has-text('全局图谱')")
    page.wait_for_selector(".graph-chart canvas", timeout=30_000)
    page.wait_for_timeout(3_000)
    # 全局图谱节点分布在全高画布上，底部还有说明文案，用整页截图才看得全
    return shot(page, "05_引用图谱_全局.png", full_page=True)


def capture_ask(page):
    """提问并等答案，返回 (截图路径, 是否检测到引用标记)。"""
    goto(page, "/ask/")
    page.fill("textarea", QUESTION)
    page.click("button.primary[type='submit']")

    # 先等答案正文出现
    page.wait_for_selector(".answer-text", timeout=ANSWER_TIMEOUT_MS)

    # 再等页码引用徽章；等不到也继续，不能让脚本挂死
    has_citation = True
    try:
        page.wait_for_selector(".cite-badge", timeout=ANSWER_TIMEOUT_MS)
    except PlaywrightTimeoutError:
        has_citation = False

    # 轨迹面板默认展开且很长，会把答案正文挤出视口。
    # 这里先收起、把答案滚到视野内，保证 06 图能看到答案 + 引用徽章。
    page.evaluate("""() => {
        const panel = document.querySelector('details.trace-panel');
        if (panel) panel.removeAttribute('open');
    }""")
    page.locator(".answer-text").first.scroll_into_view_if_needed()
    page.wait_for_timeout(SETTLE_MS)
    return shot(page, "06_问答页.png"), has_citation


def capture_agent_trace(page) -> Path:
    """展开并截取 Agent 推理轨迹面板（06 截图里被临时收起，这里重新展开）。"""
    panel = page.locator("details.trace-panel").first
    panel.wait_for(state="visible", timeout=20_000)
    if panel.get_attribute("open") is None:
        panel.locator("summary").click()
        page.wait_for_timeout(500)
    panel.scroll_into_view_if_needed()
    page.wait_for_timeout(800)
    path = OUT_DIR / "07_Agent轨迹面板.png"
    panel.screenshot(path=str(path))
    return path


def main() -> int:
    if not check_backend():
        print(f"[失败] {BASE_URL} 无法访问。请先启动后端，例如：")
        print(r"  Set-Location d:\keijizhushou\backend")
        print(r"  .\.venv\Scripts\uvicorn.exe app.main:app --host 127.0.0.1 --port 8000")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results: list[tuple[str, Path, str]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1)
        page = context.new_page()
        page.set_default_timeout(30_000)

        print(f"输出目录：{OUT_DIR}")

        steps = [
            ("01_首页", lambda: capture_home(page)),
            ("02_论文库", lambda: capture_papers(page)),
            ("03_阅读页", lambda: capture_reader(page)),
            ("04_引用图谱_单篇", lambda: capture_graph_single(page)),
            ("05_引用图谱_全局", lambda: capture_graph_global(page)),
        ]
        for label, action in steps:
            started = time.time()
            path = action()
            results.append((label, path, f"{time.time() - started:.1f}s"))
            print(f"  已截取 {label}")

        ask_started = time.time()
        ask_path, has_citation = capture_ask(page)
        note = "" if has_citation else "（未检测到页码引用标记）"
        results.append(("06_问答页", ask_path, f"{time.time() - ask_started:.1f}s{note}"))
        print(f"  已截取 06_问答页{note}")

        trace_path = capture_agent_trace(page)
        results.append(("07_Agent轨迹面板", trace_path, "已展开"))
        print("  已截取 07_Agent轨迹面板")

        context.close()
        browser.close()

    print("\n截图清单：")
    total = 0
    for label, path, extra in results:
        size_kb = path.stat().st_size / 1024
        total += size_kb
        print(f"  {path.name:<24} {size_kb:>8.1f} KB   {extra}")
    print(f"  {'合计 ' + str(len(results)) + ' 张':<24} {total:>8.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

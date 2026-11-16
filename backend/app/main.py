"""FastAPI 应用入口：提供系统健康检查、论文接口、RAG 问答接口与 API 文档。"""

import logging
import mimetypes
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import db, rag
from .routers import ask, csv_view, papers, translate

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时建表，并在后台补齐历史论文的向量索引（不阻塞服务启动）。"""
    db.init_db()
    threading.Thread(target=rag.index_pending_papers, daemon=True).start()
    yield


app = FastAPI(
    title="科研助手 API",
    description="全国高校 AI 大模型挑战赛科研助手后端服务。",
    version="0.2.0",
    lifespan=lifespan,
)

# 跨域：支持多个前端地址（本地 + 各类公网演示域名），全部来自环境变量。
raw_origins = os.getenv("FRONTEND_ORIGINS") or os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
allowed_origins = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
# Vercel 预览域名、cpolar 免费隧道的域名都是随机生成的且会变，
# 用正则按域名后缀整段放行，避免每次换地址都要改代码/环境变量。
# 同域部署（前端静态文件由本服务托管）时不会走到跨域分支，此配置仅为分域演示兜底。
origin_regex = os.getenv(
    "FRONTEND_ORIGIN_REGEX",
    r"https?://[a-zA-Z0-9.-]+\.(vercel\.app|cpolar\.cn|cpolar\.top)",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 首次启动就要有可用的数据库结构，导入期直接建表（IF NOT EXISTS）。
db.init_db()

app.include_router(papers.router)
app.include_router(ask.router)
app.include_router(translate.router)
app.include_router(csv_view.router)


@app.get("/api/health", tags=["系统"])
def health_check() -> dict[str, str]:
    """供前端和部署平台确认后端进程可用。"""
    return {"status": "ok", "service": "research-assistant-backend"}


# ---------------------------------------------------------------- 前端静态托管
# 部署形态：frontend 用 `next build`（output: "export"）导出纯静态文件到 frontend/out，
# 由本服务在根路径托管，一个容器一个端口同时提供页面与 /api，因此无需任何跨域配置。
# 该挂载必须放在所有 API 路由之后，否则 "/" 会抢占 /api/* 的匹配。
logger = logging.getLogger("uvicorn.error")

# Windows 上 Python 的 mimetypes 不识别 .mjs，默认按 text/plain 返回，
# 浏览器会拒绝把它当作 ES module 加载（pdf.js worker 报 Failed to fetch dynamically imported module）。
mimetypes.add_type("text/javascript", ".mjs")

FRONTEND_DIST = Path(
    os.getenv("FRONTEND_DIST", Path(__file__).resolve().parent.parent.parent / "frontend" / "out")
)
if FRONTEND_DIST.is_dir():
    # html=True：请求目录时自动返回 index.html，并把 /read 301 到 /read/
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    logger.info("已挂载前端静态文件：%s", FRONTEND_DIST)
else:
    # 本地开发时前端跑在 3000 端口，没有 out/ 目录属于正常情况
    logger.warning("未找到前端静态目录 %s，仅提供 API（本地开发请单独启动 pnpm dev）", FRONTEND_DIST)


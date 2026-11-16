"""FastAPI 应用入口：提供系统健康检查、论文接口、RAG 问答接口与 API 文档。"""

import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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

# 跨域：支持多个前端地址（本地 + Vercel 正式域名 + 预览域名），全部来自环境变量。
raw_origins = os.getenv("FRONTEND_ORIGINS") or os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
allowed_origins = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
# Vercel 每次 PR 都会生成随机预览域名，用正则放行，避免反复改环境变量
origin_regex = os.getenv("FRONTEND_ORIGIN_REGEX", r"https://[a-z0-9-]+\.vercel\.app")
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

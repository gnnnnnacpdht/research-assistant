"""FastAPI 应用入口：提供系统健康检查、论文接口、RAG 问答接口与 API 文档。"""

import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, rag
from .routers import ask, papers

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

# 仅允许配置中的前端地址跨域访问，地址通过环境变量注入。
frontend_origin = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 首次启动就要有可用的数据库结构，导入期直接建表（IF NOT EXISTS）。
db.init_db()

app.include_router(papers.router)
app.include_router(ask.router)


@app.get("/api/health", tags=["系统"])
def health_check() -> dict[str, str]:
    """供前端和部署平台确认后端进程可用。"""
    return {"status": "ok", "service": "research-assistant-backend"}

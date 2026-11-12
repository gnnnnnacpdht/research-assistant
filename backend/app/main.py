"""FastAPI 应用入口：提供系统健康检查与交互式 API 文档。"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="科研助手 API",
    description="全国高校 AI 大模型挑战赛科研助手后端服务。",
    version="0.1.0",
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


@app.get("/api/health", tags=["系统"])
def health_check() -> dict[str, str]:
    """供前端和部署平台确认后端进程可用。"""
    return {"status": "ok", "service": "research-assistant-backend"}

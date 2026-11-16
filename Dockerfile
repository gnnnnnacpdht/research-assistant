# syntax=docker/dockerfile:1
# 部署形态：一个容器同时提供前端页面与后端 API（Hugging Face Spaces / 任意 Docker 平台）
#   - 阶段 1 在 Node 里把 Next.js 导出成纯静态文件（out/）
#   - 阶段 2 在 Python 镜像里跑 FastAPI，并用 StaticFiles 托管 out/，统一监听 7860 端口

# ---------------------------------------------------------------
# 阶段 1：构建前端静态站点（next.config.js 已设置 output: "export"）
# ---------------------------------------------------------------
FROM node:22-slim AS frontend-builder
WORKDIR /build/frontend

# 先只拷贝依赖清单，让依赖安装层能被 Docker 缓存，改业务代码时不必重装
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY frontend/ ./
# 构建期不注入 NEXT_PUBLIC_API_BASE_URL，前端因此使用相对路径 /api 请求同域后端
RUN pnpm build

# ---------------------------------------------------------------
# 阶段 2：Python 运行时
# ---------------------------------------------------------------
FROM python:3.11-slim

# Hugging Face Spaces 推荐用 UID 1000 的非 root 用户运行
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1
WORKDIR $HOME/app

COPY --chown=user backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir --user -r backend/requirements.txt

COPY --chown=user backend/ backend/
# 前端产物放在 backend 的同级目录，app/main.py 默认从 ../frontend/out 读取
COPY --chown=user --from=frontend-builder /build/frontend/out frontend/out

WORKDIR $HOME/app/backend
EXPOSE 7860
# 不使用 --reload：Windows/容器里 reload 会重启进程，清空内存中的去重待确认队列
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]

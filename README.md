# 科研助手

全国高校 AI 大模型挑战赛参赛项目。当前为最小可运行骨架：Next.js 14 前端、FastAPI 后端及后端健康检查接口。

## 目录结构

```text
backend/             FastAPI 服务
  app/main.py        应用入口与健康检查
  pyproject.toml     Python 项目与依赖配置
frontend/            Next.js 14（App Router）应用
  app/page.js        首页
  app/layout.js      全局布局
  app/globals.css    全局样式
.env.example         环境变量模板（不包含真实密钥）
```

## 环境要求

- Node.js 20+ 与 pnpm
- Python 3.11+（Windows 可使用 `py` 启动器）
- uv（若未安装，执行 `py -m pip install --user uv`）
- Git

当前健康检查不需要 API 密钥。后续接入模型时，将 `.env.example` 复制为 `.env` 并填写密钥；`.env` 已被 Git 忽略，不要提交真实密钥。

## 本地启动

以下命令均在 PowerShell 中执行。先后端、后前端，分别使用一个终端。

### 1. 启动后端

```powershell
Set-Location d:\keijizhushou\backend
py -m uv sync
py -m uv run uvicorn app.main:app --reload
```

如果 `uv` 已加入 PATH，也可以将 `py -m uv` 替换为 `uv`。

另开一个终端验证健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

预期返回 `status: ok`。交互式 API 文档地址为 <http://127.0.0.1:8000/docs>。

### 2. 启动前端

```powershell
Set-Location d:\keijizhushou\frontend
pnpm install
pnpm dev
```

浏览器访问 <http://localhost:3000>。首页的“检查后端状态”和“查看 API 文档”按钮分别连接后端健康检查与 Swagger 文档。

### 3. 验证前端生产构建

```powershell
Set-Location d:\keijizhushou\frontend
pnpm build
```

## 后续模块

按 `PROJECT.md` 的顺序实现 PDF 上传与解析、抗幻觉 RAG 问答、语义去重，再逐步增加双语阅读与引用图谱。

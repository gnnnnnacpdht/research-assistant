---
title: 科研助手 Research Assistant
emoji: 📚
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# 科研助手

全国高校 AI 大模型挑战赛参赛项目：Next.js 14 前端 + FastAPI 后端，支持 PDF 解析入库、扫描件 OCR、
抗幻觉 RAG 问答（带页码溯源）、语义去重与版本对比、双语联动阅读、引用图谱与 CSV 可视化。

## 公网访问

| 项 | 地址 |
|---|---|
| 在线系统（Hugging Face Space） | 待部署后填写：`https://<用户名>-<空间名>.hf.space` |
| 接口文档 | `<公网地址>/docs` |
| 健康检查 | `<公网地址>/api/health` |

**测试账号**：当前系统无登录校验，评审直接访问公网地址即可使用。
若后续接入登录，统一使用演示账号 `demo / 123456`。

> Space 免费实例闲置一段时间会休眠，首次访问需等待约 30 秒冷启动；
> 免费实例的磁盘在重新构建/重启后会重置，**评审测试时请重新上传 PDF**
> （官方用例文件在仓库 `pdf/` 目录）。

## 部署方式：单容器同域（Hugging Face Spaces）

前后端合并成**一个 Docker 容器、一个端口 7860**，不依赖 Render/Vercel：

1. 前端 `next.config.js` 设置 `output: "export"`，构建期导出纯静态文件到 `out/`；
   所有页面均为客户端渲染，`/read?paper_id=24` 这类 query 参数路由照常可用。
2. 前端请求统一走**相对路径** `/api`（`lib/apiBase.js`），同域无需任何跨域配置。
3. 后端 `app/main.py` 在全部 API 路由之后用 `StaticFiles` 把 `frontend/out` 挂到根路径，
   页面与接口因此共用 `https://<用户名>-<空间名>.hf.space`。
4. 根目录 `Dockerfile` 两阶段构建：Node 阶段导出前端 → Python 阶段装依赖并运行 uvicorn。

### 在 Hugging Face 上创建 Space

1. 注册/登录 <https://huggingface.co>，New → Space，SDK 选择 **Docker**，模板选 Blank。
2. 在 Space 的 **Settings → Variables and secrets** 添加 Secret：
   `DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY`（`MULTIMODAL_API_KEY` 可选，留空复用前者）。
3. 把本仓库推送到 Space 仓库（Space 的 README 首部必须保留上面的 `sdk: docker` 配置）：

   ```powershell
   git remote add hf https://huggingface.co/spaces/<用户名>/<空间名>
   git push hf main
   ```

4. 等待 Building → Running，访问 `https://<用户名>-<空间名>.hf.space`。

### 本地验证同域形态（不装 Docker 也能验证）

```powershell
Set-Location d:\keijizhushou\frontend
pnpm build            # 生成 out/ 静态站点
Set-Location d:\keijizhushou\backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

浏览器打开 <http://127.0.0.1:8000> 即前后端合体后的效果（`/docs` 仍是接口文档）。

## 环境变量清单（不含密钥值）

容器/Space（Settings → Variables and secrets，均选 Secret 类型）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | DeepSeek 文本模型密钥（问答/翻译/图注/版本对比） |
| `SILICONFLOW_API_KEY` | 是 | BGE-M3 向量化与 bge-reranker 重排 |
| `MULTIMODAL_API_KEY` | 否 | 扫描件 OCR 的多模态密钥，留空则复用 `SILICONFLOW_API_KEY` |
| `DEEPSEEK_BASE_URL` / `SILICONFLOW_BASE_URL` | 否 | 自定义网关时填写 |
| `VISION_MODEL` | 否 | 默认 `Qwen/Qwen3-VL-32B-Instruct` |
| `FRONTEND_ORIGINS` | 否 | 仅在前后端分离部署时需要；同域部署留空即可 |

前端构建期变量（同域部署**不要**设置）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | 否 | 只有前后端分域时才需要，填后端绝对地址；留空即走相对路径 `/api` |

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

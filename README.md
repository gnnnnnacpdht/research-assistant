# 科研助手

全国高校 AI 大模型挑战赛参赛项目：Next.js 14 前端 + FastAPI 后端，支持 PDF 解析入库、扫描件 OCR、
抗幻觉 RAG 问答（带页码溯源）、语义去重与版本对比、双语联动阅读、引用图谱与 CSV 可视化。

## 公网访问

| 项 | 地址 |
|---|---|
| 前端（Vercel） | 待部署后填写：`https://<your-app>.vercel.app` |
| 后端 API（Render） | 待部署后填写：`https://<your-service>.onrender.com` |
| 接口文档 | `<后端地址>/docs` |

**测试账号**：当前系统无登录校验，评审直接访问前端地址即可使用。
若后续接入登录，统一使用演示账号 `demo / 123456`。

> Render 免费实例闲置一段时间会休眠，首次访问需等待约 30 秒冷启动。
> 免费版磁盘在重新部署/休眠回收后会重置，**评审测试时请重新上传 PDF**
> （官方用例文件在仓库 `pdf/` 目录）。

## 环境变量清单（不含密钥值）

后端（Render 后台配置）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | DeepSeek 文本模型密钥（问答/翻译/图注/版本对比） |
| `SILICONFLOW_API_KEY` | 是 | BGE-M3 向量化与 bge-reranker 重排 |
| `MULTIMODAL_API_KEY` | 否 | 扫描件 OCR 的多模态密钥，留空则复用 `SILICONFLOW_API_KEY` |
| `FRONTEND_ORIGINS` | 是 | 允许跨域的前端地址，多个用英文逗号分隔 |
| `FRONTEND_ORIGIN_REGEX` | 否 | 默认已放行 `https://*.vercel.app` |
| `DEEPSEEK_BASE_URL` / `SILICONFLOW_BASE_URL` | 否 | 自定义网关时填写 |
| `VISION_MODEL` | 否 | 默认 `Qwen/Qwen3-VL-32B-Instruct` |

前端（Vercel 后台配置）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | 是 | Render 后端地址，例如 `https://xxx.onrender.com`；也兼容 `NEXT_PUBLIC_API_BASE` |

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

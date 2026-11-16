# 科研助手

全国高校 AI 大模型挑战赛参赛项目：Next.js 14 前端 + FastAPI 后端，支持 PDF 解析入库、扫描件 OCR、
抗幻觉 RAG 问答（带页码溯源）、语义去重与版本对比、双语联动阅读、引用图谱与 CSV 可视化。

## 公网演示地址（cpolar 内网穿透）

| 项 | 地址 |
|---|---|
| **前端（评审从这里进）** | http://4e20ce8f.r1.cpolar.top |
| 后端 API | http://25d17385.r1.cpolar.top |
| 接口文档 Swagger | http://25d17385.r1.cpolar.top/docs |
| 健康检查 | http://25d17385.r1.cpolar.top/api/health |
| **备用入口（同域单隧道）** | http://25d17385.r1.cpolar.top/ （后端同时托管前端静态页） |

**测试账号**：当前系统无登录校验，评审直接访问前端地址即可使用。
若后续接入登录，统一使用演示账号 `demo / 123456`。

> **演示前必读**
> - 隧道跑在开发机上，**演示期间必须保持本机开机、后端(8000)/前端(3000)进程与 cpolar 隧道都在线**。
> - cpolar 免费版使用随机域名，**重启隧道后地址会变**，需同步更新本表与 `frontend/.env.local`。
> - 首次打开若出现 cpolar 安全提示页，点继续即可。
> - 数据存在本机 SQLite/Chroma，不会随隧道重置；若换机部署需重新上传 PDF
>   （官方用例文件在仓库 `pdf/` 目录）。

## 部署方式一（当前）：cpolar 内网穿透，前后端分域

适合快速公网演示，无需云服务器、无需 Docker：

1. 本地正常启动后端(8000)与前端(3000)，见下文"本地启动"。
2. cpolar 建两条 `http` 隧道：一条到本地 `8000`（后端），一条到本地 `3000`（前端），
   均选随机域名、地区 China。
3. 前端通过 `frontend/.env.local` 指向后端公网地址（该文件已被 Git 忽略）：

   ```bash
   NEXT_PUBLIC_API_BASE=http://25d17385.r1.cpolar.top
   ```

   修改后**必须重启 `pnpm dev`** 才会生效（`NEXT_PUBLIC_*` 是构建/启动期注入的）。
4. 后端 CORS 用正则按域名后缀放行（`backend/app/main.py` 的 `FRONTEND_ORIGIN_REGEX`），
   默认已覆盖 `*.cpolar.cn` / `*.cpolar.top` / `*.vercel.app`，换随机域名也不用改代码。

## 部署方式二（备选）：单容器同域

适合正式部署到云服务器或容器平台，**一个容器一个端口**同时服务页面与接口：

1. 前端 `next.config.js` 设置 `output: "export"`，构建期导出纯静态文件到 `out/`；
   所有页面均为客户端渲染，`/read?paper_id=24` 这类 query 参数路由照常可用。
2. 前端请求默认走**相对路径** `/api`（`lib/apiBase.js`），同域无需任何跨域配置。
3. 后端 `app/main.py` 在全部 API 路由之后用 `StaticFiles` 把 `frontend/out` 挂到根路径。
4. 根目录 `Dockerfile` 两阶段构建：Node 阶段导出前端 → Python 阶段装依赖并运行 uvicorn(7860)。

> 该形态下**只需一条隧道穿透 8000** 即可获得完整系统的公网地址，即上表的"备用入口"。

### 本地验证同域形态（不装 Docker 也能验证）

```powershell
Set-Location d:\keijizhushou\frontend
pnpm build            # 生成 out/ 静态站点
Set-Location d:\keijizhushou\backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

浏览器打开 <http://127.0.0.1:8000> 即前后端合体后的效果（`/docs` 仍是接口文档）。

## 环境变量清单（不含密钥值）

后端（项目根目录 `.env`，已被 Git 忽略）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | DeepSeek 文本模型密钥（问答/翻译/图注/版本对比） |
| `SILICONFLOW_API_KEY` | 是 | BGE-M3 向量化与 bge-reranker 重排 |
| `MULTIMODAL_API_KEY` | 否 | 扫描件 OCR 的多模态密钥，留空则复用 `SILICONFLOW_API_KEY` |
| `DEEPSEEK_BASE_URL` / `SILICONFLOW_BASE_URL` | 否 | 自定义网关时填写 |
| `VISION_MODEL` | 否 | 默认 `Qwen/Qwen3-VL-32B-Instruct` |
| `FRONTEND_ORIGINS` | 否 | 额外允许的前端来源，多个用英文逗号分隔 |
| `FRONTEND_ORIGIN_REGEX` | 否 | 默认已放行 `*.cpolar.cn` / `*.cpolar.top` / `*.vercel.app` |

前端（`frontend/.env.local`，已被 Git 忽略）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_API_BASE` | 分域时必填 | 后端绝对地址，如 `http://25d17385.r1.cpolar.top`；也兼容 `NEXT_PUBLIC_API_BASE_URL`。**留空则走相对路径 `/api`**（同域部署/纯本地开发） |


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

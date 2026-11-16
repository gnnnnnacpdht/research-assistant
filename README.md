# AI 科研助手

基于大模型与 Agent 架构的全流程科研助手：从 PDF 解析入库、抗幻觉问答与页码溯源，到语义去重、双语阅读、引用图谱和学术写作辅助。

## 公网演示

**评审入口：<http://25d17385.r1.cpolar.top>**

- 前端与后端 API 同域部署，打开上述地址即可使用，无需登录。
- Swagger 接口文档：<http://25d17385.r1.cpolar.top/docs>
- 健康检查：<http://25d17385.r1.cpolar.top/api/health>
- **服务由内网穿透承载，评审时段保持在线。** 演示依赖开发机、本地服务与 cpolar 隧道持续运行；免费隧道的随机域名在隧道重建后可能变化。

### 使用说明

1. 进入「论文库」，上传 PDF，或输入 arXiv ID / 关键词导入论文；官方测试文件位于仓库 `pdf/` 目录。
2. 上传相似论文时，在预警弹窗中选择「保留两个版本」「覆盖旧版本」，或先查看 AI 版本差异。
3. 进入「智能问答」，选择单篇论文进行带页码引用的问答；不指定单篇并输入对比问题，可进行跨论文比较。
4. 点击论文的「阅读」进入双语联动阅读；点击「图谱」查看引用网络、基石文献并生成自动综述。
5. 进入「写作 Copilot」生成论文框架、架构图脚本，或上传 CSV 生成学术图表与图注。

## 已实现功能

### 1. PDF 解析、OCR 与结构化入库

- 矢量 PDF 使用 PyMuPDF 按页提取文本，保留文件名、页码与原文片段。
- 自动检测低文本量扫描页，将页面转图片后调用多模态模型 OCR，不在本地部署 OCR 引擎。
- 文本切块、BGE-M3 向量化并写入 Chroma，支持 541 页长文档分块与索引。
- 自动抽取标题、作者机构、摘要、章节标题树、表格、公式与参考文献，阅读页提供结构化视图。

### 2. 抗幻觉 RAG、Agent 与跨论文对比

- BGE-M3 向量召回 + bge-reranker 精排 + DeepSeek 受约束生成。
- retrieve → rerank → generate → verify 显式 Agent 状态机，前端展示推理轨迹。
- 答案携带可点击的页码徽章与原文片段；引用校验失败时自动扩大召回并重检索，最多 2 轮。
- 校验仍不通过的引用会被移除，模型被要求在证据不足时明确说明。
- 支持跨论文架构对比：按论文聚合证据、分条作答，并联合校验论文编号与页码。

### 3. 语义去重与版本差异

- 上传时基于全文语义词向量计算余弦相似度，而不是依赖文件名。
- 默认阈值 `0.92`；实测 v1/v7 相似度 `94.9%`，将 v1 改名为 `mypaper.pdf` 仍会预警。
- 支持保留两个版本、覆盖旧版本、取消上传。
- 调用 DeepSeek 对比两版内容，归纳总体变化、修订章节、关键数字差异与一句话总结。

### 4. 中英双语联动阅读

- PDF.js 原版渲染与透明文本层，支持划词翻译、整页翻译和整篇翻译。
- 翻译结果异步缓存；标题树点击跳页，双栏按比例同步滚动且可关闭。
- 正文引用编号与 References 双向跳转。
- PDF 页面按需渲染并缓存当前页与相邻页，适配长文档和窄屏。

### 5. 引用图谱、自动综述与 arXiv

- 解析 References 建立引用网络，NetworkX 计算 PageRank，结合正文提及、领域经典度和年份计算 importance。
- ECharts 力导向图展示引用关系、基石文献光晕、邻接高亮、缩放复位与节点详情。
- 基于论文和引用网络生成带 `[n]` 引用的领域综述及 Future Work，避免把论文已解决的方案当作未来方向。
- 支持 arXiv ID / 关键词检索并下载入库、引用含金量筛选、GitHub 复现徽章与相似论文推荐。

### 6. 学术写作 Copilot

- 生成六节论文框架；Related Work 引用需通过库内文献二次校验，降低虚构引用风险。
- 生成 Mermaid / TikZ 架构图脚本，支持中文学术文本译英。
- CSV 自动识别数值列与类别列并输出统计，Chart.js 绘制柱状图、折线图和表格视图。
- DeepSeek 根据真实统计量生成英文 Figure Caption 与中文说明，可复制使用。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React、Next.js 14 App Router（静态导出）、PDF.js、ECharts、Chart.js、KaTeX |
| 后端 | Python 3.11+、FastAPI、PyMuPDF、NetworkX |
| Agent / RAG | 显式状态机、Chroma、BGE-M3、bge-reranker、DeepSeek |
| OCR | 多模态模型 API，默认 `Qwen/Qwen3-VL-32B-Instruct` |
| 部署 | 后端托管前端静态文件的同域形态、Docker、cpolar 内网穿透 |

## 环境变量

复制 `.env.example` 为项目根目录 `.env`，填写真实密钥。`.env` 与 `frontend/.env.local` 均已被 Git 忽略，禁止提交密钥。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 问答、翻译、图注、版本对比与写作生成 |
| `SILICONFLOW_API_KEY` | 是 | BGE-M3 embedding 与 reranker |
| `MULTIMODAL_API_KEY` | 否 | 扫描件 OCR；留空则复用 `SILICONFLOW_API_KEY` |
| `DEEPSEEK_BASE_URL` / `SILICONFLOW_BASE_URL` | 否 | 自定义 API 网关 |
| `VISION_MODEL` | 否 | OCR 模型，默认 `Qwen/Qwen3-VL-32B-Instruct` |
| `CHAT_MODEL` / `EMBEDDING_MODEL` / `RERANK_MODEL` | 否 | 覆盖默认模型名 |
| `RETRIEVE_TOP_K` / `RERANK_TOP_K` | 否 | 召回与精排数量 |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | 否 | 文本切块参数 |
| `QUERY_REWRITE` | 否 | 中文提问是否先改写成英文检索式，默认开启 |
| `OCR_MIN_CHARS` / `OCR_DPI` / `OCR_CONCURRENCY` | 否 | 扫描页检测、渲染清晰度与 OCR 并发 |
| `FRONTEND_ORIGINS` / `FRONTEND_ORIGIN_REGEX` | 否 | 分域开发或部署时的额外 CORS 配置 |

前后端分域开发时，可在 `frontend/.env.local` 设置：

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000
```

同域部署或纯本地静态版请留空，让请求使用相对路径 `/api`。

## 本地启动

环境要求：Node.js 20+、pnpm、Python 3.11+、uv、Git。以下命令在 PowerShell 中执行。

### 方式一：同域运行（推荐，与公网演示一致）

```powershell
Set-Location d:\keijizhushou\frontend
pnpm install
pnpm build

Set-Location d:\keijizhushou\backend
py -m uv sync
py -m uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

浏览器打开 <http://127.0.0.1:8000>；接口文档为 <http://127.0.0.1:8000/docs>。
后端由 `StaticFiles` 托管 `frontend/out`，前端修改后需重新执行 `pnpm build`。

### 方式二：前后端分离开发

先按方式一启动后端，再另开终端：

```powershell
Set-Location d:\keijizhushou\frontend
pnpm install
pnpm dev
```

访问 <http://localhost:3000>。分域开发需在 `frontend/.env.local` 配置后端地址，修改后重启 `pnpm dev`。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

预期返回 `status: ok`。演示去重弹窗时不要使用 `--reload`，避免进程重载清空待确认队列。

### Docker

```powershell
docker build -t research-assistant .
docker run --rm -p 7860:7860 --env-file .env research-assistant
```

访问 <http://127.0.0.1:7860>。Dockerfile 使用两阶段构建：Node 阶段导出前端，Python 阶段安装依赖并启动 uvicorn。

## 目录与验证材料

```text
backend/app/         FastAPI、PDF/OCR、RAG Agent、去重、图谱与写作接口
frontend/app/        首页、论文库、问答、阅读、图谱与 Copilot 页面
pdf/                 官方验收 PDF
samples/             CSV 示例数据
screenshots/         RAG 与长文档验证截图
.screenshots/        去重、双语阅读、图谱与 Copilot 验证截图
docs/                技术文档与演示视频脚本
PROGRESS.md          分模块实测结果、性能数据与开发进度
```

详细实测结果见 [PROGRESS.md](PROGRESS.md)，录制流程见 [演示视频脚本](docs/演示视频脚本.md)。

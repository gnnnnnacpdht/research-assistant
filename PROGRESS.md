# 当前进度快照

更新时间：2026-11-16  
当前阶段：P1-1 双语联动阅读与引用跳转已完成实测；P0 全部完成。

## 2026-11-16 · P1-1 双语联动阅读与引用跳转

### 后端新增

| 接口 | 作用 |
|---|---|
| `GET /api/papers/{id}/file` | 返回原始 PDF，供前端 pdf.js 渲染 |
| `GET /api/papers/{id}/page/{n}` | 返回该页提取文本与总页数 |
| `GET /api/papers/{id}/references` | 解析参考文献条目 + 每个编号在正文的首现页码 |
| `POST /api/translate` | 英文学术文本 → 中文，进程内 LRU 缓存（512 条，命中直接返回 `cached: true`） |
| `GET /api/translate/cache-stats` | 缓存命中情况，便于演示"省钱" |

参考文献解析：取**最后一次**出现的 `References` 标题行作为起点（避开正文/表格里的同名字样），
从该页起按 `[n]` 切分条目，同编号保留文本最长的一条并按编号排序。

### 前端新页面 `/read?paper_id=X`

- 左侧 pdf.js 渲染原版页面：canvas 画图 + 手写文本层（`page.getTextContent()` 逐片段绝对定位、
  按 PDF 实际宽度横向 scaleX），因此可以鼠标拖选。
- 右侧两个标签页：中文翻译（整页）与参考文献（40 条，可滚动）。
- 划词翻译：选中英文 → 选区上方浮出「翻译」按钮 → 调 `/api/translate` → 结果显示在右栏卡片。
- 引用双向跳转：正文页提炼出「本页引用 [1] [2] …」徽章，点 [n] 切到参考文献并滚动高亮；
  文献条目点「↑ 跳到正文 P.x」回到该编号首次出现的页面。
- 论文库每行新增「阅读」入口。

### 实测结果

| 项 | 结果 |
|---|---|
| 首屏左侧 PDF | canvas 1239×1603，第 1/15 页正常渲染 |
| 右侧整页译文 | 正常，含标题、作者、摘要中文 |
| 划词翻译 | 选中 "Provided proper attribution is provided, Google hereby grants permission to" → 译文正确 |
| 引用跳转 | 正文 [3] → 参考文献 [3] 高亮；文献条目 → 回正文 P.4 |
| 翻译缓存 | 第二次相同文本 `cached: true` |

### 踩坑记录

1. **pdfjs-dist 6.x 依赖新版 Chrome**：报 `getOrInsertComputed is not a function`，降级到 4.10.38 解决。
2. **降级后报 API/Worker 版本不匹配**：Next dev 缓存了旧 vendor chunk，删除 `.next` 重启即可。
3. **`-> FileResponse` 返回注解会 500**：FastAPI 会当成 pydantic 响应模型，改用 `response_class=FileResponse`。
4. **`db.get_paper` 未返回 `stored_path`**：补上该字段，PDF 下载接口才能取到文件路径。
5. **首屏空白需刷新**：dev 模式 StrictMode 重挂载导致渲染 effect 在文档销毁后不再触发，
   改为依赖 `docReady` 计数修复。

截图存证：`.screenshots/p1-read/`。

## 2026-11-16 · 收尾：官方顺序二次实测（截图留证）

清空论文库后按官方顺序完整跑了一遍，全部通过：

| 步骤 | 结果 |
|---|---|
| 上传 `1706.03762v7.pdf` | 直接入库，列表 1 条，无弹窗 |
| 上传 `1706.03762v1.pdf` | 弹出预警，显示 **相似度 94.9%**，橙色提示"库中已有更新版本 v7，建议保留两个版本而不是覆盖" |
| 点"点此对比版本差异" | DeepSeek 输出修订摘要（含 En-FR BLEU 41.0 → 41.8 的数值差异） |
| 点"保留两个版本" | 弹窗关闭，列表变 2 条（ID 24 v7、ID 25 v1） |
| 上传改名文件 `mypaper.pdf`（内容同 v1） | **仍触发预警**，与 v1 相似度 100.0%、与 v7 相似度 94.9% → 证明基于语义而非文件名 |

截图存证：`.screenshots/dedupe/`（1-v7直接入库 / 2-v1触发预警94.9 / 3-DeepSeek修订摘要 / 4-保留两个版本后2条 / 5-改名mypaper仍预警）。

## 2026-11-16 · 收尾：去重弹窗体验补强

- 弹窗直接显示**相似度百分比**（0.9489 → 94.9%），不再只写"≥0.92"。
- 新增**版本提示**：库中版本号高于待上传版本时，高亮提示
  "库中已有更新版本 xxx，建议保留两个版本而不是覆盖"。
- 「保留」按钮文案改为「保留两个版本」，含义更直白。
- 说明：预警基于语义而非文件名，把 v1 改名成 `mypaper.pdf` 仍会触发。

## 2026-11-16 · P0-3 语义去重（官方验收用例）

**验收用例：1706.03762v7.pdf 先入库 → 上传 1706.03762v1.pdf 必须基于语义（非文件名）预警。**

### 后端实现（`app/dedupe.py` + `routers/papers.py`）

- 上传解析后，把新论文全文截前 15000 字（BGE-M3 上限 8192 tokens ≈ 20000 字符）
  作为语义指纹，与库内所有已有论文**一次性 batch embedding**，逐对算余弦相似度。
- 阈值 0.92 经实测：v1/v7 余弦 0.9489 ✓；不同论文约 0.7 以下。
- 超过阈值时返回 **HTTP 309**（用 `JSONResponse`，FastAPI 默认 HTTPException 会剥离自定义 headers）：
  body 里带 `{token, filename, duplicates: [{paper_id, filename, similarity}]}`；
  headers 里带 `X-Dedupe-Token` 供前端双保险读取。
- 新增接口：`POST /confirm-keep`（保留为独立条目）、`POST /confirm-overwrite`（覆盖删旧）、
  `POST /compare`（只读暂存，调用 DeepSeek 生成四字段修订摘要：总体判断 / 修订章节 / 关键数字差异 / 一句话总结）、
  `POST /cancel`（清理暂存文件）。
- 待确认队列用进程内 dict + threading.Lock，token 是 uuid hex；compare 用 `peek_pending`
  只读不消费 token，让前端能先看对比再决定覆盖/保留/取消。
- 降级保护：相似检测失败（向量化挂了）时直接放行，不阻塞正常上传。

### 前端实现（`frontend/app/papers/page.js` + `globals.css`）

- 上传流程改为两阶段：正常 201 直接入库；309 时解析 body 拿 token+duplicates，
  弹出遮罩层 Modal。
- Modal 显示已有论文列表，每条点一下调 `/compare` 显示 DeepSeek 修订摘要
  （`revision-box` 灰底卡片）。
- 底部三个主操作："取消上传"（红）、"保留"（灰）、"覆盖"（蓝）。

### 实测结果（接口级 + 浏览器级）

| 步骤 | 预期 | 实际 |
|---|---|---|
| v7 上传 | 201 直接入库 | 201 ✅，98 条向量 |
| v1 上传 | 309 触发预警 | 309 ✅，token+body+header 全对，duplicates.similarity=0.9489 |
| 浏览器弹窗 | 列出已有论文+对比入口 | ✅ |
| 点对比 | DeepSeek 修订摘要 | ✅ 输出四字段结构化修订 |
| confirm-keep | 新条目入库 | ✅ 列表变 2 条 |
| confirm-overwrite | 删旧→新条目 | ✅ 最终只剩 1 条 |
| cancel | 清理暂存文件 | ✅ |

### 踩坑记录

1. **FastAPI HTTPException 剥离自定义 headers**：改成直接 `return JSONResponse(...)`。
2. **全文太长 embedding 接口 400**：BGE-M3 单次上限 8192 tokens ≈ 20000 字符，去重指纹截前 15000 字已足够区分版本（v1/v7 相似度 0.95 vs 不同论文 0.7）。
3. **compare 后 token 失效**：先 dequeue 又 enqueue 用了新 token。修复：compare 用 peek 只读不消费。
4. **Windows --reload 清空内存 pending 队列**：后端稳定运行必须不带 `--reload`。

### 下一步

P1 开始：双语联动阅读、引用图谱。

## 2026-11-16 · 论文删除与向量库同步清理

- 新增 `DELETE /api/papers/{id}`：先删 Chroma 中 `paper_id` 匹配的向量，再删 SQLite 的
  pages 与 papers 记录，最后删磁盘原文件；重复删除返回 404。
- 前端论文列表新增「删除」按钮（红色描边），点击后 `window.confirm` 二次确认，成功后刷新列表。
- 验证：用一条一次性测试论文（含 2 页文本 + 2 条向量）走接口删除，
  papers / pages / Chroma 三处残留均为 0，重复删除返回 404，其它论文不受影响。
- 删除 ID=1（重复的 v7）后列表为 3 条，符合预期。

### 事故记录（已修复）

- 现象：用浏览器自动化验证"删除二次确认"时，工具自动点击了原生确认框的「确定」，
  导致 2/3/4 号论文被真实删除。
- 处理：已用 `pdf/` 目录原文件重新入库，现为 7 号（v1）、8 号（v7）、9 号（扫描件）。
- 教训：删除类操作不要用会自动确认弹窗的浏览器自动化验证，改用手工点击或接口级测试。

### 阻塞问题（余额）

- 向量化（BGE-M3）、重排（bge-reranker）、OCR（Qwen-VL）均返回
  `HTTP 402 {"code":30001,"message":"Sorry, your account balance is insufficient"}`，
  因此重新入库的论文暂时没有向量，`/api/ask` 返回 503。
- 充值后重启后端即可：启动时会自动为缺索引的论文补建向量，无需重新上传。

## 2026-11-16 · 扫描件 OCR（P0-1 补充）

- 新增 `backend/app/ocr.py`：页面渲染成 150dpi PNG，走多模态模型识别成纯文本，4 页并发。
- `pdf_parser.py` 改为逐页判定：提取文字少于 50 字符即视为扫描页，渲染后 OCR，
  识别结果替代原文本入库；单页失败不影响整篇上传。
- `pages` 表新增 `ocr` 标记字段，`init_db` 内置老库自动加列迁移。
- 上传响应新增 `ocr_pages` / `empty_pages` / `warning`，前端在论文库页用红色提示展示。
- 用本地假视觉接口验证全链路：15 页全部判定为扫描页、全部走 OCR、入库 `ocr=1`，迁移正常。

### 阻塞问题（真实 OCR 未跑通）

- 现象：调用 `Qwen/Qwen3-VL-32B-Instruct` 返回
  `HTTP 402 {"code":30001,"message":"Sorry, your account balance is insufficient"}`。
- 同一问题影响 `Qwen/Qwen3-VL-30B-A3B-Instruct`、`PaddlePaddle/PaddleOCR-VL-1.5`、
  `Qwen/Qwen3-VL-8B-Instruct`；DeepSeek 文本模型正常，BGE-M3 向量化与重排正常。
- 分析：SiliconFlow 账户余额耗尽（首轮单页试识别曾成功，随后全部 402），
  与代码无关；已用本地假接口证明请求链路、渲染、入库、标记全部正确。
- 建议方案（任选其一）：① 给 SiliconFlow 账户充值后重新上传 `pdf/1706.03762v1_img.pdf`；
  ② 在 `.env` 填 `MULTIMODAL_API_KEY` 并设置 `MULTIMODAL_BASE_URL`/`VISION_MODEL`
  切换到阿里云百炼 Qwen-VL 或 OpenAI GPT-4o。
- 充值后预期：上传返回 `ocr_pages: 15, empty_pages: 0`，论文库中该文件出现正文文本。

### 已知问题

- 本地 `uvicorn --reload` 在 Windows 上偶发热重载卡死（日志停在 Reloading 不再启动），
  联调时建议去掉 `--reload` 或改完代码手动重启。

## 2026-11-16 · P0-2 抗幻觉 RAG 问答

- 新增 `backend/app/config.py`：统一从根目录 `.env` 读取密钥与模型配置，代码内无明文密钥。
- 新增 `backend/app/llm_client.py`：封装 SiliconFlow BGE-M3 向量化、bge-reranker-v2-m3 重排、DeepSeek 生成。
- 新增 `backend/app/rag.py`：500 字符切块（重叠 80）、Chroma `papers` 集合入库、
  召回 top5 → 重排 top3 → 带 `[第X页]` 强制引用的抗幻觉生成。
- 新增 `backend/app/routers/ask.py`：`POST /api/ask` 返回 `{answer, sources}`。
- 上传接口改为后台任务自动建索引；启动时自动补齐历史论文索引；新增 `POST /api/papers/{id}/index` 手动重建。
- 前端新增 `/ask` 智能问答页：答案中 `[第X页]` 渲染为蓝色徽章，点击弹出对应原文片段；论文库页新增入口。
- 实测：4 篇论文中 3 篇矢量 PDF 入库 287 个片段（扫描件因无文本层暂为 0 片段）；
  中文提问"这篇论文使用的优化器是什么"答出 `Adam 优化器 [第7页]`，浏览器验收通过。

### 已知问题

- 中文提问需先经 LLM 改写成英文检索式（`QUERY_REWRITE=1`），否则跨语言召回不佳。
- 本地 `uvicorn --reload` 若监控整个 `backend/` 会被 `.venv` 的依赖写入触发，需加 `--reload-dir app`。

## 已完成（2026-11-13 骨架与 PDF 入库）

- 建立前后端分离目录：`backend/`（FastAPI）与 `frontend/`（Next.js 14 App Router）。
- 后端提供 `/api/health` 健康检查、CORS 配置和 `/docs` Swagger 文档。
- 前端提供项目首页，以及后端健康检查和 API 文档入口。
- 配置 uv 与 pnpm 依赖管理及锁文件，补充 README 启动指南。
- 配置 `.env.example` 占位符和 `.gitignore`；真实 DeepSeek、SiliconFlow 密钥只保存在被 Git 忽略的 `.env` 中。
- 初始化 Git 仓库并保存项目约定、项目骨架和依赖锁文件。

## 本地验证结果

- FastAPI 健康检查返回预期 JSON，Swagger 文档返回 HTTP 200。
- Next.js 开发服务器出现 `Ready`，首页返回 HTTP 200，`/papers` 与 `/ask` 页面正常。
- Next.js 生产构建成功。

## 下一步

1. 给 SiliconFlow 充值后重新上传 `pdf/1706.03762v1_img.pdf`，确认 `ocr_pages: 15`。
2. 进入 P0-3 语义去重（v7 已入库时上传 v1 须基于语义预警）。

## 尚未开始

- 语义去重及版本差异总结。
- 双语联动阅读、引用图谱、CSV 图表和 arXiv 入库。
- 541 页长文档 `UnderstandingDeepLearning_02_09_26_C.pdf` 的入库压测。

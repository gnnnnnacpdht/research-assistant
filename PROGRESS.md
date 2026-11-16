# 当前进度快照

更新时间：2026-11-16  
当前阶段：P0-1（PDF 解析 + 扫描件 OCR）与 P0-2（抗幻觉 RAG 问答）均已跑通真实接口，进入 P0-3 语义去重。

## 2026-11-16 · 充值后完整回归

- SiliconFlow 充值完成后重启后端，启动补偿索引自动补齐：
  Chroma 共 **283** 条向量，按论文分布 {8: 98, 7: 91, 11: 94}。
- 问答实测（均带页码徽章，`/api/ask` 返回 200）：
  - 「这篇论文用的优化器是什么」→ Adam 优化器 [第7页]，含 β1/β2/ϵ 设置 [第7页]
  - 「big model 的 BLEU 分数是多少」→ 英法 41.0 [第8页]，并主动指出第1页另有 41.8 的表述、
    说明两者口径不同——引用自我校验生效
- 扫描件 `1706.03762v1_img.pdf` 实测：15 页全部 OCR 成功（`ocr_pages: 15`、`empty_pages: 0`），
  共 37741 字符，已入库并建索引 94 条向量。
- 修复：OCR 单页加一次重试、超时放宽到 300s。此前第 2 页因 180s 读超时被判失败，
  重试后稳定识别（该页约 140s）。

### 环境提醒

- 剩余论文：7（v1）、8（v7）、11（扫描件 OCR 版）。
- 本地启动不要加 `--reload`，Windows 上偶发卡在 Reloading。

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

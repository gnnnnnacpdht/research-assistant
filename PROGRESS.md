# 当前进度快照

更新时间：2026-11-16  
当前阶段：P0-2 抗幻觉 RAG 问答模块已完成并通过端到端验收，下一步进入 P0-3 语义去重。

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
- Next.js 开发服务器出现 `Ready`，首页返回 HTTP 200。
- Next.js 生产构建成功。
- 已验证可使用项目虚拟环境以后台方式启动 Uvicorn，并启用 `--reload`。

## 下一步从这里开始

执行 `PROJECT.md` 点火清单第 5 项：实现 **PDF 上传接口 + PyMuPDF 文本提取 + 入库**。

建议先在 `backend/` 完成上传接口与解析逻辑，再用一个矢量 PDF 验证：

1. 文件能够成功上传并保存。
2. 能提取每页文本，保留文件名和页码。
3. 解析结果能够持久化，并通过接口查询。

## 尚未开始

- 扫描版 PDF 的多模态 OCR。
- Chroma + BGE-M3 + DeepSeek 抗幻觉 RAG 问答与原文锚点。
- 语义去重及版本差异总结。
- 双语联动阅读、引用图谱、CSV 图表和 arXiv 入库。

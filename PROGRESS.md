# 当前进度快照

更新时间：2026-11-13  
当前阶段：项目骨架与本地运行验证已完成，准备进入 PDF 上传与解析模块。

## 已完成

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

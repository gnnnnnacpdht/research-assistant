// 后端地址统一入口，三种场景：
// 1. 生产（静态导出后与 FastAPI 同域部署，如 Hugging Face Space）：留空 → 请求相对路径 /api
// 2. 本地开发（前端 3000、后端 8000 分离）：自动回退 http://localhost:8000
// 3. 仍需前后端分离部署时：用 NEXT_PUBLIC_API_BASE_URL 显式覆盖
const configured = (
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  ""
).replace(/\/+$/, "");

export const apiBaseUrl =
  configured || (process.env.NODE_ENV === "production" ? "" : "http://localhost:8000");

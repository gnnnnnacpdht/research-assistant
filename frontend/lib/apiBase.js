// 后端地址统一入口：
// 优先 NEXT_PUBLIC_API_BASE_URL，其次 NEXT_PUBLIC_API_BASE（Vercel 上常用这个名字），
// 都没有时回退到本地开发地址。
export const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:8000";

/** @type {import('next').NextConfig} */

// 部署方案：前后端合并进同一个 Docker 容器（Hugging Face Spaces）。
// 前端在构建期直接导出为纯静态文件（out/），运行时由后端 FastAPI 用 StaticFiles 托管，
// 因此不需要 Node 服务器、不需要跨域配置，API 一律走同域相对路径 /api。
const nextConfig = {
  output: "export", // 生成静态站点到 out/，而不是 .next/ 服务端产物
  trailingSlash: true, // 每页导出为 xxx/index.html，StaticFiles 访问 /xxx 时会 301 到 /xxx/
  images: { unoptimized: true }, // 静态导出不支持 Next 内置图片优化
  reactStrictMode: true,
};

module.exports = nextConfig;

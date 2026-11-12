import "./globals.css";

export const metadata = {
  title: "科研助手",
  description: "面向科研文献阅读与问答的 AI 助手",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

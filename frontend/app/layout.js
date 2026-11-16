import "./globals.css";
import SiteHeader from "./SiteHeader";

export const metadata = {
  title: "AI 科研助手",
  description: "面向科研文献阅读、可信问答与写作辅助的 AI 助手",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}

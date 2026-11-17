import { apiBaseUrl } from "../lib/apiBase";

const entries = [
  {
    href: "/papers",
    icon: "📚",
    title: "论文库",
    description: "上传/管理 PDF，支持 arXiv 导入与语义去重",
  },
  {
    href: "/ask",
    icon: "💬",
    title: "智能问答",
    description: "抗幻觉 RAG，答案带页码引用与 Agent 推理轨迹",
  },
  {
    href: "/read",
    icon: "📖",
    title: "双语阅读",
    description: "原版 PDF + 中文翻译，划词翻译与引用跳转",
  },
  {
    href: "/graph",
    icon: "🕸️",
    title: "引用图谱",
    description: "引用网络可视化，基石文献挖掘与自动综述",
  },
  {
    href: "/copilot",
    icon: "✍️",
    title: "写作 Copilot",
    description: "无幻觉论文框架、架构图生成、CSV 学术图表",
  },
];

export default function Home() {
  return (
    <main className="container home-main">
      <section className="hero home-hero">
        <p className="eyebrow">AI RESEARCH ASSISTANT</p>
        <h1>AI 科研助手</h1>
        <p className="intro">
          上传学术论文，即可获得抗幻觉问答、页码级溯源、语义去重、双语联动阅读、引用图谱与写作辅助的全流程科研支持。
        </p>
      </section>

      <nav className="home-entries" aria-label="核心功能入口">
        {entries.map((entry) => (
          <a className="home-entry" href={entry.href} key={entry.href}>
            <span className="home-entry-icon" aria-hidden="true">{entry.icon}</span>
            <span className="home-entry-copy">
              <strong>{entry.title}</strong>
              <span>{entry.description}</span>
            </span>
            <span className="home-entry-arrow" aria-hidden="true">→</span>
          </a>
        ))}
      </nav>

      <footer className="home-footer">
        <p>Next.js 14 · FastAPI · Chroma · DeepSeek · BGE-M3</p>
        <div className="home-debug-links">
          <a href={`${apiBaseUrl}/api/health`}>后端状态</a>
          <a href={`${apiBaseUrl}/docs`}>API 文档</a>
        </div>
      </footer>
    </main>
  );
}

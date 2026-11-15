const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export default function Home() {
  return (
    <main className="container">
      <section className="hero">
        <p className="eyebrow">AI RESEARCH ASSISTANT</p>
        <h1>科研助手</h1>
        <p className="intro">
          上传 PDF 即可完成文本解析入库，后续将在此接入抗幻觉问答与语义去重。
        </p>
        <div className="actions">
          <a className="primary" href="/papers">
            进入论文库
          </a>
          <a className="secondary" href={`${apiBaseUrl}/api/health`}>
            检查后端状态
          </a>
          <a className="secondary" href={`${apiBaseUrl}/docs`}>
            查看 API 文档
          </a>
        </div>
      </section>

      <section className="status-grid" aria-label="项目状态">
        <article>
          <span>前端</span>
          <h2>Next.js 14</h2>
          <p>App Router 与 React 页面入口已配置。</p>
        </article>
        <article>
          <span>后端</span>
          <h2>FastAPI</h2>
          <p>健康检查接口与 Swagger 文档已配置。</p>
        </article>
      </section>
    </main>
  );
}

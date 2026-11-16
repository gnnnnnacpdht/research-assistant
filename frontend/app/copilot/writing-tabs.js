"use client";

import { useEffect, useState } from "react";

import { apiBaseUrl } from "../../lib/apiBase";

// Mermaid 体积较大（约 1MB），不值得打进主包；首次点开论文框架时从 CDN 懒加载。
// 用 UMD 脚本注入而不是 npm 依赖：静态导出（output: export）下打包更稳。
const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";

function loadMermaid() {
  if (typeof window === "undefined") return Promise.reject(new Error("仅浏览器可用"));
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!window.__mermaidPromise) {
    window.__mermaidPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = MERMAID_CDN;
      script.async = true;
      script.onload = () => {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
        resolve(window.mermaid);
      };
      script.onerror = () => reject(new Error("Mermaid 脚本加载失败，请检查网络"));
      document.head.appendChild(script);
    });
  }
  return window.__mermaidPromise;
}

async function copyText(text, onDone) {
  try {
    await navigator.clipboard.writeText(text);
    onDone("已复制 ✓");
    setTimeout(() => onDone(""), 1800);
  } catch {
    onDone("复制失败，请手动选中");
  }
}

// ============ 论文框架 ============
export function FrameworkPanel() {
  const [idea, setIdea] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [svg, setSvg] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [copyState, setCopyState] = useState("");

  async function generate(event) {
    event.preventDefault();
    const text = idea.trim();
    if (!text) {
      setError("请先输入研究想法");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    setSvg("");
    setPreviewError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/writing/framework`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea: text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail ?? `生成失败（HTTP ${response.status}）`);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!result?.diagram_code) return undefined;
    let cancelled = false;
    setSvg("");
    setPreviewError("");
    loadMermaid()
      .then(async (mermaid) => {
        const rendered = await mermaid.render(`mermaid-${Date.now()}`, result.diagram_code);
        if (!cancelled) setSvg(rendered.svg);
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [result]);

  return (
    <>
      <section className="card">
        <h2>论文框架生成</h2>
        <form className="writing-form" onSubmit={generate}>
          <textarea
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            placeholder="输入研究想法，例如：用扩散模型做晶圆缺陷检测"
            rows={3}
            disabled={loading}
          />
          <button className="primary" type="submit" disabled={loading}>
            {loading ? "生成中…" : "生成框架"}
          </button>
        </form>
        <p className="hint">
          Related Work 的引用只会来自本地论文库（无库内文献时留空），不会编造参考文献。
        </p>
        {error ? <p className="message error">{error}</p> : null}
      </section>

      {result ? (
        <>
          <section className="card">
            <h2>章节要点</h2>
            <div className="writing-sections">
              {result.sections.map((section) => (
                <article className="writing-section" key={section.key}>
                  <h3>{section.title}</h3>
                  <ul>
                    {section.points.length > 0 ? (
                      section.points.map((point, index) => <li key={index}>{point}</li>)
                    ) : (
                      <li className="muted">本节未生成要点</li>
                    )}
                  </ul>
                </article>
              ))}
              <article className="writing-section wide">
                <h3>Related Work</h3>
                <ul>
                  {result.related_work.length > 0 ? (
                    result.related_work.map((item, index) => (
                      <li key={index}>
                        {item.point}
                        {item.citations.length > 0 ? (
                          <span className="cite-inline">
                            {item.citations
                              .map((cite) => `[${cite.title}${cite.year ? `, ${cite.year}` : ""}]`)
                              .join(" ")}
                          </span>
                        ) : (
                          <span className="cite-inline muted">（库内无匹配文献）</span>
                        )}
                      </li>
                    ))
                  ) : (
                    <li className="muted">未生成 Related Work 要点</li>
                  )}
                </ul>
              </article>
            </div>
          </section>

          <section className="card">
            <h2>参考文献（来自本地库）</h2>
            {result.references.length > 0 ? (
              <ol className="writing-refs">
                {result.references.map((reference) => (
                  <li key={reference.id}>
                    {reference.title}
                    {reference.year ? `（${reference.year}）` : ""}
                    <span className="cite-inline">{reference.filename}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="message">本次框架没有引用库内文献，可先到论文库导入几篇相关论文。</p>
            )}
          </section>

          <section className="card">
            <div className="list-head">
              <h2>架构图（Mermaid）</h2>
              <button
                className="secondary"
                type="button"
                onClick={() => copyText(result.diagram_code, setCopyState)}
              >
                {copyState || "复制脚本"}
              </button>
            </div>
            {previewError ? <p className="message error">{previewError}</p> : null}
            {svg ? (
              <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              !previewError && <p className="message">正在渲染预览…</p>
            )}
            <pre className="code-box">{result.diagram_code}</pre>
          </section>

          {result.tikz_code ? (
            <section className="card">
              <div className="list-head">
                <h2>备用脚本（TikZ）</h2>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => copyText(result.tikz_code, setCopyState)}
                >
                  {copyState || "复制脚本"}
                </button>
              </div>
              <pre className="code-box">{result.tikz_code}</pre>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}

// ============ 中译英 ============
export function Zh2EnPanel() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [translation, setTranslation] = useState("");
  const [cached, setCached] = useState(false);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState("");

  async function translate(event) {
    event.preventDefault();
    const source = text.trim();
    if (!source) {
      setError("请先输入中文摘要或段落");
      return;
    }
    setLoading(true);
    setError("");
    setTranslation("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/translate/zh2en`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: source }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail ?? `翻译失败（HTTP ${response.status}）`);
      setTranslation(data.translation || "");
      setCached(Boolean(data.cached));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h2>中译英（学术规范）</h2>
      <form className="writing-form" onSubmit={translate}>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="粘贴中文摘要或段落，例如：本文提出一种基于扩散模型的晶圆缺陷检测方法…"
          rows={7}
          disabled={loading}
        />
        <button className="primary" type="submit" disabled={loading}>
          {loading ? "翻译中…" : "翻译为英文"}
        </button>
      </form>
      <p className="hint">
        输出遵循学术书面语与被动语态，保留引用标记与术语；相同文本会命中缓存避免重复计费。
      </p>
      {error ? <p className="message error">{error}</p> : null}
      {translation ? (
        <div className="writing-output">
          <div className="list-head">
            <h3>英文译文{cached ? <span className="cache-tag">缓存命中</span> : null}</h3>
            <button
              className="secondary"
              type="button"
              onClick={() => copyText(translation, setCopyState)}
            >
              {copyState || "复制译文"}
            </button>
          </div>
          <p className="translation-text">{translation}</p>
        </div>
      ) : null}
    </section>
  );
}

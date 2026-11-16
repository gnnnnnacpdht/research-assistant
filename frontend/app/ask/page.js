"use client";

import { useState } from "react";

import { apiBaseUrl } from "../../lib/apiBase";

// 答案里的页码引用标记，例如 [第7页]；捕获组保留分隔符，便于原样切分渲染。
const PAGE_MARK = /(\[第\d+页\])/g;

const EXAMPLES = [
  "这篇论文使用的优化器是什么",
  "这篇论文提出了什么模型结构",
  "Self-attention 有什么优点",
];

// 把答案文本里的 [第X页] 渲染成可点击徽章，其余文本原样输出。
function AnswerBody({ answer, onCiteClick }) {
  return (
    <p className="answer-text">
      {answer.split(PAGE_MARK).map((part, index) => {
        const match = part.match(/^\[第(\d+)页\]$/);
        if (!match) {
          return <span key={index}>{part}</span>;
        }
        const page = Number(match[1]);
        return (
          <button
            key={index}
            type="button"
            className="cite-badge"
            onClick={() => onCiteClick(page)}
            title={`查看第${page}页原文片段`}
          >
            第{page}页
          </button>
        );
      })}
    </p>
  );
}

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState([]);
  const [error, setError] = useState("");
  // 点击页码徽章时保存页码，非空即弹出原文片段浮层。
  const [activePage, setActivePage] = useState(null);

  async function handleAsk(event) {
    event?.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) {
      setError("请先输入问题");
      return;
    }

    setAsking(true);
    setError("");
    setAnswer("");
    setSources([]);

    try {
      const response = await fetch(`${apiBaseUrl}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail ?? `问答失败（HTTP ${response.status}）`);
      }
      setAnswer(data.answer ?? "");
      setSources(data.sources ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setAsking(false);
    }
  }

  // 同一页可能命中多个片段，全部展示，方便核对引用。
  const pageSources = activePage
    ? sources.filter((item) => Number(item.page) === activePage)
    : [];

  return (
    <main className="container">
      <section className="page-head">
        <p className="eyebrow">RAG ASSISTANT</p>
        <h1>智能问答</h1>
        <p className="intro">
          答案只依据已入库论文的原文生成，每个结论后都带页码标记；点击蓝色徽章可查看对应原文片段。
        </p>
        <a className="secondary link-back" href="/papers">
          ← 返回论文库
        </a>
      </section>

      <section className="card">
        <h2>提问</h2>
        <form className="ask-form" onSubmit={handleAsk}>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="例如：这篇论文使用的优化器是什么"
            rows={3}
            maxLength={500}
          />
          <div className="ask-actions">
            <button className="primary" type="submit" disabled={asking}>
              {asking ? "检索并生成中…" : "提问"}
            </button>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="chip"
                onClick={() => setQuestion(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </form>
        {error ? <p className="message error">{error}</p> : null}
      </section>

      {answer ? (
        <section className="card">
          <h2>回答</h2>
          <AnswerBody answer={answer} onCiteClick={setActivePage} />
          <p className="message">
            以上结论均来自下方检索到的原文片段，点击页码徽章可核对。
          </p>
          {sources.length > 0 ? (
            <>
              <h3 className="sources-title">参考原文（检索 + 重排后的 top3）</h3>
              <ul className="source-list">
                {sources.map((source, index) => (
                  <li key={`${source.paper_id}-${source.page}-${index}`}>
                    <button
                      type="button"
                      className="source-head"
                      onClick={() => setActivePage(Number(source.page))}
                    >
                      {source.filename} · 第{source.page}页
                    </button>
                    <p className="source-text">{source.text}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {activePage ? (
        <div className="modal-mask" onClick={() => setActivePage(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>第{activePage}页 · 原文片段</h3>
              <button type="button" onClick={() => setActivePage(null)}>
                关闭
              </button>
            </div>
            {pageSources.length > 0 ? (
              pageSources.map((source, index) => (
                <div key={index} className="modal-source">
                  <p className="message">{source.filename}</p>
                  <p className="source-text">{source.text}</p>
                </div>
              ))
            ) : (
              <p className="message">
                本次检索没有返回该页的片段，请重新提问以获得可核对的原文。
              </p>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

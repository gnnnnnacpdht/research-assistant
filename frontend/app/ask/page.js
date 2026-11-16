"use client";

import { useEffect, useState } from "react";

import { apiBaseUrl } from "../../lib/apiBase";
import { EmptyState, ErrorBanner, LoadingBlock } from "../Feedback";

// 支持单篇 [第7页] 与跨论文 [论文2 第7页] 两种引用标记。
const PAGE_MARK = /(\[论文\d+\s*第\d+页\]|\[第\d+页\])/g;

const EXAMPLES = [
  "这篇论文使用的优化器是什么",
  "这篇论文提出了什么模型结构",
  "Self-attention 有什么优点",
];

// 把两种引用标记渲染成可点击徽章，其余文本原样输出。
function renderCitations(text, onCiteClick) {
  return text.split(PAGE_MARK).map((part, index) => {
    const match = part.match(/^\[(?:论文(\d+)\s*)?第(\d+)页\]$/);
    if (!match) {
      return <span key={index}>{part}</span>;
    }
    const paperIndex = match[1] ? Number(match[1]) : null;
    const page = Number(match[2]);
    const label = paperIndex ? `论文${paperIndex} · 第${page}页` : `第${page}页`;
    return (
      <button
        key={index}
        type="button"
        className="cite-badge"
        onClick={() => onCiteClick(page, paperIndex)}
        title={`查看${label}原文片段`}
      >
        {label}
      </button>
    );
  });
}

function AnswerBody({ answer, mode, onCiteClick }) {
  // 对比答案按行拆成独立卡片，避免多篇论文的长段落混在一起。
  if (mode === "compare") {
    const items = answer.split(/\n+/).map((item) => item.trim()).filter(Boolean);
    return (
      <div className="compare-list">
        {items.map((item, index) => (
          <p key={index} className="compare-item">
            {renderCitations(item, onCiteClick)}
          </p>
        ))}
      </div>
    );
  }
  return <p className="answer-text">{renderCitations(answer, onCiteClick)}</p>;
}

// 轨迹面板里的阶段中文名；后端 stage 字段保持英文，便于日志检索。
const STAGE_NAMES = {
  retrieve: "向量检索",
  rerank: "重排精筛",
  generate: "生成答案",
  verify: "引用自检",
};

// 可折叠的 Agent 推理轨迹：展示每个阶段的状态、耗时与自检结论。
function AgentTrace({ trajectory }) {
  if (!trajectory || trajectory.length === 0) {
    return null;
  }
  const retries = Math.max(...trajectory.map((item) => item.attempt ?? 1)) - 1;
  const totalMs = trajectory.reduce((sum, item) => sum + (item.duration_ms ?? 0), 0);
  const lastVerify = [...trajectory].reverse().find((item) => item.stage === "verify");

  return (
    <details className="trace-panel" open>
      <summary>
        Agent 推理轨迹 · 总耗时 {(totalMs / 1000).toFixed(1)} 秒 · 重新检索 {retries} 次
        {lastVerify ? ` · ${lastVerify.detail}` : ""}
      </summary>
      <ol className="trace-list">
        {trajectory.map((item, index) => (
          <li key={index} className={`trace-item trace-${item.status}`}>
            <span className="trace-stage">
              {STAGE_NAMES[item.stage] ?? item.stage}
              {(item.attempt ?? 1) > 1 ? `（第${item.attempt}轮）` : ""}
            </span>
            <span className="trace-detail">{item.detail}</span>
            <span className="trace-time">{item.duration_ms} ms</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState([]);
  const [trajectory, setTrajectory] = useState([]);
  const [mode, setMode] = useState("single");
  // 论文范围：空串表示全库检索，否则只在该论文内检索（避免大文档淹没小论文）。
  const [papers, setPapers] = useState([]);
  const [paperId, setPaperId] = useState("");
  const [listError, setListError] = useState("");
  const [listRetry, setListRetry] = useState(0);

  useEffect(() => {
    setListError("");
    fetch(`${apiBaseUrl}/api/papers`)
      .then(async (response) => {
        const data = await response.json().catch(() => []);
        if (!response.ok) throw new Error("论文列表加载失败，请稍后重试");
        setPapers(Array.isArray(data) ? data : []);
      })
      .catch(() => setListError("论文列表加载失败，请检查网络连接后重试"));
  }, [listRetry]);
  const [error, setError] = useState("");
  // 同时记录论文编号与页码，避免不同论文的同页片段在弹窗里混淆。
  const [activeCite, setActiveCite] = useState(null);

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
    setTrajectory([]);
    setMode("single");
    setActiveCite(null);

    try {
      const response = await fetch(`${apiBaseUrl}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          paper_id: paperId ? Number(paperId) : null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail ?? `问答失败（HTTP ${response.status}）`);
      }
      setAnswer(data.answer ?? "");
      setSources(data.sources ?? []);
      setTrajectory(data.trajectory ?? []);
      setMode(data.mode === "compare" ? "compare" : "single");
    } catch (err) {
      setError(err.message);
    } finally {
      setAsking(false);
    }
  }

  // 同一篇论文的同一页可能命中多个片段，全部展示，方便核对引用。
  const pageSources = activeCite
    ? sources.filter(
        (item) =>
          Number(item.page) === activeCite.page &&
          (activeCite.paperIndex == null ||
            Number(item.paper_index) === activeCite.paperIndex),
      )
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

      <ErrorBanner
        message={listError}
        onRetry={() => setListRetry((value) => value + 1)}
        onClose={() => setListError("")}
      />
      <ErrorBanner
        message={error ? `问答未完成：${error}` : ""}
        onRetry={question.trim() ? () => handleAsk() : undefined}
        onClose={() => setError("")}
      />

      <section className="card">
        <h2>提问</h2>
        <form className="ask-form" onSubmit={handleAsk}>
          <select
            className="paper-select"
            value={paperId}
            onChange={(event) => setPaperId(event.target.value)}
            aria-label="选择检索范围"
          >
            <option value="">全部论文</option>
            {papers.map((paper) => (
              <option key={paper.id} value={paper.id}>
                {paper.filename}（{paper.page_count}页）
              </option>
            ))}
          </select>
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
      </section>

      {asking ? (
        <section className="card">
          <LoadingBlock label="Agent 正在检索原文、重排并核验引用…" lines={4} />
        </section>
      ) : null}

      {!asking && !answer ? (
        <section className="card">
          <EmptyState
            title="从一个有出处的问题开始"
            description="答案仅依据库内论文生成，并附可点击的页码引用和原文片段。"
            actionLabel="试试示例问题"
            onAction={() => setQuestion(EXAMPLES[0])}
          />
        </section>
      ) : null}

      {answer ? (
        <section className="card">
          <h2>回答</h2>
          <AgentTrace trajectory={trajectory} />
          <AnswerBody
            answer={answer}
            mode={mode}
            onCiteClick={(page, paperIndex) => setActiveCite({ page, paperIndex })}
          />
          <p className="message">
            以上结论均来自下方检索到的原文片段，点击页码徽章可核对。
          </p>
          {sources.length > 0 ? (
            <>
              <h3 className="sources-title">参考原文（检索 + 重排后的片段）</h3>
              <ul className="source-list">
                {sources.map((source, index) => (
                  <li key={`${source.paper_id}-${source.page}-${index}`}>
                    <button
                      type="button"
                      className="source-head"
                      onClick={() =>
                        setActiveCite({
                          page: Number(source.page),
                          paperIndex: source.paper_index ?? null,
                        })
                      }
                    >
                      {source.paper_index ? `论文${source.paper_index} · ` : ""}
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

      {activeCite ? (
        <div className="modal-mask" onClick={() => setActiveCite(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>
                {activeCite.paperIndex ? `论文${activeCite.paperIndex} · ` : ""}
                第{activeCite.page}页 · 原文片段
              </h3>
              <button type="button" onClick={() => setActiveCite(null)}>
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

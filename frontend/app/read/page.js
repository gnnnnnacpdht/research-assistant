"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as pdfjsLib from "pdfjs-dist";

import { apiBaseUrl } from "../../lib/apiBase";

// worker 文件由构建时复制到 public/，避免从 CDN 拉取（内网/演示环境更稳）。
// 带版本查询串：文件内容不变时浏览器会 304 复用旧响应头（曾把 .mjs 缓存成 text/plain），
// 换一个 URL 可强制重新拉取，避免模块 MIME 校验失败的假死。
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs?v=4.10.38";

const CITATION_RE = /\[(\d{1,3})\]/g;

function extractCitations(text) {
  const found = new Set();
  for (const match of (text || "").matchAll(CITATION_RE)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

// 把扁平的章节列表按 level 还原成树：层级回退时弹栈，直到找到更高级的父节点。
function buildHeadingTree(headings) {
  const root = { level: 0, children: [] };
  const stack = [root];
  for (const heading of headings) {
    const node = { ...heading, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

// 可折叠标题树；点击标题跳到对应页，但不要顺带折叠/展开。
function HeadingTree({ nodes, onJump }) {
  if (!nodes || nodes.length === 0) {
    return null;
  }
  return (
    <ul className="struct-tree">
      {nodes.map((node) => (
        <li key={`${node.level}-${node.page_num}-${node.content}`}>
          {node.children.length > 0 ? (
            <details open={node.level <= 2}>
              <summary>
                <button
                  type="button"
                  className="struct-heading"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onJump(node.page_num);
                  }}
                >
                  {node.content}
                </button>
                <span className="struct-page">P.{node.page_num}</span>
              </summary>
              <HeadingTree nodes={node.children} onJump={onJump} />
            </details>
          ) : (
            <div className="struct-leaf">
              <button
                type="button"
                className="struct-heading"
                onClick={() => onJump(node.page_num)}
              >
                {node.content}
              </button>
              <span className="struct-page">P.{node.page_num}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ReadPageInner() {
  const searchParams = useSearchParams();
  const paperId = Number(searchParams.get("paper_id") || 0);

  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const pdfDocRef = useRef(null);
  const renderTaskRef = useRef(null);
  const translateCacheRef = useRef(new Map()); // 页码 → 译文，减少重复请求

  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  // PDF 文档就绪计数：dev 模式 StrictMode 会重挂载 effect，
  // 只依赖 pageCount 可能出现"文档已销毁、页码没变"的空渲染，用计数兜底重渲染。
  const [docReady, setDocReady] = useState(0);
  const [pageText, setPageText] = useState("");
  const [translation, setTranslation] = useState("");
  const [translating, setTranslating] = useState(false);
  const [status, setStatus] = useState("正在加载 PDF…");
  const [error, setError] = useState("");

  const [tab, setTab] = useState("translate"); // translate | references | structure
  const [references, setReferences] = useState({ entries: [], first_pages: {} });
  // 低含金量（应付式）引用默认折叠，跳转命中时自动展开
  const [showLowRefs, setShowLowRefs] = useState(false);
  // 结构化视图：一次取全部条目，切标签页不再重复请求
  const [structure, setStructure] = useState({ counts: {}, items: [] });
  const [structureError, setStructureError] = useState("");
  const [activeCitation, setActiveCitation] = useState(null);
  const [selectionResult, setSelectionResult] = useState(null); // {text, translation}
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [floatButton, setFloatButton] = useState(null); // {x, y, text}

  // ===== 1. 加载 PDF 文档 =====
  useEffect(() => {
    if (!paperId) {
      setError("缺少 paper_id 参数，请从论文库点「阅读」进入");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const doc = await pdfjsLib.getDocument({
          url: `${apiBaseUrl}/api/papers/${paperId}/file`,
        }).promise;
        if (cancelled) return;
        pdfDocRef.current = doc;
        setPageCount(doc.numPages);
        setDocReady((value) => value + 1);
        setStatus("");
      } catch (err) {
        if (!cancelled) setError(`PDF 加载失败：${err.message}`);
      }
    })();
    return () => {
      cancelled = true;
      pdfDocRef.current?.destroy?.();
      pdfDocRef.current = null;
    };
  }, [paperId]);

  // ===== 2. 渲染某页：canvas 画原版 + 手写文本层支持划词 =====
  useEffect(() => {
    let cancelled = false;

    async function render() {
      const doc = pdfDocRef.current;
      if (!doc) return;
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        const layer = textLayerRef.current;
        if (!canvas || !layer) return;

        const ratio = window.devicePixelRatio || 1;
        canvas.width = viewport.width * ratio;
        canvas.height = viewport.height * ratio;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        if (layer) {
          layer.style.width = `${viewport.width}px`;
          layer.style.height = `${viewport.height}px`;
        }

        renderTaskRef.current?.cancel?.();
        const context = canvas.getContext("2d");
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        renderTaskRef.current = page.render({ canvasContext: context, viewport });
        await renderTaskRef.current.promise;
        if (cancelled) return;

        // 文本层：把每个文字片段绝对定位到 canvas 上，才能用鼠标选中
        layer.innerHTML = "";
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (!item.str) continue;
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.hypot(tx[2], tx[3]);
          if (!fontHeight) continue;

          const span = document.createElement("span");
          span.textContent = item.str;
          span.style.left = `${tx[4]}px`;
          span.style.top = `${tx[5] - fontHeight}px`;
          span.style.fontSize = `${fontHeight}px`;
          span.style.fontFamily = "sans-serif";
          span.style.color = "transparent";
          span.style.position = "absolute";
          span.style.whiteSpace = "pre";
          span.style.transformOrigin = "0 0";
          layer.appendChild(span);

          // 按 PDF 里给出的实际宽度横向拉伸，保证选区覆盖原文字
          const targetWidth = item.width * viewport.scale;
          const measured = span.getBoundingClientRect().width;
          if (measured > 0 && targetWidth > 0) {
            span.style.transform = `scaleX(${targetWidth / measured})`;
          }
        }
      } catch (err) {
        if (err?.name !== "RenderingCancelledException" && !cancelled) {
          setError(`第 ${pageNum} 页渲染失败：${err.message}`);
        }
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [pageNum, docReady]);

  // ===== 3. 取该页文本并翻译 =====
  useEffect(() => {
    if (!paperId) return;
    let cancelled = false;
    setPageText("");
    setSelectionResult(null);
    setFloatButton(null);

    (async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/papers/${paperId}/page/${pageNum}`,
          { cache: "no-store" },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail ?? "取页面文本失败");
        if (cancelled) return;
        setPageText(data.text || "");
        setPageCount(data.page_count || 0);

        const cached = translateCacheRef.current.get(pageNum);
        if (cached) {
          setTranslation(cached);
          return;
        }

        setTranslating(true);
        const tr = await fetch(`${apiBaseUrl}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: data.text }),
        });
        const trData = await tr.json();
        if (cancelled) return;
        if (!tr.ok) throw new Error(trData.detail ?? "翻译失败");
        translateCacheRef.current.set(pageNum, trData.translation);
        setTranslation(trData.translation);
      } catch (err) {
        if (!cancelled) setTranslation(`翻译失败：${err.message}`);
      } finally {
        if (!cancelled) setTranslating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paperId, pageNum]);

  // ===== 4. 参考文献解析（一次） =====
  useEffect(() => {
    if (!paperId) return;
    fetch(`${apiBaseUrl}/api/papers/${paperId}/references`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setReferences({ entries: data.entries || [], first_pages: data.first_pages || {} }))
      .catch(() => {});
  }, [paperId]);

  // ===== 4b. 结构化条目（一次） =====
  useEffect(() => {
    if (!paperId) return;
    fetch(`${apiBaseUrl}/api/papers/${paperId}/structure`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.detail ?? `加载失败（HTTP ${response.status}）`);
        }
        setStructure({ counts: data.counts || {}, items: data.items || [] });
        setStructureError("");
      })
      .catch((error) => setStructureError(error.message));
  }, [paperId]);

  // ===== 5. 划词翻译：鼠标松开后取选区，显示浮动按钮 =====
  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    const raw = selection?.toString().replace(/\s+/g, " ").trim() || "";
    if (raw.length < 2) {
      setFloatButton(null);
      return;
    }
    const range = selection.getRangeAt(0).getBoundingClientRect();
    setFloatButton({
      x: range.left + range.width / 2,
      y: range.top - 8,
      text: raw.slice(0, 1500),
    });
  }, []);

  async function translateSelection() {
    if (!floatButton) return;
    const text = floatButton.text;
    setFloatButton(null);
    setSelectionBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "翻译失败");
      setSelectionResult({ text, translation: data.translation, cached: data.cached });
      setTab("translate");
    } catch (err) {
      setSelectionResult({ text, translation: `翻译失败：${err.message}` });
    } finally {
      setSelectionBusy(false);
    }
  }

  // ===== 6. 引用跳转：正文 [n] → 参考文献；文献条目 → 正文首现页 =====
  function jumpToReference(index) {
    setActiveCitation(index);
    setTab("references");
    // 目标条目若属于低含金量折叠区，先展开再滚动，否则滚到不存在的节点
    if (references.entries.find((entry) => entry.index === index)?.low_quality) {
      setShowLowRefs(true);
    }
    requestAnimationFrame(() => {
      document
        .getElementById(`ref-entry-${index}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function jumpToBody(index) {
    const page = references.first_pages?.[String(index)];
    if (page) setPageNum(Number(page));
    setTab("translate");
    setActiveCitation(index);
  }

  const citations = extractCitations(pageText);

  // 含金量分组：低含金量（应付式）引用默认折叠，避免淹没真正有价值的文献
  const qualityRefs = references.entries.filter((entry) => !entry.low_quality);
  const lowQualityRefs = references.entries.filter((entry) => entry.low_quality);

  function renderRefEntry(entry) {
    const level = entry.score >= 60 ? "high" : entry.score >= 40 ? "mid" : "low";
    return (
      <li
        key={`${entry.index}-${entry.page}`}
        id={`ref-entry-${entry.index}`}
        className={activeCitation === entry.index ? "ref-item active" : "ref-item"}
      >
        <div className="ref-text">
          <span className="ref-index">[{entry.index}]</span> {entry.text}
        </div>
        <div className="ref-meta">
          <span className={`ref-quality ${level}`}>含金量 {entry.score}</span>
          {entry.quality_tags?.length ? (
            <span className="ref-tags">{entry.quality_tags.join(" · ")}</span>
          ) : null}
        </div>
        <div className="ref-actions">
          <span className="ref-page">P.{entry.page}</span>
          {references.first_pages?.[String(entry.index)] ? (
            <button
              type="button"
              className="link-button"
              onClick={() => jumpToBody(entry.index)}
            >
              ↑ 跳到正文 P.{references.first_pages[String(entry.index)]}
            </button>
          ) : null}
        </div>
      </li>
    );
  }

  // ===== 7. 结构化视图的派生数据 =====
  const structureByType = (type) => structure.items.filter((item) => item.type === type);
  const headings = structureByType("heading");
  const tables = structureByType("table");
  const formulas = structureByType("formula");
  const structReferences = structureByType("reference");
  const metaTitle = structureByType("title")[0];
  const metaAuthor = structureByType("author")[0];
  const metaAbstract = structureByType("abstract")[0];

  function jumpToStructPage(page) {
    if (page) setPageNum(Number(page));
  }

  if (!paperId) {
    return (
      <main className="container">
        <p className="message error">{error || "缺少 paper_id 参数"}</p>
        <a className="secondary" href="/papers">
          ← 返回论文库
        </a>
      </main>
    );
  }

  return (
    <main className="read-page">
      <header className="read-head">
        <a className="secondary" href="/papers">
          ← 论文库
        </a>
        <span className="read-title">双语联动阅读 · 论文 #{paperId}</span>
        <div className="page-nav">
          <button
            className="secondary"
            type="button"
            onClick={() => setPageNum((n) => Math.max(1, n - 1))}
            disabled={pageNum <= 1}
          >
            上一页
          </button>
          <span>
            第 {pageNum} / {pageCount || "?"} 页
          </span>
          <button
            className="secondary"
            type="button"
            onClick={() => setPageNum((n) => Math.min(pageCount || 1, n + 1))}
            disabled={pageCount > 0 && pageNum >= pageCount}
          >
            下一页
          </button>
        </div>
      </header>

      {error ? <p className="message error">{error}</p> : null}
      {status ? <p className="message">{status}</p> : null}

      <div className="read-body">
        {/* 左侧：pdf.js 原版 */}
        <section className="pdf-pane" onMouseUp={handleMouseUp}>
          <div className="pdf-canvas-wrap">
            <canvas ref={canvasRef} />
            <div ref={textLayerRef} className="pdf-text-layer" />
          </div>
          <p className="pdf-tip">在页面上拖选英文，会弹出「翻译」按钮</p>
        </section>

        {/* 右侧：翻译 / 参考文献 */}
        <section className="side-pane">
          <div className="tabs">
            <button
              type="button"
              className={tab === "translate" ? "tab active" : "tab"}
              onClick={() => setTab("translate")}
            >
              中文翻译
            </button>
            <button
              type="button"
              className={tab === "references" ? "tab active" : "tab"}
              onClick={() => setTab("references")}
            >
              参考文献（{references.entries.length}）
            </button>
            <button
              type="button"
              className={tab === "structure" ? "tab active" : "tab"}
              onClick={() => setTab("structure")}
            >
              结构化视图（{structure.items.length}）
            </button>
          </div>

          {tab === "translate" ? (
            <div className="pane-content">
              {citations.length > 0 ? (
                <div className="citation-row">
                  <span className="citation-label">本页引用：</span>
                  {citations.map((index) => (
                    <button
                      key={index}
                      type="button"
                      className={activeCitation === index ? "cite-chip active" : "cite-chip"}
                      onClick={() => jumpToReference(index)}
                    >
                      [{index}]
                    </button>
                  ))}
                </div>
              ) : null}

              {selectionResult ? (
                <div className="selection-card">
                  <div className="selection-head">
                    <strong>划词翻译</strong>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setSelectionResult(null)}
                    >
                      清除
                    </button>
                  </div>
                  <p className="selection-source">{selectionResult.text}</p>
                  <p className="selection-target">{selectionResult.translation}</p>
                </div>
              ) : null}

              <h3 className="pane-title">第 {pageNum} 页译文</h3>
              {translating ? (
                <p className="message">正在翻译…</p>
              ) : (
                <div className="translation-text">{translation}</div>
              )}
            </div>
          ) : tab === "references" ? (
            <div className="pane-content">
              <h3 className="pane-title">参考文献</h3>
              {references.entries.length === 0 ? (
                <p className="message">未解析到参考文献条目。</p>
              ) : (
                <>
                  <ol className="ref-list">{qualityRefs.map((entry) => renderRefEntry(entry))}</ol>
                  {lowQualityRefs.length > 0 ? (
                    <div className="low-ref-box">
                      <button
                        type="button"
                        className="secondary low-ref-toggle"
                        onClick={() => setShowLowRefs((value) => !value)}
                      >
                        {showLowRefs ? "收起" : "展开"} {lowQualityRefs.length} 条低含金量引用
                        （应付式引用：编号堆叠或无具体描述）
                      </button>
                      {showLowRefs ? (
                        <ol className="ref-list low-ref-list">
                          {lowQualityRefs.map((entry) => renderRefEntry(entry))}
                        </ol>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : (
            <div className="pane-content">
              <h3 className="pane-title">结构化视图</h3>
              {structureError ? <p className="message error">{structureError}</p> : null}
              {!structureError && structure.items.length === 0 ? (
                <p className="message">
                  该论文尚未完成结构化抽取。新上传的论文会在后台自动抽取，稍后刷新本页即可。
                </p>
              ) : null}

              {metaTitle ? (
                <div className="struct-meta">
                  <h4>{metaTitle.content}</h4>
                  {metaAuthor ? <p>{metaAuthor.content}</p> : null}
                  {metaAbstract ? (
                    <details>
                      <summary>摘要</summary>
                      <p>{metaAbstract.content}</p>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {headings.length > 0 ? (
                <>
                  <h4 className="struct-title">章节标题树（{headings.length}）</h4>
                  <HeadingTree nodes={buildHeadingTree(headings)} onJump={jumpToStructPage} />
                </>
              ) : null}

              {tables.length > 0 ? (
                <>
                  <h4 className="struct-title">表格（{tables.length}）</h4>
                  {tables.map((table, index) => (
                    <div className="struct-card" key={`table-${index}`}>
                      <button
                        type="button"
                        className="struct-page"
                        onClick={() => jumpToStructPage(table.page_num)}
                      >
                        P.{table.page_num}
                      </button>
                      <pre className="struct-pre">{table.content}</pre>
                    </div>
                  ))}
                </>
              ) : null}

              {formulas.length > 0 ? (
                <>
                  <h4 className="struct-title">公式（{formulas.length}）</h4>
                  <ul className="struct-list">
                    {formulas.map((formula, index) => (
                      <li key={`formula-${index}`}>
                        <button
                          type="button"
                          className="struct-page"
                          onClick={() => jumpToStructPage(formula.page_num)}
                        >
                          P.{formula.page_num}
                        </button>
                        <code>{formula.content}</code>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {structReferences.length > 0 ? (
                <>
                  <h4 className="struct-title">参考文献（{structReferences.length}）</h4>
                  <ul className="struct-list">
                    {structReferences.map((reference, index) => (
                      <li key={`struct-ref-${index}`}>
                        <button
                          type="button"
                          className="struct-page"
                          onClick={() => jumpToStructPage(reference.page_num)}
                        >
                          P.{reference.page_num}
                        </button>
                        <span>{reference.content}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          )}
        </section>
      </div>

      {/* 划词后的浮动翻译按钮 */}
      {floatButton ? (
        <button
          type="button"
          className="float-translate"
          style={{ left: floatButton.x, top: floatButton.y }}
          onClick={translateSelection}
          disabled={selectionBusy}
        >
          翻译
        </button>
      ) : null}
    </main>
  );
}

export default function ReadPage() {
  return (
    <Suspense fallback={<main className="container">加载中…</main>}>
      <ReadPageInner />
    </Suspense>
  );
}

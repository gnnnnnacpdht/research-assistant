"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as pdfjsLib from "pdfjs-dist";

import { apiBaseUrl } from "../../lib/apiBase";

// worker 文件由构建时复制到 public/，避免从 CDN 拉取（内网/演示环境更稳）
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const CITATION_RE = /\[(\d{1,3})\]/g;

function extractCitations(text) {
  const found = new Set();
  for (const match of (text || "").matchAll(CITATION_RE)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
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

  const [tab, setTab] = useState("translate"); // translate | references
  const [references, setReferences] = useState({ entries: [], first_pages: {} });
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
          ) : (
            <div className="pane-content">
              <h3 className="pane-title">参考文献</h3>
              {references.entries.length === 0 ? (
                <p className="message">未解析到参考文献条目。</p>
              ) : (
                <ol className="ref-list">
                  {references.entries.map((entry) => (
                    <li
                      key={`${entry.index}-${entry.page}`}
                      id={`ref-entry-${entry.index}`}
                      className={activeCitation === entry.index ? "ref-item active" : "ref-item"}
                    >
                      <div className="ref-text">
                        <span className="ref-index">[{entry.index}]</span> {entry.text}
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
                  ))}
                </ol>
              )}
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

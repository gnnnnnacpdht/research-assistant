"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as pdfjsLib from "pdfjs-dist";

import { apiBaseUrl } from "../../lib/apiBase";
import { EmptyState, ErrorBanner, LoadingBlock } from "../Feedback";

// worker 文件由构建时复制到 public/，避免从 CDN 拉取（内网/演示环境更稳）。
// 带版本查询串：文件内容不变时浏览器会 304 复用旧响应头（曾把 .mjs 缓存成 text/plain），
// 换一个 URL 可强制重新拉取，避免模块 MIME 校验失败的假死。
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs?v=4.10.38-reader2";

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
// activeKey 命中时高亮：用于目录面板标记"当前页码所属章节"。
function HeadingTree({ nodes, onJump, activeKey }) {
  if (!nodes || nodes.length === 0) {
    return null;
  }
  return (
    <ul className="struct-tree">
      {nodes.map((node) => {
        const nodeKey = `${node.level}-${node.page_num}-${node.content}`;
        return (
          <li key={nodeKey}>
            {node.children.length > 0 ? (
              <details open={node.level <= 2}>
                <summary>
                  <button
                    type="button"
                    className={
                      nodeKey === activeKey ? "struct-heading active" : "struct-heading"
                    }
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
                <HeadingTree
                  nodes={node.children}
                  onJump={onJump}
                  activeKey={activeKey}
                />
              </details>
            ) : (
              <div className="struct-leaf">
                <button
                  type="button"
                  className={
                    nodeKey === activeKey ? "struct-heading active" : "struct-heading"
                  }
                  onClick={() => onJump(node.page_num)}
                >
                  {node.content}
                </button>
                <span className="struct-page">P.{node.page_num}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ReadPageInner() {
  const searchParams = useSearchParams();
  const paperId = Number(searchParams.get("paper_id") || 0);

  const canvasWrapRef = useRef(null);
  const pdfDocRef = useRef(null);
  // 仅保留当前页和前后各一页；每项包含可复用的 canvas、文本层与渲染 Promise。
  const pageCacheRef = useRef(new Map());
  const translateCacheRef = useRef(new Map()); // 页码 → 译文，减少重复请求
  const referencesLoadedRef = useRef(0);
  const pdfScrollRef = useRef(null); // 左侧 PDF 滚动容器
  const sideScrollRef = useRef(null); // 右侧译文滚动容器
  const syncLockRef = useRef({ side: "", at: 0 }); // 防止两栏互相触发的滚动死循环
  const bulkAbortRef = useRef(false); // 整篇翻译的中断标记（切论文/卸载时置位）

  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  // PDF 文档就绪计数：dev 模式 StrictMode 会重挂载 effect，
  // 只依赖 pageCount 可能出现"文档已销毁、页码没变"的空渲染，用计数兜底重渲染。
  const [docReady, setDocReady] = useState(0);
  const [pageText, setPageText] = useState("");
  const [textReadyPage, setTextReadyPage] = useState(0);
  const [translation, setTranslation] = useState("");
  const [translating, setTranslating] = useState(false);
  const [visiblePage, setVisiblePage] = useState(0);
  const [pageRendering, setPageRendering] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [status, setStatus] = useState("正在加载文档 0%…");
  const [error, setError] = useState("");
  const [translationError, setTranslationError] = useState("");
  const [translationRetry, setTranslationRetry] = useState(0);
  const firstPageReady = visiblePage > 0;

  // 目录面板开合、左右同步滚动开关
  const [tocOpen, setTocOpen] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);
  // 整篇翻译进度：{done,total,running,failed}
  const [bulk, setBulk] = useState(null);

  const [tab, setTab] = useState("translate"); // translate | references | structure
  const [references, setReferences] = useState({ entries: [], first_pages: {} });
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referencesError, setReferencesError] = useState("");
  const [referencesRetry, setReferencesRetry] = useState(0);
  // 低含金量（应付式）引用默认折叠，跳转命中时自动展开
  const [showLowRefs, setShowLowRefs] = useState(false);
  // 结构化视图：一次取全部条目，切标签页不再重复请求
  const [structure, setStructure] = useState({ counts: {}, items: [] });
  const [structureLoading, setStructureLoading] = useState(false);
  const [structureError, setStructureError] = useState("");
  const [structureRetry, setStructureRetry] = useState(0);
  const [activeCitation, setActiveCitation] = useState(null);
  const [selectionResult, setSelectionResult] = useState(null); // {text, translation}
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [floatButton, setFloatButton] = useState(null); // {x, y, text}

  // 渲染结果缓存到 DOM 节点，翻回相邻页时无需重新下载或绘制。
  // 同一个 Promise 同时供当前页与预取任务复用，避免重复 render 同一页。
  const renderPdfPage = useCallback((targetPage) => {
    const cache = pageCacheRef.current;
    const existing = cache.get(targetPage);
    if (existing) return existing.promise;

    const canvas = document.createElement("canvas");
    const layer = document.createElement("div");
    layer.className = "pdf-text-layer";
    const entry = { canvas, layer, task: null, promise: null };

    entry.promise = (async () => {
      const doc = pdfDocRef.current;
      if (!doc) throw new Error("PDF 尚未就绪");
      const page = await doc.getPage(targetPage);
      const viewport = page.getViewport({ scale: 1.35 });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = viewport.width * ratio;
      canvas.height = viewport.height * ratio;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;

      const context = canvas.getContext("2d");
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      // 文本提取和画布绘制在 worker / 主线程并行，互不等待。
      const textContentPromise = page.getTextContent();
      entry.task = page.render({ canvasContext: context, viewport });
      const [content] = await Promise.all([textContentPromise, entry.task.promise]);
      entry.task = null;

      // 文本层：把每个文字片段绝对定位到 canvas 上，才能用鼠标选中。
      // 预取时节点尚未插入文档，因此用 canvas 测量文字宽度，而非 DOM 测量。
      const measurer = document.createElement("canvas").getContext("2d");
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

        const targetWidth = item.width * viewport.scale;
        measurer.font = `${fontHeight}px sans-serif`;
        const measured = measurer.measureText(item.str).width;
        if (measured > 0 && targetWidth > 0) {
          span.style.transform = `scaleX(${targetWidth / measured})`;
        }
      }
      return entry;
    })();

    cache.set(targetPage, entry);
    entry.promise.catch(() => {
      // 失败页不留在缓存里，下次翻到该页可以重试。
      if (cache.get(targetPage) === entry) cache.delete(targetPage);
    });
    return entry.promise;
  }, []);

  // ===== 1. 加载 PDF 文档（与下方当前页文本请求并行）=====
  useEffect(() => {
    if (!paperId) {
      setError("缺少 paper_id 参数，请从论文库点「阅读」进入");
      return;
    }
    let cancelled = false;
    let doc = null;
    setError("");
    setVisiblePage(0);
    setPageRendering(false);
    setPageNum(1);
    setPageCount(0);
    setLoadProgress(0);
    setStatus("正在加载文档 0%…");
    translateCacheRef.current.clear();
    referencesLoadedRef.current = 0;

    const loadingTask = pdfjsLib.getDocument({
      url: `${apiBaseUrl}/api/papers/${paperId}/file`,
      // 禁止自动拉取整本；64KB 小块避免为首页多下载无关内容（公网实测优于 512KB）。
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 64 * 1024,
    });
    loadingTask.onProgress = ({ loaded, total }) => {
      if (cancelled) return;
      const percent = total > 0
        ? Math.min(99, Math.round((loaded / total) * 100))
        : 0;
      setLoadProgress(percent);
      setStatus(total > 0
        ? `正在加载文档 ${percent}%…`
        : `正在加载文档 ${(loaded / 1024 / 1024).toFixed(1)} MB…`);
    };

    (async () => {
      try {
        doc = await loadingTask.promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        pdfDocRef.current = doc;
        setPageCount(doc.numPages);
        setLoadProgress(100);
        setDocReady((value) => value + 1);
      } catch (err) {
        if (!cancelled) setError(`PDF 加载失败：${err.message}`);
      }
    })();

    return () => {
      cancelled = true;
      for (const entry of pageCacheRef.current.values()) entry.task?.cancel?.();
      pageCacheRef.current.clear();
      loadingTask.destroy().catch(() => {});
      if (pdfDocRef.current === doc) pdfDocRef.current = null;
    };
  }, [paperId]);

  // ===== 2. 当前页优先显示，再空闲预取前后各一页（缓存最多三页）=====
  useEffect(() => {
    let cancelled = false;
    let prefetchTimer = null;

    async function render() {
      const doc = pdfDocRef.current;
      if (!doc) return;
      setError("");
      setPageRendering(true);
      setStatus(`正在渲染第 ${pageNum} 页…`);

      // 超出当前页 ±1 的画布立即释放，长文档不会随翻页累积内存。
      for (const [cachedPage, entry] of pageCacheRef.current) {
        if (Math.abs(cachedPage - pageNum) > 1) {
          entry.task?.cancel?.();
          pageCacheRef.current.delete(cachedPage);
        }
      }

      try {
        const entry = await renderPdfPage(pageNum);
        if (cancelled || !canvasWrapRef.current) return;
        canvasWrapRef.current.replaceChildren(entry.canvas, entry.layer);
        setVisiblePage(pageNum);
        setPageRendering(false);
        setStatus("");

        // 首页已经可见后才预取邻居，不与首屏争夺带宽和主线程。
        prefetchTimer = window.setTimeout(async () => {
          for (const neighbor of [pageNum - 1, pageNum + 1]) {
            if (cancelled || neighbor < 1 || neighbor > doc.numPages) continue;
            try {
              await renderPdfPage(neighbor);
            } catch (err) {
              if (!cancelled && err?.name !== "RenderingCancelledException") {
                // 邻居预取失败不影响阅读，真正翻到该页时会重新尝试。
                pageCacheRef.current.delete(neighbor);
              }
            }
          }
        }, 150);
      } catch (err) {
        if (err?.name !== "RenderingCancelledException" && !cancelled) {
          setError(`第 ${pageNum} 页渲染失败：${err.message}`);
          setPageRendering(false);
        }
      }
    }

    render();
    return () => {
      cancelled = true;
      if (prefetchTimer) window.clearTimeout(prefetchTimer);
    };
  }, [pageNum, docReady, renderPdfPage]);

  // ===== 3a. 当前页文本立即请求，与 PDF 文件下载并行 =====
  useEffect(() => {
    if (!paperId) return;
    let cancelled = false;
    setPageText("");
    setTextReadyPage(0);
    setTranslation("");
    setTranslationError("");
    setTranslating(false);
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
        setTextReadyPage(pageNum);
        setPageCount(data.page_count || 0);
      } catch (err) {
        if (!cancelled) setTranslationError(`第 ${pageNum} 页文本加载失败：${err.message}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paperId, pageNum, translationRetry]);

  // ===== 3b. 当前页真正可见后才翻译；同页译文只请求一次 =====
  useEffect(() => {
    if (!paperId || visiblePage !== pageNum || textReadyPage !== pageNum) return;
    if (translateCacheRef.current.has(pageNum)) {
      setTranslation(translateCacheRef.current.get(pageNum));
      setTranslating(false);
      return;
    }

    let cancelled = false;
    setTranslating(true);
    (async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pageText }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail ?? "翻译失败");
        // 即使用户已翻页也保留结果，之后回来不必再调用模型。
        translateCacheRef.current.set(pageNum, data.translation);
        if (!cancelled) setTranslation(data.translation);
      } catch (err) {
        if (!cancelled) setTranslationError(`第 ${pageNum} 页翻译失败：${err.message}`);
      } finally {
        if (!cancelled) setTranslating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paperId, pageNum, pageText, textReadyPage, visiblePage, translationRetry]);

  // ===== 4. 参考文献延迟到用户打开标签页时再请求，不占首屏带宽 =====
  useEffect(() => {
    if (!paperId || tab !== "references" || referencesLoadedRef.current === paperId) return;
    let cancelled = false;
    setReferencesLoading(true);
    setReferencesError("");
    fetch(`${apiBaseUrl}/api/papers/${paperId}/references`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail ?? `加载失败（HTTP ${response.status}）`);
        if (cancelled) return;
        setReferences({ entries: data.entries || [], first_pages: data.first_pages || {} });
        referencesLoadedRef.current = paperId;
      })
      .catch((err) => {
        if (!cancelled) setReferencesError(`参考文献加载失败：${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setReferencesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paperId, tab, referencesRetry]);

  // 参考文献可能是点击正文引用后才加载，数据到达后再完成定位。
  useEffect(() => {
    if (tab !== "references" || activeCitation === null || references.entries.length === 0) return;
    const target = references.entries.find((entry) => entry.index === activeCitation);
    // 延迟加载前无法判断目标是否位于折叠区；数据到达后先展开，再由下一轮 effect 定位。
    if (target?.low_quality && !showLowRefs) {
      setShowLowRefs(true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`ref-entry-${activeCitation}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, references, activeCitation, showLowRefs]);

  // ===== 4b. 结构目录在首页可见后加载；每篇论文只取一次 =====
  useEffect(() => {
    if (!paperId || !firstPageReady) return;
    let cancelled = false;
    setStructureLoading(true);
    fetch(`${apiBaseUrl}/api/papers/${paperId}/structure`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.detail ?? `加载失败（HTTP ${response.status}）`);
        }
        if (cancelled) return;
        setStructure({ counts: data.counts || {}, items: data.items || [] });
        setStructureError("");
      })
      .catch((error) => {
        if (!cancelled) setStructureError(`结构化内容加载失败：${error.message}`);
      })
      .finally(() => {
        if (!cancelled) setStructureLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paperId, firstPageReady, structureRetry]);

  // ===== 4c. 整篇翻译：按页顺序请求，命中缓存直接跳过 =====
  // 只逐页串行调用（并发会打爆 LLM 限流），每完成一页刷新一次进度。
  async function translateAll() {
    if (bulk?.running || pageCount <= 0) return;
    bulkAbortRef.current = false;
    setTab("translate");
    setBulk({ done: 0, total: pageCount, running: true, failed: 0 });

    let failed = 0;
    for (let page = 1; page <= pageCount; page += 1) {
      if (bulkAbortRef.current) break;
      if (!translateCacheRef.current.has(page)) {
        try {
          const textResp = await fetch(
            `${apiBaseUrl}/api/papers/${paperId}/page/${page}`,
            { cache: "no-store" },
          );
          const textData = await textResp.json().catch(() => ({}));
          if (!textResp.ok) throw new Error(textData.detail ?? "取页面文本失败");

          const trResp = await fetch(`${apiBaseUrl}/api/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: textData.text || "" }),
          });
          const trData = await trResp.json().catch(() => ({}));
          if (!trResp.ok) throw new Error(trData.detail ?? "翻译失败");
          // 写入同一个缓存，之后翻页/重进页面都直接复用
          translateCacheRef.current.set(page, trData.translation);
        } catch {
          failed += 1; // 单页失败不中断，继续下一页
        }
      }
      setBulk({
        done: page,
        total: pageCount,
        running: page < pageCount,
        failed,
      });
    }
    setBulk((prev) => (prev ? { ...prev, running: false } : prev));
  }

  // 切换论文或卸载时终止仍在跑的整篇翻译，避免对已卸载组件 setState
  useEffect(() => {
    bulkAbortRef.current = false;
    return () => {
      bulkAbortRef.current = true;
    };
  }, [paperId]);

  // 翻页后两栏都回到顶部，否则长滚动位置会把人带到页面中段
  useEffect(() => {
    if (pdfScrollRef.current) pdfScrollRef.current.scrollTop = 0;
    if (sideScrollRef.current) sideScrollRef.current.scrollTop = 0;
  }, [pageNum]);

  // ===== 4d. 同步滚动：按百分比联动 =====
  // 一侧滚动 → 计算其在自身可滚动区间里的比例 → 设置另一侧 scrollTop。
  // 程序化设置会反过来触发对方的 onScroll，用 120ms 时间锁抑制回声。
  const handleSyncScroll = useCallback(
    (side) => {
      if (!syncScroll || tab !== "translate") return;
      const source = side === "pdf" ? pdfScrollRef.current : sideScrollRef.current;
      const target = side === "pdf" ? sideScrollRef.current : pdfScrollRef.current;
      if (!source || !target) return;

      const now = performance.now();
      const lock = syncLockRef.current;
      if (lock.side && lock.side !== side && now - lock.at < 120) return;
      syncLockRef.current = { side, at: now };

      const sourceMax = source.scrollHeight - source.clientHeight;
      const targetMax = target.scrollHeight - target.clientHeight;
      if (sourceMax <= 0 || targetMax <= 0) return;
      const ratio = Math.min(1, Math.max(0, source.scrollTop / sourceMax));
      target.scrollTop = ratio * targetMax;
    },
    [syncScroll, tab],
  );

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
      setTranslationError(`划词翻译失败：${err.message}`);
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

  // 目录高亮：取"页码不大于当前页"的最后一个标题，即当前阅读位置所属章节
  const activeHeadingKey = (() => {
    let active = null;
    for (const heading of headings) {
      if (heading.page_num <= pageNum) active = heading;
    }
    return active
      ? `${active.level}-${active.page_num}-${active.content}`
      : null;
  })();

  function jumpToStructPage(page) {
    if (page) setPageNum(Number(page));
  }

  function retryReadFailures() {
    if (error) {
      window.location.reload();
      return;
    }
    setTranslationError("");
    setReferencesError("");
    setStructureError("");
    setTranslationRetry((value) => value + 1);
    setReferencesRetry((value) => value + 1);
    setStructureRetry((value) => value + 1);
  }

  if (!paperId) {
    return (
      <main className="container">
        <ErrorBanner message={error || "缺少 paper_id 参数，请从论文库进入"} onClose={() => setError("")} />
        <EmptyState
          title="还没有选择要阅读的论文"
          description="从论文库点击“阅读”，即可打开原版 PDF 与中文译文。"
          actionLabel="前往论文库"
          actionHref="/papers"
        />
      </main>
    );
  }

  return (
    <main className="read-page">
      <header className="read-head">
        <div className="read-head-left">
          <nav className="read-breadcrumb" aria-label="面包屑">
            <a href="/papers">论文库</a>
            <span aria-hidden="true">›</span>
            <span>双语联动阅读</span>
          </nav>
          <span className="read-title" title={metaTitle?.content || "论文标题加载中"}>
            {metaTitle?.content || "论文标题加载中…"}
          </span>
          <span className="read-page-count">第 {pageNum} / {pageCount || "?"} 页</span>
        </div>
        <div className="read-head-actions">
          <div className="page-nav">
            <button
              className="secondary"
              type="button"
              onClick={() => setPageNum((n) => Math.max(1, n - 1))}
              disabled={pageNum <= 1}
            >
              上一页
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => setPageNum((n) => Math.min(pageCount || 1, n + 1))}
              disabled={pageCount > 0 && pageNum >= pageCount}
            >
              下一页
            </button>
          </div>
          <div className="bulk-translate">
            <button
              className="secondary"
              type="button"
              onClick={translateAll}
              disabled={Boolean(bulk?.running) || pageCount === 0}
            >
              {bulk?.running
                ? `翻译中 ${bulk.done}/${bulk.total}`
                : "整篇翻译"}
            </button>
            {bulk && !bulk.running ? (
              <span className="bulk-status">
                {bulk.failed > 0
                  ? `完成 ${bulk.total} 页，${bulk.failed} 页失败`
                  : `已完成 ${bulk.total} 页译文并缓存`}
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <ErrorBanner
        message={error || translationError || referencesError || structureError}
        onRetry={retryReadFailures}
        onClose={() => {
          setError("");
          setTranslationError("");
          setReferencesError("");
          setStructureError("");
        }}
      />

      {bulk?.running ? (
        <div className="bulk-bar">
          <span
            style={{
              width: `${Math.round((bulk.done / Math.max(1, bulk.total)) * 100)}%`,
            }}
          />
        </div>
      ) : null}

      <div className="read-body">
        {/* 左侧：标题目录 + pdf.js 原版 */}
        <section className="pdf-pane" onMouseUp={handleMouseUp}>
          <div className="toc-panel">
            <div className="toc-head">
              <button
                type="button"
                className="toc-toggle"
                onClick={() => setTocOpen((value) => !value)}
              >
                {tocOpen ? "▾" : "▸"} 目录（{headings.length}）
                {activeHeadingKey ? " · 当前章节已高亮" : ""}
              </button>
              <label className="sync-toggle">
                <input
                  type="checkbox"
                  checked={syncScroll}
                  onChange={(event) => setSyncScroll(event.target.checked)}
                />
                同步滚动
              </label>
            </div>
            {tocOpen ? (
              headings.length > 0 ? (
                <div className="toc-body">
                  <HeadingTree
                    nodes={buildHeadingTree(headings)}
                    onJump={jumpToStructPage}
                    activeKey={activeHeadingKey}
                  />
                </div>
              ) : (
                <p className="toc-empty">
                  该论文暂无标题结构（后台结构抽取完成后刷新本页可见）。
                </p>
              )
            ) : null}
          </div>

          <div
            className="pdf-scroll"
            ref={pdfScrollRef}
            onScroll={() => handleSyncScroll("pdf")}
          >
            <div className="pdf-stage">
              <div className="pdf-canvas-wrap" ref={canvasWrapRef} />
              {(visiblePage === 0 || pageRendering) && !error ? (
                <div className="pdf-loading" role="status" aria-live="polite">
                  <div className="pdf-skeleton-page" aria-hidden="true">
                    <span /><span /><span /><span /><span /><span />
                  </div>
                  <p>{status || `正在加载第 ${pageNum} 页…`}</p>
                  <div className="pdf-load-track" aria-hidden="true">
                    <span style={{ width: `${visiblePage === 0 ? loadProgress : 100}%` }} />
                  </div>
                </div>
              ) : null}
            </div>
            <p className="pdf-tip">在页面上拖选英文，会弹出「翻译」按钮</p>
          </div>
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
            <div
              className="pane-content"
              ref={sideScrollRef}
              onScroll={() => handleSyncScroll("side")}
            >
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
                <LoadingBlock compact label={`正在翻译第 ${pageNum} 页…`} lines={5} />
              ) : translation ? (
                <div className="translation-text">{translation}</div>
              ) : !translationError ? (
                <EmptyState
                  title="当前页暂无译文"
                  description="页面文本加载后会自动翻译；也可以重新加载当前页。"
                  actionLabel="重新加载译文"
                  onAction={() => setTranslationRetry((value) => value + 1)}
                />
              ) : null}
            </div>
          ) : tab === "references" ? (
            <div className="pane-content">
              <h3 className="pane-title">参考文献</h3>
              {referencesLoading ? (
                <LoadingBlock compact label="正在解析参考文献…" lines={4} />
              ) : references.entries.length === 0 && !referencesError ? (
                <EmptyState
                  title="未解析到参考文献"
                  description="可尝试重新加载，或回到论文库选择其他论文。"
                  actionLabel="重新加载"
                  onAction={() => setReferencesRetry((value) => value + 1)}
                />
              ) : references.entries.length > 0 ? (
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
              ) : null}
            </div>
          ) : (
            <div className="pane-content">
              <h3 className="pane-title">结构化视图</h3>
              {structureLoading ? <LoadingBlock compact label="正在加载标题、表格与公式…" lines={4} /> : null}
              {!structureLoading && !structureError && structure.items.length === 0 ? (
                <EmptyState
                  title="结构化内容尚未就绪"
                  description="新上传论文会在后台自动抽取标题、表格、公式和参考文献。"
                  actionLabel="重新检查"
                  onAction={() => setStructureRetry((value) => value + 1)}
                />
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
    <Suspense fallback={<main className="container"><LoadingBlock label="正在打开双语阅读器…" /></main>}>
      <ReadPageInner />
    </Suspense>
  );
}

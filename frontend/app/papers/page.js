"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl } from "../../lib/apiBase";

// 从文件名里取版本号，如 1706.03762v7.pdf → 7；取不到返回 null
function parseVersion(name) {
  const matched = /v(\d+)(?=\.pdf|$)/i.exec(name || "");
  return matched ? Number(matched[1]) : null;
}

// 版本提示：新上传的版本比库里旧时提醒"已有更新版本"，避免误覆盖
function buildVersionHint(newName, duplicates) {
  const newVersion = parseVersion(newName);
  if (newVersion === null) return "";
  const newer = duplicates.find((d) => {
    const existing = parseVersion(d.filename);
    return existing !== null && existing > newVersion;
  });
  if (!newer) return "";
  return `库中已有更新版本 ${newer.filename}（v${parseVersion(newer.filename)}），当前上传的是 v${newVersion}，建议保留两个版本而不是覆盖。`;
}

export default function PapersPage() {
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [warning, setWarning] = useState("");
  // 语义去重预警弹窗状态
  const [dedupeToken, setDedupeToken] = useState("");
  const [duplicates, setDuplicates] = useState([]);
  const [dedupeFilename, setDedupeFilename] = useState("");
  const [comparing, setComparing] = useState(false);
  const [revisionSummary, setRevisionSummary] = useState("");
  const [revisionTargetId, setRevisionTargetId] = useState(null);
  const fileInputRef = useRef(null);
  // arXiv 导入与推荐
  const [arxivQuery, setArxivQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [arxivMessage, setArxivMessage] = useState("");
  const [recommend, setRecommend] = useState({ keywords: [], items: [], message: "" });
  const [recommendLoading, setRecommendLoading] = useState(false);

  const loadPapers = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/papers`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`加载失败（HTTP ${response.status}）`);
      }
      setPapers(await response.json());
      setListError("");
    } catch (error) {
      setListError(`${error.message}，请确认后端已启动（${apiBaseUrl}）`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 推荐依赖库内论文的关键词统计，所以放在论文列表加载完之后单独请求，
  // 即使 arXiv 网络慢/失败也不影响论文库本身打开。
  const loadRecommendations = useCallback(async () => {
    setRecommendLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/papers/recommend?limit=3`, {
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail ?? `推荐加载失败（HTTP ${response.status}）`);
      setRecommend({
        keywords: data.keywords || [],
        items: data.items || [],
        message: data.message || "",
      });
    } catch (error) {
      setRecommend({ keywords: [], items: [], message: error.message });
    } finally {
      setRecommendLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPapers();
    loadRecommendations();
  }, [loadPapers, loadRecommendations]);

  // 上传/arXiv 导入共用：进入去重弹窗
  function openDedupe(data, fallbackName) {
    setDedupeToken(data.token || "");
    setDuplicates(data.duplicates || papers);
    setDedupeFilename(data.filename || fallbackName);
  }

  async function handleUpload(event) {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setMessage("请先选择一个 PDF 文件");
      return;
    }

    setUploading(true);
    setMessage("");
    setWarning("");
    setRevisionSummary("");
    setRevisionTargetId(null);
    const body = new FormData();
    body.append("file", file);

    try {
      const response = await fetch(`${apiBaseUrl}/api/papers/upload`, {
        method: "POST",
        body,
      });

      if (response.status === 309) {
        // 后端检测到疑似重复，返回 JSONResponse 带 body（token/duplicates）+ headers
        const dupData = await response.json().catch(() => ({}));
        openDedupe(
          {
            ...dupData,
            token: dupData.token || response.headers.get("X-Dedupe-Token") || "",
          },
          file.name,
        );
        return;
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail ?? `上传失败（HTTP ${response.status}）`);
      }
      const ocrNote = data.ocr_pages ? `，其中 ${data.ocr_pages} 页由 OCR 识别` : "";
      setMessage(
        `已入库：${data.filename}（${data.page_count} 页，${data.text_chars} 字符${ocrNote}）`,
      );
      if (data.warning) {
        setWarning(data.warning);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      await loadPapers();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUploading(false);
    }
  }

  // 从 arXiv 检索并导入：query 可以是 arXiv ID，也可以是标题关键词
  async function importFromArxiv(query) {
    const text = (query || "").trim();
    if (!text) {
      setArxivMessage("请输入 arXiv ID（如 1706.03762）或标题关键词");
      return;
    }

    setImporting(true);
    setArxivMessage("");
    setRevisionSummary("");
    setRevisionTargetId(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/papers/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      });

      if (response.status === 309) {
        const dupData = await response.json().catch(() => ({}));
        openDedupe(
          {
            ...dupData,
            token: dupData.token || response.headers.get("X-Dedupe-Token") || "",
          },
          dupData.filename || text,
        );
        return;
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail ?? `导入失败（HTTP ${response.status}）`);
      }

      if (data.already_imported) {
        setArxivMessage(
          `《${data.arxiv.title}》已在库中（ID ${data.paper.id}），未重复下载。`,
        );
      } else {
        const paper = data.paper || {};
        setArxivMessage(
          `已导入：《${data.arxiv.title}》（${paper.page_count} 页，${data.arxiv.year}）` +
            (paper.github_url ? `，识别到开源仓库 ${paper.github_url}` : ""),
        );
      }
      setArxivQuery("");
      await loadPapers();
      await loadRecommendations();
    } catch (error) {
      setArxivMessage(error.message);
    } finally {
      setImporting(false);
    }
  }

  function handleArxivImport(event) {
    event.preventDefault();
    importFromArxiv(arxivQuery);
  }

  async function handleConfirm(action, replaceIds) {
    if (!dedupeToken) return;
    setUploading(true);
    try {
      const endpoint =
        action === "keep"
          ? "confirm-keep"
          : action === "overwrite"
            ? "confirm-overwrite"
            : null;
      if (!endpoint) return;

      const payload = { token: dedupeToken };
      if (replaceIds && action === "overwrite") {
        payload.replace_ids = replaceIds;
      }

      const response = await fetch(`${apiBaseUrl}/api/papers/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail ?? `操作失败（HTTP ${response.status}）`);
      }
      setMessage(
        `已${action === "overwrite" ? "覆盖入库" : "保留入库"}：${data.filename}（${data.page_count} 页）`,
      );
      closeDedupeDialog();
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadPapers();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleCompare(targetId) {
    if (!dedupeToken) return;
    setComparing(true);
    setRevisionSummary("");
    setRevisionTargetId(targetId);
    try {
      const response = await fetch(`${apiBaseUrl}/api/papers/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: dedupeToken, target_id: targetId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "对比失败");
      setRevisionSummary(data.summary);
      // compare 不消费 token，继续持有
    } catch (error) {
      setMessage("对比失败：" + error.message);
    } finally {
      setComparing(false);
    }
  }

  async function handleCancel() {
    if (!dedupeToken) return;
    try {
      await fetch(`${apiBaseUrl}/api/papers/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: dedupeToken }),
      });
    } catch {
      /* ignore */
    }
    closeDedupeDialog();
  }

  function closeDedupeDialog() {
    setDedupeToken("");
    setDuplicates([]);
    setDedupeFilename("");
    setRevisionSummary("");
    setRevisionTargetId(null);
  }

  async function handleDelete(paper) {
    if (
      !window.confirm(
        `确定删除《${paper.filename}》（ID ${paper.id}）吗？\n该论文的分页文本与向量索引会一并删除，不可恢复。`,
      )
    ) {
      return;
    }

    setMessage("");
    setWarning("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/papers/${paper.id}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail ?? `删除失败（HTTP ${response.status}）`);
      }
      setMessage(`已删除：${data.filename}（ID ${data.deleted}）`);
      await loadPapers();
    } catch (error) {
      setMessage(error.message);
    }
  }

  // ========== 渲染 ==========
  return (
    <main className="container papers-page">
      <section className="page-head">
        <p className="eyebrow">PAPER LIBRARY</p>
        <h1>论文库</h1>
        <p className="intro">
          上传 PDF 后系统会自动保存原文件、逐页提取文本并写入数据库。
        </p>
        <a className="secondary link-back" href="/">
          ← 返回首页
        </a>
        <div>
          <a className="ask-entry" href="/ask">
            进入智能问答 →
          </a>
        </div>
      </section>

      <div className="papers-layout">
        <div className="papers-left">
      <section className="card">
        <h2>上传 PDF</h2>
        <form className="upload-form" onSubmit={handleUpload}>
          <input ref={fileInputRef} name="pdf" type="file" accept="application/pdf,.pdf" />
          <button className="primary" type="submit" disabled={uploading}>
            {uploading ? "解析中…" : "上传并解析"}
          </button>
        </form>
        {message ? <p className="message">{message}</p> : null}
        {warning ? <p className="message error">{warning}</p> : null}
      </section>

      <section className="card">
        <h2>从 arXiv 导入</h2>
        <form className="upload-form" onSubmit={handleArxivImport}>
          <input
            type="text"
            value={arxivQuery}
            onChange={(event) => setArxivQuery(event.target.value)}
            placeholder="arXiv ID（1706.03762）或标题关键词，如 large language model"
            disabled={importing}
          />
          <button className="primary" type="submit" disabled={importing}>
            {importing ? "检索下载中…" : "检索并导入"}
          </button>
        </form>
        <p className="hint">
          系统调用 arXiv 官方接口取相关度最高的一篇，自动下载 PDF 并走解析、去重、索引流程。
        </p>
        {arxivMessage ? <p className="message">{arxivMessage}</p> : null}
      </section>
        </div>

        <div className="papers-right">
      <section className="card papers-recommend">
        <div className="list-head">
          <h2>推荐论文</h2>
          <button
            className="secondary"
            type="button"
            onClick={loadRecommendations}
            disabled={recommendLoading}
          >
            {recommendLoading ? "计算中…" : "刷新推荐"}
          </button>
        </div>
        <p className="hint">
          基于库内论文的关键词共现（
          {recommend.keywords.length > 0 ? recommend.keywords.join("、") : "暂无"}）检索 arXiv。
        </p>
        {recommend.message ? <p className="message">{recommend.message}</p> : null}
        {recommend.items.length > 0 ? (
          <div className="recommend-grid">
            {recommend.items.map((item) => (
              <article className="recommend-card" key={item.arxiv_id}>
                <h3>{item.title}</h3>
                <p className="recommend-meta">
                  {item.authors.slice(0, 3).join("、")}
                  {item.authors.length > 3 ? " 等" : ""} · {item.year} · arXiv:{item.arxiv_id}
                </p>
                <p className="recommend-reason">
                  {item.reason}
                  {item.has_github ? (
                    <span className="badge-open">开源复现</span>
                  ) : null}
                </p>
                <div className="recommend-actions">
                  <a className="secondary read-link" href={item.abs_url} target="_blank" rel="noreferrer">
                    arXiv 页面
                  </a>
                  <button
                    className="primary"
                    type="button"
                    disabled={importing}
                    onClick={() => importFromArxiv(item.arxiv_id)}
                  >
                    一键导入
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <section className="card papers-list">
        <div className="list-head">
          <h2>已入库论文（{papers.length}）</h2>
          <button className="secondary" type="button" onClick={loadPapers}>
            刷新
          </button>
        </div>

        {loading ? <p className="message">加载中…</p> : null}
        {listError ? <p className="message error">{listError}</p> : null}
        {!loading && !listError && papers.length === 0 ? (
          <p className="message">还没有论文，先上传一个 PDF 试试。</p>
        ) : null}

        {papers.length > 0 ? (
          <div className="table-wrap">
            <table className="papers-table">
              <thead>
                <tr>
                  <th className="paper-id-col">ID</th>
                  <th>文件名</th>
                  <th className="paper-pages-col">页数</th>
                  <th className="paper-actions-col">操作</th>
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => (
                  <tr key={paper.id}>
                    <td>{paper.id}</td>
                    <td className="paper-filename" title={paper.filename}>
                      <div className="paper-filename-inner">
                        <span className="paper-filename-text">{paper.filename}</span>
                        {paper.github_url ? (
                          <a
                            className="badge-open"
                            href={paper.github_url}
                            target="_blank"
                            rel="noreferrer"
                            title={paper.github_url}
                          >
                            开源复现
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td>{paper.page_count}</td>
                    <td>
                      <a className="secondary read-link" href={`/read?paper_id=${paper.id}`}>
                        阅读
                      </a>
                      <button
                        className="danger"
                        type="button"
                        onClick={() => handleDelete(paper)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
        </div>
      </div>

      {/* 语义去重预警弹窗 */}
      {dedupeToken ? (
        <div className="modal-backdrop" onClick={handleCancel}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>⚠️ 疑似重复论文</h2>
            <p className="intro">
              待上传 <strong>{dedupeFilename}</strong> 与库内已有论文内容高度相似，请选择处理方式：
            </p>
            {buildVersionHint(dedupeFilename, duplicates) ? (
              <p className="version-hint">{buildVersionHint(dedupeFilename, duplicates)}</p>
            ) : null}
            <div className="dup-list">
              {duplicates.map((d) => (
                <button
                  key={d.paper_id}
                  type="button"
                  className={`dup-item ${revisionTargetId === d.paper_id ? "active" : ""}`}
                  onClick={() => handleCompare(d.paper_id)}
                  disabled={comparing}
                >
                  <span>
                    <strong>{d.filename}</strong>（ID {d.paper_id}）
                    {typeof d.similarity === "number" ? (
                      <span className="sim-badge">
                        相似度 {(d.similarity * 100).toFixed(1)}%
                      </span>
                    ) : null}
                  </span>
                  <span className="dup-hint">
                    {comparing && revisionTargetId === d.paper_id
                      ? "对比中…"
                      : "点此对比版本差异 →"}
                  </span>
                </button>
              ))}
            </div>
            {revisionSummary ? (
              <div className="revision-box">
                <h3>📝 修订摘要（由 DeepSeek 生成）</h3>
                <pre>{revisionSummary}</pre>
              </div>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="danger"
                onClick={handleCancel}
                disabled={uploading}
              >
                取消上传
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => handleConfirm("keep")}
                disabled={uploading}
              >
                保留两个版本
              </button>
              <button
                type="button"
                className="primary"
                onClick={() =>
                  handleConfirm(
                    "overwrite",
                    duplicates.map((d) => d.paper_id),
                  )
                }
                disabled={uploading}
              >
                覆盖（删除旧版）
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

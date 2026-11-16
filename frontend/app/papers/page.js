"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl } from "../../lib/apiBase";

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

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

  useEffect(() => {
    loadPapers();
  }, [loadPapers]);

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
        setDedupeToken(dupData.token || response.headers.get("X-Dedupe-Token") || "");
        setDuplicates(dupData.duplicates || papers);
        setDedupeFilename(dupData.filename || file.name);
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
    <main className="container">
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
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>文件名</th>
                  <th>页数</th>
                  <th>上传时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => (
                  <tr key={paper.id}>
                    <td>{paper.id}</td>
                    <td>{paper.filename}</td>
                    <td>{paper.page_count}</td>
                    <td>{formatTime(paper.uploaded_at)}</td>
                    <td>
                      <a className="secondary read-link" href={`/read?paper_id=${paper.id}`}>
                        阅读
                      </a>
                      <a className="secondary read-link" href={`/graph?paper_id=${paper.id}`}>
                        图谱
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

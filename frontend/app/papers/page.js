"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function PapersPage() {
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  // 用 ref 持有文件输入框：await 之后合成事件的 currentTarget 会被置空，不能再依赖它。
  const fileInputRef = useRef(null);

  // 拉取论文列表；上传成功后复用同一函数实现自动刷新。
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
    const body = new FormData();
    body.append("file", file);

    try {
      const response = await fetch(`${apiBaseUrl}/api/papers/upload`, {
        method: "POST",
        body,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail ?? `上传失败（HTTP ${response.status}）`);
      }
      setMessage(
        `已入库：${data.filename}（${data.page_count} 页，${data.text_chars} 字符）`,
      );
      // 清空已选文件，方便连续上传下一份。
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
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => (
                  <tr key={paper.id}>
                    <td>{paper.id}</td>
                    <td>{paper.filename}</td>
                    <td>{paper.page_count}</td>
                    <td>{formatTime(paper.uploaded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </main>
  );
}

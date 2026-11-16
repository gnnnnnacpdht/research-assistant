"use client";

import { useMemo, useRef, useState } from "react";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
);

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

// 极简 CSV 解析：支持双引号包裹与转义，够覆盖常见导出文件
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((cell) => cell.trim() !== ""));
}

function toNumber(value) {
  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export default function CopilotPage() {
  const fileRef = useRef(null);
  const [analysis, setAnalysis] = useState(null);
  const [rawRows, setRawRows] = useState([]);
  const [chartType, setChartType] = useState("bar");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);

  // 选轴：第一个数值列当 Y，第一个非数值列当 X
  const axes = useMemo(() => {
    if (!analysis) return null;
    const header = analysis.header || [];
    const numericIndex = header.findIndex(
      (_, position) =>
        analysis.columns[position]?.type === "numeric" &&
        rawRows.some((row) => toNumber(row[position]) !== null),
    );
    const categoryIndex = header.findIndex(
      (_, position) => analysis.columns[position]?.type !== "numeric",
    );
    const yIndex = numericIndex >= 0 ? numericIndex : header.length - 1;
    const xIndex = categoryIndex >= 0 ? categoryIndex : 0;
    return {
      xIndex,
      yIndex,
      xName: header[xIndex],
      yName: header[yIndex],
    };
  }, [analysis, rawRows]);

  const chartData = useMemo(() => {
    if (!axes) return null;
    const limit = rawRows.slice(0, 60);
    return {
      labels: limit.map((row, position) => row[axes.xIndex] || `#${position + 1}`),
      datasets: [
        {
          label: axes.yName,
          data: limit.map((row) => toNumber(row[axes.yIndex]) ?? 0),
          backgroundColor: "rgba(37, 99, 235, 0.45)",
          borderColor: "#2563eb",
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 3,
        },
      ],
    };
  }, [axes, rawRows]);

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "top" },
        title: {
          display: true,
          text: axes ? `${axes.yName} by ${axes.xName}` : "",
          font: { size: 14 },
        },
      },
      scales: {
        x: { title: { display: true, text: axes?.xName } },
        y: { title: { display: true, text: axes?.yName }, beginAtZero: true },
      },
    }),
    [axes],
  );

  async function handleUpload(event) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage("请先选择一个 CSV 文件");
      return;
    }

    setLoading(true);
    setMessage("");
    setAnalysis(null);
    setRawRows([]);
    setCopied(false);

    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error("CSV 至少需要表头 + 1 行数据");
      setRawRows(rows.slice(1));

      const body = new FormData();
      body.append("file", file);
      const response = await fetch(`${apiBaseUrl}/api/csv/analyze`, {
        method: "POST",
        body,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? `分析失败（HTTP ${response.status}）`);
      setAnalysis(data);
      setMessage(`已解析 ${data.row_count} 行 · ${data.columns.length} 列`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function copyCaption() {
    if (!analysis?.caption_en) return;
    const text = `${analysis.caption_en}\n\n${analysis.caption_zh || ""}`.trim();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage("复制失败，请手动选中文本复制");
    }
  }

  return (
    <main className="container">
      <section className="page-head">
        <p className="eyebrow">DATA COPILOT</p>
        <h1>CSV 数据可视化 Copilot</h1>
        <p className="intro">
          上传 CSV，自动生成图表与学术 Figure Caption（图表由 Chart.js 渲染，图注由 DeepSeek 生成）。
        </p>
        <a className="secondary link-back" href="/">
          ← 返回首页
        </a>
      </section>

      <section className="card">
        <h2>上传数据</h2>
        <form className="upload-form" onSubmit={handleUpload}>
          <input ref={fileRef} name="csv" type="file" accept=".csv,text/csv" />
          <button className="primary" type="submit" disabled={loading}>
            {loading ? "分析中…" : "上传并生成图注"}
          </button>
        </form>
        {message ? <p className="message">{message}</p> : null}
      </section>

      {analysis ? (
        <>
          <section className="card">
            <div className="list-head">
              <h2>图表</h2>
              <div className="chart-switch">
                {[
                  ["bar", "柱状图"],
                  ["line", "折线图"],
                  ["table", "表格"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={chartType === value ? "tab active" : "tab"}
                    onClick={() => setChartType(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {chartType === "table" ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {analysis.header.map((name) => (
                        <th key={name}>{name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rawRows.slice(0, 20).map((row, position) => (
                      <tr key={position}>
                        {analysis.header.map((name, column) => (
                          <td key={`${name}-${column}`}>{row[column]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="chart-box">
                {chartType === "bar" ? (
                  <Bar data={chartData} options={chartOptions} />
                ) : (
                  <Line data={chartData} options={chartOptions} />
                )}
              </div>
            )}
          </section>

          <section className="card">
            <div className="list-head">
              <h2>学术图注</h2>
              <button className="secondary" type="button" onClick={copyCaption}>
                {copied ? "已复制 ✓" : "一键复制"}
              </button>
            </div>
            <p className="caption-en">{analysis.caption_en}</p>
            <p className="caption-zh">{analysis.caption_zh}</p>
            {analysis.model === "fallback" ? (
              <p className="message">
                模型暂不可用，当前为本地统计生成的兜底图注。
              </p>
            ) : null}
          </section>

          <section className="card">
            <h2>列分析</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>列名</th>
                    <th>类型</th>
                    <th>缺失</th>
                    <th>统计</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.columns.map((column) => (
                    <tr key={column.name}>
                      <td>{column.name}</td>
                      <td>{column.type === "numeric" ? "数值" : "类别"}</td>
                      <td>{column.missing}</td>
                      <td>
                        {column.type === "numeric"
                          ? `均值 ${column.mean}｜范围 ${column.min} ~ ${column.max}`
                          : `${column.distinct} 个不同值`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

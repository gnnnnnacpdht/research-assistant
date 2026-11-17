"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import * as echarts from "echarts/core";
import { GraphChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

import { apiBaseUrl } from "../../lib/apiBase";
import { EmptyState, ErrorBanner, LoadingBlock } from "../Feedback";

echarts.use([GraphChart, TooltipComponent, CanvasRenderer]);

// ====== 颜色常量 ======
const COLOR_ROOT = "#1D4ED8";       // 中心论文：深蓝 + 白边 + 光晕
const COLOR_IN_LIB = "#10B981";      // in_library 第三种颜色：翠绿，区分"库内有收录"
const COLOR_KEY = "#F59E0B";         // 基石文献：橙金（importance 前 15%）
const COLOR_REF = "#3B82F6";         // 普通引用：蓝
const COLOR_LINK = "#94A3B8";
const BG = "#F8FAFC";

const INITIAL_ZOOM = 1.15;
const INITIAL_CENTER = [0, 0];

function shortTitle(title, max = 14) {
  const text = (title || "").trim() || "标题未解析";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function symbolSize(importance) {
  const value = Number(importance) || 0;
  return Math.round(14 + (Math.min(100, Math.max(0, value)) / 100) * 28);
}

// ====== 通用 ECharts option ======
function buildSingleChartOption(chartData) {
  // chartData.nodes / links 由 buildSingleChartData 生成
  return {
    backgroundColor: BG,
    tooltip: {
      trigger: "item",
      confine: true,
      backgroundColor: "rgba(15,23,42,0.94)",
      borderWidth: 0,
      textStyle: { color: "#e2e8f0" },
      formatter: function (params) {
        if (params.dataType === "edge") {
          const sp = params.data?.source_page;
          return (
            `<div style="font-size:12px;line-height:1.6">引用关系<br/>` +
            `<strong>引自第 ${sp ?? "?"} 页参考文献</strong>` +
            (params.data?.value ? `<br/>权重 ${params.data.value}` : "") +
            `</div>`
          );
        }
        const meta = params.data?.meta || {};
        if (meta.kind === "root") {
          return `<div style="font-size:12px;line-height:1.7"><strong>本论文</strong><br/>${meta.title || ""}</div>`;
        }
        const inLib = meta.in_library;
        const extra = inLib
          ? `<br/><span style="color:#34d399">✓ 库内已收录（score ${meta.in_library_score ?? "-"}）</span>`
          : "";
        return (
          `<div style="font-size:12px;line-height:1.7;max-width:340px">` +
          `<strong>[${meta.index}] ${meta.title || "标题未解析"}</strong>${extra}<br/>` +
          `年份：${meta.year ?? "未知"}<br/>` +
          `参考文献页：P.${meta.source_page ?? meta.page ?? "-"}<br/>` +
          `正文提及：${meta.mentions ?? 0} 次<br/>` +
          `importance：${meta.importance ?? "-"}` +
          `</div>`
        );
      },
    },
    series: [
      {
        type: "graph",
        layout: "force",
        roam: true,
        draggable: true,
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        force: {
          repulsion: 300,
          edgeLength: [70, 150],
          gravity: 0.1,
          layoutAnimation: false,
        },
        data: chartData.nodes,
        links: chartData.links,
        lineStyle: {
          color: COLOR_LINK,
          opacity: 0.35,
          width: 1.2,
          curveness: 0.2,
        },
        itemStyle: { borderColor: "#fff", borderWidth: 1.5 },
        label: { show: false },
        emphasis: {
          focus: "adjacency",
          scale: 1.05,
          itemStyle: { shadowBlur: 24, shadowColor: "rgba(37,99,235,0.55)" },
          lineStyle: { color: COLOR_ROOT, opacity: 1, width: 2.4 },
          label: { show: true, color: "#1e293b", fontWeight: 600 },
        },
        blur: { itemStyle: { opacity: 0.18 }, lineStyle: { opacity: 0.08 }, label: { opacity: 0.12 } },
      },
    ],
  };
}

function buildGlobalChartOption(chartData) {
  return {
    backgroundColor: BG,
    tooltip: {
      trigger: "item",
      confine: true,
      backgroundColor: "rgba(15,23,42,0.94)",
      borderWidth: 0,
      textStyle: { color: "#e2e8f0" },
      formatter: function (params) {
        if (params.dataType === "edge") {
          const sp = params.data?.source_page;
          return `<div style="font-size:12px;line-height:1.6">引用关系<br/>引自第 ${sp ?? "?"} 页参考文献</div>`;
        }
        const m = params.data?.meta || {};
        return (
          `<div style="font-size:12px;line-height:1.7;max-width:300px">` +
          `<strong>${m.title || "未知论文"}</strong><br/>` +
          `库内 ID：${m.paper_id ?? "-"}` +
          `</div>`
        );
      },
    },
    series: [
      {
        type: "graph",
        layout: "force",
        roam: true,
        draggable: true,
        force: { repulsion: 260, edgeLength: [80, 160], gravity: 0.1, layoutAnimation: false },
        data: chartData.nodes,
        links: chartData.links,
        lineStyle: { color: COLOR_LINK, opacity: 0.4, width: 1.2, curveness: 0.15 },
        itemStyle: { borderColor: "#fff", borderWidth: 1.5 },
        label: { show: false },
        emphasis: { focus: "adjacency", scale: 1.05, label: { show: true, color: "#1e293b", fontWeight: 600 } },
        blur: { itemStyle: { opacity: 0.22 }, lineStyle: { opacity: 0.1 } },
      },
    ],
  };
}

// ====== 单篇图谱：后端数据 → ECharts nodes/links ======
function buildSingleChartData(data) {
  const allNodes = data.nodes || [];
  const refs = allNodes.filter((n) => n.kind !== "root");
  const root = allNodes.find((n) => n.kind === "root");

  // 基石文献：importance 前 15%（至少 1）
  const sorted = [...refs].sort((a, b) => b.importance - a.importance);
  const keyCount = Math.max(1, Math.round(sorted.length * 0.15));
  const keyIds = new Set(sorted.slice(0, keyCount).map((n) => n.id));
  // 常显 label：前 10
  const labelIds = new Set(sorted.slice(0, 10).map((n) => n.id));

  const nodes = [];

  if (root) {
    nodes.push({
      id: root.id,
      name: shortTitle(root.title, 10),
      x: 0, y: 0, fixed: true,
      symbolSize: 58,
      itemStyle: { color: COLOR_ROOT, borderColor: "#fff", borderWidth: 3,
                   shadowBlur: 22, shadowColor: "rgba(29,78,216,0.45)" },
      label: { show: true, position: "inside", color: "#fff", fontSize: 12, fontWeight: 600 },
      meta: root,
    });
  }

  for (const node of refs) {
    const isKey = keyIds.has(node.id);
    const inLib = node.in_library;
    // 颜色优先级：in_library 三原色 > 基石 > 普通
    let color = COLOR_REF;
    let shadowColor = "transparent";
    let shadowBlur = 0;
    if (inLib) { color = COLOR_IN_LIB; shadowColor = "rgba(16,185,129,0.55)"; shadowBlur = 18; }
    else if (isKey) { color = COLOR_KEY; shadowColor = "rgba(245,158,11,0.65)"; shadowBlur = 18; }

    nodes.push({
      id: node.id,
      name: `[${node.index}] ${shortTitle(node.title)}`,
      symbolSize: symbolSize(node.importance),
      itemStyle: { color, borderColor: "#fff", borderWidth: 1.5, shadowBlur, shadowColor },
      label: {
        show: labelIds.has(node.id) || inLib,
        position: "right",
        fontSize: 12,
        color: inLib ? "#047857" : "#334155",
        width: 130,
        overflow: "truncate",
        formatter: () => shortTitle(node.title),
      },
      meta: node,
    });
  }

  const links = (data.edges || []).map((edge) => ({
    source: edge.source,
    target: edge.target,
    value: edge.weight,
    source_page: edge.source_page,
    lineStyle: { width: Math.min(3, 0.8 + (edge.weight || 1) * 0.35) },
  }));

  return { refs, keyCount, nodes, links };
}

// ====== 全局跨库图谱 ======
function buildGlobalChartData(data) {
  const nodes = (data.nodes || []).map((n) => ({
    id: n.id,
    name: shortTitle(n.title || n.id, 16),
    symbolSize: 26,
    itemStyle: { color: COLOR_ROOT, borderColor: "#fff", borderWidth: 1.5,
                 shadowBlur: 10, shadowColor: "rgba(29,78,216,0.3)" },
    label: { show: true, position: "right", fontSize: 12, color: "#334155",
             width: 160, overflow: "truncate", formatter: () => shortTitle(n.title, 18) },
    meta: n,
  }));

  const links = (data.edges || []).map((e) => ({
    source: e.source, target: e.target,
    source_page: e.source_page,
    value: e.weight,
    lineStyle: { width: Math.min(3, 0.8 + (e.weight || 1) * 0.35) },
  }));

  return { nodes, links };
}

// ====== 单篇图谱组件 ======
function SingleGraphTab({ paperId, papers, onPaperChange }) {
  const chartRef = useRef(null);
  const containerRef = useRef(null);
  const initialViewRef = useRef({ zoom: INITIAL_ZOOM, center: INITIAL_CENTER });
  const fittedRef = useRef(false);

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (pid) => {
    setLoading(true); setError(""); setData(null);
    try {
      const resp = await fetch(`${apiBaseUrl}/api/graph/paper/${pid}`, { cache: "no-store" });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.detail ?? "单篇图谱加载失败");
      setData(j);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(paperId); }, [paperId, load]);

  const chartData = useMemo(() => (data ? buildSingleChartData(data) : null), [data]);
  const inLibCount = chartData
    ? chartData.refs.filter((r) => r.in_library).length
    : 0;

  useEffect(() => {
    if (!chartData || chartData.refs.length === 0) return undefined;
    const chart = echarts.init(containerRef.current, null, { renderer: "canvas" });
    chartRef.current = chart;
    chart.setOption(buildSingleChartOption(chartData), true);
    initialViewRef.current = { zoom: INITIAL_ZOOM, center: INITIAL_CENTER };
    fittedRef.current = false;

    function fitToNodes() {
      if (fittedRef.current) return;
      const seriesData = chart.getModel()?.getSeriesByIndex(0)?.getData?.();
      if (!seriesData) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < seriesData.count(); i += 1) {
        const p = seriesData.getItemLayout(i);
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
      if (!Number.isFinite(minX)) return;
      fittedRef.current = true;
      const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
      const w = chart.getWidth(), h = chart.getHeight();
      const sidePad = 24, labelReserve = 140;
      const availW = Math.max(120, w - labelReserve - sidePad);
      const availH = Math.max(120, h - sidePad * 2);
      const zoom = Math.min(2, Math.max(0.4, Math.min(availW / spanX, availH / spanY)));
      const center = [minX - (sidePad - w / 2) / zoom, (minY + maxY) / 2];
      initialViewRef.current = { zoom, center };
      chart.setOption({ series: [{ zoom, center }] });
    }

    chart.on("finished", fitToNodes);
    const t = setTimeout(fitToNodes, 600);
    chart.on("click", (params) => {
      if (params.dataType === "node" && params.data?.meta?.in_library) {
        window.open(`/read?paper_id=${params.data.meta.in_library_paper_id}`, "_blank");
      }
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t); chart.off("finished", fitToNodes);
      window.removeEventListener("resize", onResize); chart.dispose();
      chartRef.current = null;
    };
  }, [chartData]);

  function zoomStep(factor) {
    const c = chartRef.current; if (!c) return;
    const cur = Number(c.getOption().series?.[0]?.zoom) || initialViewRef.current.zoom;
    c.setOption({ series: [{ zoom: Math.min(3, Math.max(0.3, cur * factor)) }] });
  }
  function resetView() {
    const c = chartRef.current; if (!c) return;
    c.setOption({ series: [{ ...initialViewRef.current }] });
  }

  if (loading) return <LoadingBlock label="正在解析参考文献并构建单篇图谱…" lines={5} />;
  if (error) return <ErrorBanner message={`加载失败：${error}`} onRetry={() => load(paperId)} onClose={() => setError("")} />;

  if (!data) return null;

  const empty = chartData.refs.length === 0;

  return (
    <div className="graph-tab-body">
      {/* 论文选择器 */}
      <div className="graph-picker">
        <label>选择论文</label>
        <select
          className="paper-select"
          value={paperId}
          onChange={(e) => onPaperChange(Number(e.target.value))}
        >
          {papers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} · {p.filename}
            </option>
          ))}
        </select>
        <button className="secondary" type="button" onClick={() => load(paperId)}>
          刷新
        </button>
      </div>

      {/* 统计条 */}
      {!empty ? (
        <div className="graph-stats">
          <span><strong>{chartData.refs.length}</strong> 条参考文献</span>
          <span className="graph-stats-divider">|</span>
          <span>库内已收录 <strong style={{ color: "#10B981" }}>{inLibCount}</strong> 条</span>
          <span className="graph-stats-divider">|</span>
          <span>基石文献 <strong>{chartData.keyCount}</strong> 篇</span>
          <span className="graph-stats-hint">
            点击绿色节点跳转库内对应论文；悬停边查看引自第几页
          </span>
        </div>
      ) : null}

      {/* 画布 */}
      <div className="graph-canvas">
        {empty ? (
          <div className="graph-empty">
            <EmptyState
              title={data.message ? "解析受限" : "该论文未解析到参考文献"}
              description={data.message || "如果 References 是图片或特殊排版，解析可能为空；扫描件需先完成 OCR。"}
              actionLabel="返回论文库"
              actionHref="/papers"
            />
          </div>
        ) : (
          <>
            <div className="graph-chart" ref={containerRef} />
            <div className="graph-overlay-right">
              <div className="graph-zoom-tools">
                <button type="button" className="graph-zoom-btn" aria-label="放大" onClick={() => zoomStep(1.25)}>+</button>
                <button type="button" className="graph-zoom-btn" aria-label="缩小" onClick={() => zoomStep(0.8)}>−</button>
                <button type="button" className="graph-zoom-btn wide" aria-label="复位" onClick={resetView}>复位</button>
              </div>
              <div className="graph-legend">
                <span className="legend-title">图例</span>
                <span className="legend-row"><i className="legend-dot root" />本论文</span>
                <span className="legend-row"><i className="legend-dot inlib" />库内已收录（可跳转）</span>
                <span className="legend-row"><i className="legend-dot high" />基石文献</span>
                <span className="legend-row"><i className="legend-dot ref" />普通引用</span>
                <span className="legend-note">圆越大 = 影响力越高；悬停连线看引自第几页</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 溯源说明 */}
      {!empty ? (
        <p className="graph-attribution">
          本图谱由解析《{data.filename}》参考文献列表自动生成，共 {chartData.refs.length} 条引用
          {inLibCount > 0 ? `，其中 ${inLibCount} 条库内已收录` : ""}。
        </p>
      ) : null}
    </div>
  );
}

// ====== 全局跨库图谱组件 ======
function GlobalGraphTab() {
  const chartRef = useRef(null);
  const containerRef = useRef(null);
  const initialViewRef = useRef({ zoom: INITIAL_ZOOM, center: INITIAL_CENTER });
  const fittedRef = useRef(false);

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setData(null);
    try {
      const resp = await fetch(`${apiBaseUrl}/api/graph/library`, { cache: "no-store" });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.detail ?? "全局图谱加载失败");
      setData(j);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const chartData = useMemo(() => (data ? buildGlobalChartData(data) : null), [data]);

  useEffect(() => {
    if (!chartData || chartData.nodes.length === 0) return undefined;
    const chart = echarts.init(containerRef.current, null, { renderer: "canvas" });
    chartRef.current = chart;
    chart.setOption(buildGlobalChartOption(chartData), true);
    initialViewRef.current = { zoom: INITIAL_ZOOM, center: INITIAL_CENTER };
    fittedRef.current = false;

    function fit() {
      if (fittedRef.current) return;
      const sd = chart.getModel()?.getSeriesByIndex(0)?.getData?.();
      if (!sd) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < sd.count(); i += 1) {
        const p = sd.getItemLayout(i);
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
      if (!Number.isFinite(minX)) return;
      fittedRef.current = true;
      const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
      const w = chart.getWidth(), h = chart.getHeight();
      const sidePad = 24, labelReserve = 180;
      const availW = Math.max(120, w - labelReserve - sidePad);
      const availH = Math.max(120, h - sidePad * 2);
      const zoom = Math.min(2, Math.max(0.3, Math.min(availW / spanX, availH / spanY)));
      const center = [minX - (sidePad - w / 2) / zoom, (minY + maxY) / 2];
      initialViewRef.current = { zoom, center };
      chart.setOption({ series: [{ zoom, center }] });
    }
    chart.on("finished", fit);
    const t = setTimeout(fit, 600);
    chart.on("click", (params) => {
      if (params.dataType === "node" && params.data?.meta?.paper_id) {
        window.open(`/read?paper_id=${params.data.meta.paper_id}`, "_blank");
      }
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t); chart.off("finished", fit);
      window.removeEventListener("resize", onResize); chart.dispose();
      chartRef.current = null;
    };
  }, [chartData]);

  function zoomStep(f) {
    const c = chartRef.current; if (!c) return;
    const cur = Number(c.getOption().series?.[0]?.zoom) || initialViewRef.current.zoom;
    c.setOption({ series: [{ zoom: Math.min(3, Math.max(0.3, cur * f)) }] });
  }
  function resetView() {
    const c = chartRef.current; if (!c) return;
    c.setOption({ series: [{ ...initialViewRef.current }] });
  }

  if (loading) return <LoadingBlock label="正在构建跨库引用网络…" lines={4} />;
  if (error) return <ErrorBanner message={`加载失败：${error}`} onRetry={load} onClose={() => setError("")} />;
  if (!data) return null;

  const empty = !data.nodes || data.nodes.length === 0;

  return (
    <div className="graph-tab-body">
      <div className="graph-picker">
        <span className="graph-picker-label">基于库内 {data.paper_count ?? 0} 篇论文的自引引用网络</span>
        <button className="secondary" type="button" onClick={load}>刷新</button>
      </div>

      <div className="graph-stats">
        <span><strong>{data.node_count ?? 0}</strong> 个节点</span>
        <span className="graph-stats-divider">|</span>
        <span><strong>{data.edge_count ?? 0}</strong> 条跨库引用关系</span>
        <span className="graph-stats-hint">点击节点跳转对应论文；节点越多说明库内引用网络越密</span>
      </div>

      <div className="graph-canvas">
        {empty ? (
          <div className="graph-empty">
            <EmptyState
              title="跨库引用网络为空"
              description={data.message || "当前库内论文之间还没有互相引用的匹配。先多上传几篇同领域论文再看。"}
              actionLabel="返回论文库"
              actionHref="/papers"
            />
          </div>
        ) : (
          <>
            <div className="graph-chart" ref={containerRef} />
            <div className="graph-overlay-right">
              <div className="graph-zoom-tools">
                <button type="button" className="graph-zoom-btn" aria-label="放大" onClick={() => zoomStep(1.25)}>+</button>
                <button type="button" className="graph-zoom-btn" aria-label="缩小" onClick={() => zoomStep(0.8)}>−</button>
                <button type="button" className="graph-zoom-btn wide" aria-label="复位" onClick={resetView}>复位</button>
              </div>
              <div className="graph-legend">
                <span className="legend-title">图例</span>
                <span className="legend-row"><i className="legend-dot root" />库内论文</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ====== 主页面 ======
export default function GraphPage() {
  return (
    <Suspense fallback={<main className="container"><LoadingBlock label="正在打开引用图谱…" /></main>}>
      <GraphPageInner />
    </Suspense>
  );
}

function GraphPageInner() {
  const searchParams = useSearchParams();
  const initialPaperId = Number(searchParams.get("paper_id") || 24);
  const [tab, setTab] = useState("single"); // single | global
  const [paperId, setPaperId] = useState(initialPaperId);
  const [papers, setPapers] = useState([]);

  // 加载论文下拉选
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/api/papers`, { cache: "no-store" })
      .then((r) => r.json().catch(() => []))
      .then((list) => { if (!cancelled) setPapers(list || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="container graph-page">
      <section className="page-head graph-page-head">
        <div>
          <p className="eyebrow">CITATION NETWORK</p>
          <h1>引用图谱</h1>
          <p className="intro">可视化论文的参考文献网络，发现基石文献与跨库引用关系。</p>
        </div>
        <Link className="secondary link-back" href="/">← 返回首页</Link>
      </section>

      {/* Tab 切换 */}
      <div className="graph-tabs">
        <button
          className={`graph-tab-btn ${tab === "single" ? "active" : ""}`}
          type="button"
          onClick={() => setTab("single")}
        >
          单篇图谱
        </button>
        <button
          className={`graph-tab-btn ${tab === "global" ? "active" : ""}`}
          type="button"
          onClick={() => setTab("global")}
        >
          全局图谱
        </button>
      </div>

      <section className="card graph-card">
        {tab === "single" ? (
          <SingleGraphTab
            paperId={paperId}
            papers={papers}
            onPaperChange={setPaperId}
          />
        ) : (
          <GlobalGraphTab />
        )}
      </section>
    </main>
  );
}

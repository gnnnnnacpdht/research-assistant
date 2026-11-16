"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as echarts from "echarts/core";
import { GraphChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

import { apiBaseUrl } from "../../lib/apiBase";
import { EmptyState, ErrorBanner, LoadingBlock } from "../Feedback";

// 按需注册，避免把整个 echarts 打进来（图谱只需要 graph + tooltip + canvas 渲染）
echarts.use([GraphChart, TooltipComponent, CanvasRenderer]);

const COLOR_ROOT = "#1D4ED8"; // 本论文：深蓝 + 白边
const COLOR_KEY = "#F59E0B"; // 基石文献：橙金 + 光晕
const COLOR_REF = "#3B82F6"; // 普通引用：蓝
const COLOR_LINK = "#94A3B8";
const BG = "#F8FAFC"; // 与全站浅色主题一致
// 初始视图：布局原点（本论文所在）对准画布中心；真实缩放会在力导向结束后按包围盒自适应
const INITIAL_ZOOM = 1.15;
const INITIAL_CENTER = [0, 0];

// 标签截断：超过 max 个字符用省略号，避免长标题糊满画布
function shortTitle(title, max = 12) {
  const text = (title || "").trim() || "标题未解析";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 节点半径由 importance 线性映射到 14-42px
function symbolSize(importance) {
  const value = Number(importance) || 0;
  return Math.round(14 + (Math.min(100, Math.max(0, value)) / 100) * 28);
}

// 把接口数据折算成 ECharts 需要的节点/连线，并标注"基石"与"常显标签"两批节点
function buildChartData(data) {
  const allNodes = data.nodes || [];
  const refs = allNodes.filter((node) => node.kind !== "root");
  const root = allNodes.find((node) => node.kind === "root");

  const sorted = [...refs].sort((a, b) => b.importance - a.importance);
  // 基石文献 = importance 前 15%（至少 1 篇）
  const keyCount = Math.max(1, Math.round(sorted.length * 0.15));
  const keyIds = new Set(sorted.slice(0, keyCount).map((node) => node.id));
  // importance 前 10 的节点常显标题，其余只在 tooltip 里看
  const labelIds = new Set(sorted.slice(0, 10).map((node) => node.id));

  const nodes = [];

  if (root) {
    nodes.push({
      id: root.id,
      name: "本论文",
      x: 0,
      y: 0,
      fixed: true, // 力导向时钉在画布中央，其它节点围着它散开
      symbolSize: 56,
      itemStyle: {
        color: COLOR_ROOT,
        borderColor: "#fff",
        borderWidth: 3,
        shadowBlur: 22,
        shadowColor: "rgba(29,78,216,0.45)",
      },
      label: {
        show: true,
        position: "inside",
        color: "#fff",
        fontSize: 12,
        fontWeight: 600,
      },
      meta: root,
    });
  }

  for (const node of refs) {
    const isKey = keyIds.has(node.id);
    nodes.push({
      id: node.id,
      name: `[${node.index}] ${shortTitle(node.title)}`,
      symbolSize: symbolSize(node.importance),
      itemStyle: {
        color: isKey ? COLOR_KEY : COLOR_REF,
        borderColor: "#fff",
        borderWidth: 1.5,
        shadowBlur: isKey ? 18 : 0, // 基石文献带橙色光晕
        shadowColor: isKey ? "rgba(245,158,11,0.65)" : "transparent",
      },
      label: {
        show: labelIds.has(node.id),
        position: "right",
        fontSize: 12,
        color: "#334155",
        width: 100, // 限制标签宽度，配合视图预留的右侧空间，避免文字出画布
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
    lineStyle: { width: Math.min(3, 0.8 + (edge.weight || 1) * 0.35) },
  }));

  return { refs, keyCount, nodes, links };
}

// tooltip：引用节点展示标题/年份/被引次数/importance，连线只提示权重
function tooltipFormatter(params) {
  if (params.dataType === "edge") {
    return (
      `<div style="font-size:12px;line-height:1.6">引用关系<br/>` +
      `权重 ${params.data?.value ?? 1}（正文提及越多越高）</div>`
    );
  }
  const meta = params.data?.meta || {};
  if (meta.kind === "root") {
    return `<div style="font-size:12px;line-height:1.7"><strong>本论文</strong><br/>${meta.title || ""}</div>`;
  }
  return (
    `<div style="font-size:12px;line-height:1.7;max-width:320px">` +
    `<strong>[${meta.index}] ${meta.title || "标题未解析"}</strong><br/>` +
    `年份：${meta.year ?? "未知"}<br/>` +
    `正文提及：${meta.mentions ?? 0} 次<br/>` +
    `importance：${meta.importance ?? "-"}` +
    `</div>`
  );
}

function buildOption(chartData) {
  return {
    backgroundColor: BG,
    tooltip: {
      trigger: "item",
      confine: true,
      backgroundColor: "rgba(15,23,42,0.94)",
      borderWidth: 0,
      textStyle: { color: "#e2e8f0" },
      formatter: tooltipFormatter,
    },
    series: [
      {
        type: "graph",
        layout: "force",
        roam: true, // 滚轮缩放 + 拖拽平移
        draggable: true, // 节点可拖动
        // 明确指定视图原点，避免力导向尚未散开时按初始包围盒取中心，导致整群偏到画布一角
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        force: {
          repulsion: 300,
          edgeLength: [70, 150],
          gravity: 0.1, // 重力稍大，把节点群收拢在画布中央
          // 关闭布局动画：力导向在首帧前算完，视图不会按"散开前"的小包围盒定格
          layoutAnimation: false,
        },
        data: chartData.nodes,
        links: chartData.links,
        lineStyle: {
          color: COLOR_LINK,
          opacity: 0.35,
          width: 1.2,
          curveness: 0.2, // 曲线，避免直线交叉成网格
        },
        itemStyle: { borderColor: "#fff", borderWidth: 1.5 },
        label: { show: false },
        // 悬停：高亮相邻节点/连线，其余淡化
        emphasis: {
          focus: "adjacency",
          scale: 1.05,
          itemStyle: { shadowBlur: 24, shadowColor: "rgba(37,99,235,0.55)" },
          lineStyle: { color: COLOR_ROOT, opacity: 1, width: 2.4 },
          label: { show: true, color: "#1e293b", fontWeight: 600 },
        },
        blur: {
          itemStyle: { opacity: 0.18 },
          lineStyle: { opacity: 0.08 },
          label: { opacity: 0.12 },
        },
      },
    ],
  };
}

function GraphInner() {
  const searchParams = useSearchParams();
  const paperId = Number(searchParams.get("paper_id") || 24);

  const chartRef = useRef(null);
  const containerRef = useRef(null);
  // 初始视图（力导向结束后按节点包围盒算出），复位按钮回到这里
  const initialViewRef = useRef({ zoom: INITIAL_ZOOM, center: INITIAL_CENTER });
  const fittedRef = useRef(false);

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const [selected, setSelected] = useState(null);
  // 自动综述弹层
  const [survey, setSurvey] = useState(null);
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [surveyLoading, setSurveyLoading] = useState(false);
  const [surveyError, setSurveyError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError("");
      try {
        const response = await fetch(`${apiBaseUrl}/api/papers/${paperId}/citations`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail ?? "加载引用图谱失败");
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paperId, retryToken]);

  const chartData = useMemo(() => (data ? buildChartData(data) : null), [data]);

  // 初始化 ECharts：数据就绪后建图，窗口尺寸变化时自适应
  useEffect(() => {
    if (!chartData || chartData.refs.length === 0) return undefined;
    const chart = echarts.init(containerRef.current, null, { renderer: "canvas" });
    chartRef.current = chart;
    chart.setOption(buildOption(chartData), true);
    initialViewRef.current = { zoom: INITIAL_ZOOM, center: INITIAL_CENTER };
    fittedRef.current = false;

    // 力导向散开后再按真实包围盒算一次 center/zoom：
    // 首次渲染时节点还在布局原点附近，ECharts 会按小包围盒定视图，结果整群偏到一角。
    function fitToNodes() {
      if (fittedRef.current) return;
      const seriesData = chart.getModel()?.getSeriesByIndex(0)?.getData?.();
      if (!seriesData) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < seriesData.count(); index += 1) {
        const point = seriesData.getItemLayout(index);
        if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
        minX = Math.min(minX, point[0]);
        maxX = Math.max(maxX, point[0]);
        minY = Math.min(minY, point[1]);
        maxY = Math.max(maxY, point[1]);
      }
      if (!Number.isFinite(minX)) return; // 布局还没就绪，等兜底定时器再试
      fittedRef.current = true;

      const spanX = Math.max(1, maxX - minX);
      const spanY = Math.max(1, maxY - minY);
      const width = chart.getWidth();
      const height = chart.getHeight();
      const sidePad = 24; // 四周基础留白
      const labelReserve = 110; // 常显标签在节点右侧展开，额外预留
      const availW = Math.max(120, width - labelReserve - sidePad);
      const availH = Math.max(120, height - sidePad * 2);
      const zoom = Math.min(
        2,
        Math.max(0.4, Math.min(availW / spanX, availH / spanY)),
      );
      // 让节点包围盒左边缘刚好落在 sidePad 处：剩余宽度自然留给右侧标签
      // 屏幕 x = width/2 + (x - centerX) * zoom，解出 centerX
      const center = [minX - (sidePad - width / 2) / zoom, (minY + maxY) / 2];
      initialViewRef.current = { zoom, center };
      chart.setOption({ series: [{ zoom, center }] });
    }

    chart.on("finished", fitToNodes);
    // 力导向动画被节流时 finished 可能来得晚，兜底再试一次
    const fitTimer = setTimeout(fitToNodes, 600);

    // 点击节点 → 打开右侧抽屉
    chart.on("click", (params) => {
      if (params.dataType === "node" && params.data?.meta) {
        setSelected(params.data.meta);
      }
    });

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(fitTimer);
      chart.off("finished", fitToNodes);
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, [chartData]);

  // 缩放按钮：在当前 zoom 基础上乘系数，中心保持用户当前视野
  function zoomStep(factor) {
    const chart = chartRef.current;
    if (!chart) return;
    const current = Number(chart.getOption().series?.[0]?.zoom) || initialViewRef.current.zoom;
    const next = Math.min(3, Math.max(0.3, current * factor));
    chart.setOption({ series: [{ zoom: next }] });
  }

  // 复位：回到力导向结束后算出的初始视野
  function resetView() {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption({ series: [{ ...initialViewRef.current }] });
  }

  // Esc 关闭抽屉 / 综述弹层
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      if (surveyOpen) closeSurvey();
      else if (selected) setSelected(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // 生成综述：首次命中后端缓存，refresh=true 强制重新生成
  async function generateSurvey(refresh = false) {
    setSurveyOpen(true);
    setSurveyLoading(true);
    setSurveyError("");
    setCopied(false);
    try {
      const suffix = refresh ? "?refresh=true" : "";
      const response = await fetch(
        `${apiBaseUrl}/api/papers/${paperId}/survey${suffix}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail ?? "综述生成失败");
      setSurvey(payload);
    } catch (err) {
      setSurveyError(err.message);
    } finally {
      setSurveyLoading(false);
    }
  }

  function surveyText(item) {
    const directions = (item.directions || [])
      .map(
        (direction, position) =>
          `${position + 1}. ${direction.title}\n` +
          `为什么值得做：${direction.why}\n` +
          `已有工作做到：${direction.prior_work}`,
      )
      .join("\n\n");
    return `【领域综述】\n${item.overview}\n\n【未来方向】\n${directions}`;
  }

  async function copySurvey() {
    if (!survey) return;
    try {
      await navigator.clipboard.writeText(surveyText(survey));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setSurveyError("复制失败，请手动选中文本复制");
    }
  }

  function closeSurvey() {
    setSurveyOpen(false);
    setCopied(false);
  }

  if (error || !data) {
    return (
      <main className="container">
        <section className="page-head">
          <p className="eyebrow">CITATION NETWORK</p>
          <h1>引用图谱</h1>
          <p className="intro">通过引用网络发现基石文献，并生成有依据的领域综述。</p>
        </section>
        <ErrorBanner
          message={error ? `引用图谱加载失败：${error}` : ""}
          onRetry={() => setRetryToken((value) => value + 1)}
          onClose={() => setError("")}
        />
        {!error ? (
          <section className="card"><LoadingBlock label="正在解析参考文献并构建引用网络…" lines={5} /></section>
        ) : null}
      </main>
    );
  }

  const edgeCount = (data.edges || []).length;
  const empty = chartData.refs.length === 0;

  return (
    <main className="graph-page">
      <section className="page-head graph-page-head">
        <div>
          <p className="eyebrow">CITATION NETWORK</p>
          <h1>引用图谱</h1>
          <p className="intro">{data.filename} · 可视化引用网络、挖掘基石文献并生成自动综述。</p>
        </div>
        <button
          className="primary"
          type="button"
          onClick={() => generateSurvey(false)}
          disabled={surveyLoading || empty}
        >
          {surveyLoading ? "生成中…" : "生成综述"}
        </button>
      </section>

      {/* 顶部统计条 */}
      <div className="graph-stats">
        <span>
          <strong>{chartData.refs.length}</strong> 篇文献
        </span>
        <span className="graph-stats-divider">|</span>
        <span>
          <strong>{edgeCount}</strong> 条引用关系
        </span>
        <span className="graph-stats-divider">|</span>
        <span>
          基石文献 <strong>{empty ? 0 : chartData.keyCount}</strong> 篇
        </span>
        <span className="graph-stats-hint">
          {empty ? "" : "拖拽节点、滚轮缩放，点击节点查看详情"}
        </span>
      </div>

      <div className="graph-canvas">
        {empty ? (
          <div className="graph-empty">
            <EmptyState
              title="该论文未解析到参考文献"
              description="如果 References 是图片或特殊排版，解析可能为空；可在阅读页结构化视图核对，或返回论文库选择其他论文。"
              actionLabel="返回论文库"
              actionHref="/papers"
            />
          </div>
        ) : (
          <>
            <div className="graph-chart" ref={containerRef} />
            {/* 右下角：缩放工具 + 图例，工具压在图例上方 */}
            <div className="graph-overlay-right">
              <div className="graph-zoom-tools">
                <button
                  type="button"
                  className="graph-zoom-btn"
                  aria-label="放大"
                  title="放大"
                  onClick={() => zoomStep(1.25)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="graph-zoom-btn"
                  aria-label="缩小"
                  title="缩小"
                  onClick={() => zoomStep(0.8)}
                >
                  −
                </button>
                <button
                  type="button"
                  className="graph-zoom-btn wide"
                  aria-label="复位视图"
                  title="复位视图"
                  onClick={resetView}
                >
                  复位
                </button>
              </div>
              <div className="graph-legend">
                <span className="legend-title">图例</span>
                <span className="legend-row">
                  <i className="legend-dot root" />
                  本论文
                </span>
                <span className="legend-row">
                  <i className="legend-dot high" />
                  基石文献（importance 前 15%）
                </span>
                <span className="legend-row">
                  <i className="legend-dot ref" />
                  普通引用
                </span>
                <span className="legend-note">圆越大 = 影响力（importance）越高</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 右侧抽屉：点击节点后滑出 */}
      <aside className={selected ? "graph-drawer open" : "graph-drawer"}>
        <div className="graph-drawer-head">
          <h2>文献详情</h2>
          <button
            type="button"
            className="modal-close"
            aria-label="关闭详情"
            onClick={() => setSelected(null)}
          >
            ✕
          </button>
        </div>
        {selected ? (
          <div className="node-detail">
            <p className="node-title">
              [{selected.index}] {selected.title || "标题未解析"}
            </p>
            <p className="node-line">
              <span>作者</span>
              {selected.authors || "未解析"}
            </p>
            <p className="node-line">
              <span>年份</span>
              {selected.year ?? "未知"}
            </p>
            <p className="node-line">
              <span>参考文献页</span>P.{selected.page}
            </p>
            <p className="node-line">
              <span>正文提及</span>
              {selected.mentions} 次
            </p>
            <p className="node-line">
              <span>importance</span>
              {selected.importance}
            </p>
            <p className="node-line">
              <span>PageRank</span>
              {selected.pagerank}
            </p>
            <p className="node-raw">{selected.text}</p>
          </div>
        ) : null}
      </aside>

      {surveyOpen ? (
        <div className="modal-backdrop" onClick={closeSurvey}>
          <div
            className="modal-card survey-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="survey-head">
              <h2>自动综述 · {data.filename}</h2>
              <div className="survey-head-right">
                <span className="survey-cache">
                  {survey?.cached ? "来自缓存（未重复调用模型）" : ""}
                </span>
                <button
                  type="button"
                  className="modal-close"
                  aria-label="关闭综述弹层"
                  onClick={closeSurvey}
                >
                  ✕
                </button>
              </div>
            </div>

            {surveyLoading ? <LoadingBlock label="正在依据论文与引用网络生成综述…" lines={4} /> : null}
            <ErrorBanner
              message={surveyError ? `综述生成失败：${surveyError}` : ""}
              onRetry={() => generateSurvey(false)}
              onClose={() => setSurveyError("")}
            />

            {survey && !surveyLoading ? (
              <>
                <section className="survey-section">
                  <h3>领域综述</h3>
                  <div className="survey-overview">{survey.overview}</div>
                </section>

                <section className="survey-section">
                  <h3>Future Work 三个方向</h3>
                  {(survey.directions || []).map((direction, position) => (
                    <article className="survey-direction" key={position}>
                      <h4>
                        {position + 1}. {direction.title}
                      </h4>
                      <p>
                        <span className="survey-label">为什么值得做</span>
                        {direction.why}
                      </p>
                      <p>
                        <span className="survey-label">已有工作做到</span>
                        {direction.prior_work}
                      </p>
                    </article>
                  ))}
                </section>

                <div className="modal-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => generateSurvey(true)}
                    disabled={surveyLoading}
                  >
                    重新生成
                  </button>
                  <button className="primary" type="button" onClick={copySurvey}>
                    {copied ? "已复制 ✓" : "一键复制"}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default function GraphPage() {
  return (
    <Suspense fallback={<main className="container"><LoadingBlock label="正在打开引用图谱…" /></main>}>
      <GraphInner />
    </Suspense>
  );
}

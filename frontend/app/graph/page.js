"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

// 节点半径：importance 越高越大，但限制在可读范围内
function nodeDiameter(importance, isRoot) {
  if (isRoot) return 92;
  const scaled = 30 + (importance / 100) * 58;
  return Math.round(scaled);
}

function buildLayout(data) {
  const nodes = data.nodes || [];
  const root =
    nodes.find((node) => node.kind === "root") ||
    nodes.find((node) => String(node.id).startsWith("paper-"));
  // 兜底：后端若没给 kind 字段，就按"除中心外的都是引用"处理，避免整页只剩一个节点
  const refs = nodes.filter((node) =>
    node.kind ? node.kind === "reference" : node !== root,
  );

  // 以本论文为中心，被引文献按重要性从 12 点方向顺时针辐射
  const radius = Math.max(330, refs.length * 16);
  const layoutNodes = [];

  if (root) {
    layoutNodes.push({
      id: root.id,
      position: { x: -46, y: -46 },
      data: { label: "本\n论\n文", meta: root },
      type: "default",
      style: {
        width: 92,
        height: 92,
        borderRadius: "50%",
        background: "#1d4ed8",
        color: "#fff",
        fontSize: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        border: "3px solid #93b4ff",
      },
    });
  }

  refs.forEach((node, position) => {
    const angle = (2 * Math.PI * position) / Math.max(refs.length, 1) - Math.PI / 2;
    const size = nodeDiameter(node.importance, false);
    layoutNodes.push({
      id: node.id,
      position: {
        x: Math.cos(angle) * radius - size / 2,
        y: Math.sin(angle) * radius - size / 2,
      },
      data: {
        label: `[${node.index}]`,
        meta: node,
      },
      style: {
        width: size,
        height: size,
        borderRadius: "50%",
        background:
          node.importance >= 80
            ? "#f59e0b"
            : node.importance >= 60
              ? "#38bdf8"
              : "#e2e8f0",
        color: node.importance >= 60 ? "#fff" : "#334155",
        fontSize: 11,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        border: "2px solid #fff",
        boxShadow: "0 2px 8px rgba(15,23,42,.18)",
      },
    });
  });

  const edges = (data.edges || []).map((edge) => ({
    id: `${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    animated: edge.weight > 1,
    style: { stroke: "#cbd5e1", strokeWidth: Math.min(3, 0.8 + edge.weight * 0.4) },
  }));

  return { nodes: layoutNodes, edges };
}

function GraphInner() {
  const searchParams = useSearchParams();
  const paperId = Number(searchParams.get("paper_id") || 24);

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
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
  }, [paperId]);

  const flow = useMemo(() => (data ? buildLayout(data) : { nodes: [], edges: [] }), [data]);

  // 兜底：后端没返回 top5 时，用节点的 importance 现场排序，保证列表不为空
  const top5 = useMemo(() => {
    if (!data) return [];
    if (data.top5?.length) return data.top5;
    return (data.nodes || [])
      .filter((node) => node.kind !== "root" && node.index)
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, 5)
      .map((node) => ({
        index: node.index,
        title: node.title,
        year: node.year,
        importance: node.importance,
        reason: `重要性 ${node.importance}`,
      }));
  }, [data]);

  if (error) {
    return (
      <main className="container">
        <p className="message error">{error}</p>
        <a className="secondary" href="/papers">
          ← 返回论文库
        </a>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="container">
        <p className="message">正在构建引用图谱…</p>
      </main>
    );
  }

  return (
    <main className="graph-page">
      <header className="read-head">
        <a className="secondary" href="/papers">
          ← 论文库
        </a>
        <span className="read-title">引用图谱 · {data.filename}</span>
        <span className="graph-stat">
          {data.node_count} 条被引文献 · 参考文献起始 P.{data.reference_page ?? "?"}
        </span>
      </header>

      <div className="graph-body">
        <div className="graph-canvas">
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            fitView
            minZoom={0.2}
            maxZoom={1.8}
            onNodeClick={(_, node) => setSelected(node.data.meta)}
            onNodeMouseEnter={(_, node) => setHovered(node.data.meta)}
            onNodeMouseLeave={() => setHovered(null)}
            nodesConnectable={false}
            edgesFocusable={false}
          >
            <Background gap={18} color="#e2e8f0" />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
          </ReactFlow>

          {hovered ? (
            <div className="graph-tooltip">
              <strong>
                [{hovered.index}] {hovered.title}
              </strong>
              <span>
                {hovered.year ? `${hovered.year} 年` : "年份未知"} · 重要性{" "}
                {hovered.importance}
              </span>
            </div>
          ) : null}
        </div>

        <aside className="graph-side">
          <section className="card compact-card">
            <h2>基石文献 Top5</h2>
            <ol className="corner-list">
              {top5.map((item) => (
                <li key={item.index}>
                  <div className="corner-head">
                    <span className="corner-rank">[{item.index}]</span>
                    <span className="corner-score">{item.importance}</span>
                  </div>
                  <p className="corner-title">{item.title || "（标题解析失败）"}</p>
                  <p className="corner-reason">
                    {item.year ? `${item.year} · ` : ""}
                    {item.reason}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <section className="card compact-card">
            <h2>节点信息</h2>
            {selected ? (
              <div className="node-detail">
                <p className="node-title">
                  [{selected.index}] {selected.title}
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
                  <span>页面</span>P.{selected.page}
                </p>
                <p className="node-line">
                  <span>正文提及</span>
                  {selected.mentions} 次
                </p>
                <p className="node-line">
                  <span>重要性</span>
                  {selected.importance}
                </p>
                <p className="node-raw">{selected.text}</p>
              </div>
            ) : (
              <p className="message">点击图中任一节点查看文献信息。</p>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}

export default function GraphPage() {
  return (
    <Suspense fallback={<main className="container">加载中…</main>}>
      <ReactFlowProvider>
        <GraphInner />
      </ReactFlowProvider>
    </Suspense>
  );
}

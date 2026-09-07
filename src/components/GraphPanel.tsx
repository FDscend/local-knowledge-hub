"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Core, ElementDefinition, NodeSingular } from "cytoscape";

type GraphNodeItem = {
  id: string;
  nodeType: "DOCUMENT" | "TAG";
  documentId: string | null;
  label: string;
};

type GraphEdgeItem = {
  id: string;
  edgeType: "MARKDOWN_LINK" | "HAS_TAG" | "SAME_SOURCE" | "SEMANTIC";
  sourceNodeId: string;
  targetNodeId: string;
  confidence: number;
  provenance: string;
  evidence: Record<string, unknown> | null;
};

type GraphStatus = {
  nodeCount: number;
  edgeCount: number;
  builtAt: string | null;
  semanticSkipped: boolean | null;
};

type GraphData = {
  nodes: GraphNodeItem[];
  edges: GraphEdgeItem[];
  status: GraphStatus;
};

const EDGE_TYPE_LABELS: Record<GraphEdgeItem["edgeType"], string> = {
  MARKDOWN_LINK: "Markdown 链接（显式）",
  HAS_TAG: "共享标签（规则）",
  SAME_SOURCE: "同一来源（规则）",
  SEMANTIC: "语义近邻（建议）",
};

const EDGE_TYPE_COLORS: Record<GraphEdgeItem["edgeType"], string> = {
  MARKDOWN_LINK: "#0a7d52",
  HAS_TAG: "#c08a2d",
  SAME_SOURCE: "#8a8275",
  SEMANTIC: "#2f6fa8",
};

function formatTime(value: string | null): string {
  if (!value) {
    return "尚未构建";
  }
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function GraphPanel({
  knowledgeBaseId,
  initialStatus,
}: {
  knowledgeBaseId: string;
  initialStatus: GraphStatus;
}) {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabledEdgeTypes, setEnabledEdgeTypes] = useState<Set<GraphEdgeItem["edgeType"]>>(
    new Set(["MARKDOWN_LINK", "HAS_TAG", "SAME_SOURCE", "SEMANTIC"]),
  );
  const [tagFilter, setTagFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [status, setStatus] = useState<GraphStatus>(initialStatus);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  // 保持最新数据引用：Cytoscape 异步初始化完成后立即应用当前图谱数据，避免竞态。
  const dataRef = useRef<GraphData | null>(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // 纯数据获取（无 setState，供 effect 与事件处理器复用）。
  const fetchGraphData = useCallback(async (params: URLSearchParams): Promise<GraphData> => {
    const result = await fetch(`/api/graph?${params.toString()}`);
    if (!result.ok) {
      const payload = (await result.json()) as { error?: string };
      throw new Error(payload.error ?? "图谱读取失败。");
    }
    return (await result.json()) as GraphData;
  }, []);

  const loadGraph = useCallback(async () => {
    setError(null);
    try {
      const edgeTypes = Array.from(enabledEdgeTypes).join(",");
      const params = new URLSearchParams({ knowledgeBaseId });
      if (edgeTypes) {
        params.set("edgeTypes", edgeTypes);
      }
      if (tagFilter) {
        params.set("tag", tagFilter);
      }
      const payload = await fetchGraphData(params);
      setData(payload);
      setStatus(payload.status);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "图谱读取失败。");
    }
  }, [knowledgeBaseId, enabledEdgeTypes, tagFilter, fetchGraphData]);

  // 初始加载与筛选变化：所有 setState 都发生在 promise 回调中，避免 effect 同步写状态。
  useEffect(() => {
    let cancelled = false;
    const edgeTypes = Array.from(enabledEdgeTypes).join(",");
    const params = new URLSearchParams({ knowledgeBaseId });
    if (edgeTypes) {
      params.set("edgeTypes", edgeTypes);
    }
    if (tagFilter) {
      params.set("tag", tagFilter);
    }
    void fetchGraphData(params)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setData(payload);
        setStatus(payload.status);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "图谱读取失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [knowledgeBaseId, enabledEdgeTypes, tagFilter, fetchGraphData]);

  // 将图谱数据应用到 Cytoscape 实例（删除旧元素后重建并布局）。
  const applyElements = useCallback((cy: Core, graphData: GraphData | null) => {
    if (!graphData) {
      return;
    }
    const elements: ElementDefinition[] = [
      ...graphData.nodes.map((node) => ({
        data: { id: node.id, label: node.label, nodeType: node.nodeType, documentId: node.documentId },
      })),
      ...graphData.edges.map((edge) => ({
        data: {
          id: edge.id,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          edgeType: edge.edgeType,
          label: EDGE_TYPE_LABELS[edge.edgeType].split("（")[0],
        },
      })),
    ];
    cy.elements().remove();
    cy.add(elements);
    cy.layout({ name: "cose", animate: false, nodeRepulsion: 4200, idealEdgeLength: 110, padding: 30 }).run();
    cy.fit(undefined, 40);
  }, []);

  // 初始化 Cytoscape 实例（只创建一次；容器在数据加载完成后才渲染，因此依赖 hasData）。
  const hasData = data !== null;
  useEffect(() => {
    if (!containerRef.current || cyRef.current) {
      return;
    }
    let disposed = false;
    void import("cytoscape").then((module) => {
      if (disposed || !containerRef.current || cyRef.current) {
        return;
      }
      const cytoscape = module.default;
      const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": "11px",
            "text-wrap": "wrap",
            "text-max-width": "140px",
            "text-valign": "bottom",
            "text-margin-y": 4,
            "background-color": "#0a7d52",
            "border-width": 1,
            "border-color": "rgba(10, 125, 82, 0.5)",
            width: 42,
            height: 42,
            color: "#3d3526",
          },
        },
        {
          selector: 'node[nodeType = "TAG"]',
          style: {
            "background-color": "#d4a14d",
            "border-color": "rgba(140, 106, 31, 0.5)",
            shape: "ellipse",
            width: 34,
            height: 34,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.6,
            "line-color": "#8a8275",
            "target-arrow-color": "#8a8275",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.8,
            "curve-style": "bezier",
            opacity: 0.75,
            label: "data(label)",
            "font-size": "9px",
            "text-rotation": "autorotate",
            "text-background-color": "rgba(255, 253, 249, 0.85)",
            "text-background-opacity": 1,
            "text-background-padding": "2px",
          },
        },
        {
          selector: 'edge[edgeType = "MARKDOWN_LINK"]',
          style: { "line-color": "#0a7d52", "target-arrow-color": "#0a7d52" },
        },
        {
          selector: 'edge[edgeType = "HAS_TAG"]',
          style: { "line-color": "#c08a2d", "target-arrow-color": "#c08a2d", "line-style": "dashed" },
        },
        {
          selector: 'edge[edgeType = "SAME_SOURCE"]',
          style: { "line-color": "#8a8275", "target-arrow-color": "#8a8275", "line-style": "dotted" },
        },
        {
          selector: 'edge[edgeType = "SEMANTIC"]',
          style: { "line-color": "#2f6fa8", "target-arrow-color": "#2f6fa8", "line-style": "dashed" },
        },
        {
          selector: "node:selected, edge:selected",
          style: { "border-width": 2.5, "border-color": "#2f6fa8" },
        },
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: 4200, idealEdgeLength: 110, padding: 30 },
    });
    cy.on("tap", "node", (event) => {
      setSelectedNodeId((event.target as NodeSingular).id());
    });
    cy.on("tap", (event) => {
      if (event.target === cy) {
        setSelectedNodeId(null);
      }
    });
    cyRef.current = cy;
    // 初始化完成后立即应用已加载的图谱数据，避免 data effect 先于 cy 创建而丢元素。
    applyElements(cy, dataRef.current);
    // 开发调试钩子：控制台可用 window.__graphCy 检查实例。
    if (typeof window !== "undefined") {
      (window as unknown as { __graphCy?: Core }).__graphCy = cy;
    }
    return () => {
      disposed = true;
      cy.destroy();
      cyRef.current = null;
    };
    });
  }, [hasData, applyElements]);

  // 数据变化时更新 Cytoscape 元素。
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    applyElements(cy, data);
  }, [data, applyElements]);

  // 搜索定位：输入时高亮匹配节点并 fit。
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !data) {
      return;
    }
    const query = searchText.trim().toLowerCase();
    if (!query) {
      cy.elements().style("opacity", 1);
      return;
    }
    const matched = data.nodes.filter((node) => node.label.toLowerCase().includes(query)).map((node) => node.id);
    cy.nodes().forEach((node) => {
      node.style("opacity", matched.includes(node.id()) ? 1 : 0.15);
    });
    if (matched.length > 0) {
      const first = cy.getElementById(matched[0] ?? "");
      cy.animate({ fit: { eles: first.closedNeighborhood(), padding: 80 }, duration: 300 });
    }
  }, [searchText, data]);

  const tagOptions = useMemo(() => {
    const tags = new Set<string>();
    for (const node of data?.nodes ?? []) {
      if (node.nodeType === "TAG") {
        tags.add(node.label);
      }
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [data]);

  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((node) => [node.id, node])), [data]);

  const selectedNode = selectedNodeId ? (nodeById.get(selectedNodeId) ?? null) : null;
  const selectedEdges = useMemo(() => {
    if (!selectedNode || !data) {
      return [];
    }
    return data.edges
      .filter((edge) => edge.sourceNodeId === selectedNode.id || edge.targetNodeId === selectedNode.id)
      .map((edge) => {
        const otherId = edge.sourceNodeId === selectedNode.id ? edge.targetNodeId : edge.sourceNodeId;
        return { edge, other: nodeById.get(otherId) ?? null };
      });
  }, [selectedNode, data, nodeById]);

  const handleRebuild = useCallback(async () => {
    const confirmed = window.confirm(
      "确认重建当前知识库的知识图谱？\n\n将重新扫描文档内链接、标签、来源关系，并基于切片向量重算语义近邻边（需要已构建向量索引）。",
    );
    if (!confirmed) {
      return;
    }
    setRebuilding(true);
    setError(null);
    try {
      const result = await fetch("/api/graph/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId }),
      });
      if (!result.ok) {
        const payload = (await result.json()) as { error?: string };
        throw new Error(payload.error ?? "重建排队失败。");
      }
      // 轮询状态直到任务完成。
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const statusResult = await fetch(`/api/graph?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}&maxNodes=1`);
        if (statusResult.ok) {
          const payload = (await statusResult.json()) as GraphData;
          setStatus(payload.status);
          if (payload.status.builtAt) {
            break;
          }
        }
      }
      await loadGraph();
    } catch (rebuildError) {
      setError(rebuildError instanceof Error ? rebuildError.message : "图谱重建失败。");
    } finally {
      setRebuilding(false);
    }
  }, [knowledgeBaseId, loadGraph]);

  return (
    <section className="graph-layout">
      <aside className="graph-sidebar">
        <div className="graph-sidebar-group">
          <span className="graph-sidebar-label">重建图谱</span>
          <button type="button" className="button secondary" disabled={rebuilding} onClick={() => void handleRebuild()}>
            {rebuilding ? "重建中…" : "重新构建"}
          </button>
          <p className="graph-status-text">
            {status.nodeCount > 0
              ? `${status.nodeCount} 节点 · ${status.edgeCount} 边 · 构建于 ${formatTime(status.builtAt)}`
              : "图谱尚未构建"}
            {status.semanticSkipped ? "（未配置向量索引，无语义近邻边）" : ""}
          </p>
        </div>

        <div className="graph-sidebar-group">
          <span className="graph-sidebar-label">边类型</span>
          {(Object.keys(EDGE_TYPE_LABELS) as Array<GraphEdgeItem["edgeType"]>).map((edgeType) => (
            <label key={edgeType} className="graph-filter-item">
              <input
                type="checkbox"
                checked={enabledEdgeTypes.has(edgeType)}
                onChange={(event) => {
                  const next = new Set(enabledEdgeTypes);
                  if (event.target.checked) {
                    next.add(edgeType);
                  } else {
                    next.delete(edgeType);
                  }
                  setEnabledEdgeTypes(next);
                }}
              />
              <span className="graph-filter-swatch" style={{ background: EDGE_TYPE_COLORS[edgeType] }} />
              {EDGE_TYPE_LABELS[edgeType]}
            </label>
          ))}
        </div>

        <div className="graph-sidebar-group">
          <span className="graph-sidebar-label">按标签筛选</span>
          <select className="input" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
            <option value="">全部标签</option>
            {tagOptions.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </div>

        <div className="graph-sidebar-group">
          <span className="graph-sidebar-label">搜索节点</span>
          <input
            className="input"
            type="search"
            placeholder="输入文档或标签名称…"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
      </aside>

      <div className="graph-canvas-column">
        {data === null ? (
          error ? (
            <div className="graph-placeholder graph-error">{error}</div>
          ) : (
            <div className="graph-placeholder">正在读取图谱…</div>
          )
        ) : data.nodes.length === 0 ? (
          error ? (
            <div className="graph-placeholder graph-error">{error}</div>
          ) : (
            <div className="graph-placeholder">
              <p>当前知识库还没有图谱。点击左侧「重新构建」生成节点与关系（Markdown 链接 / 标签 / 来源 / 语义近邻）。</p>
              <button type="button" className="button primary" disabled={rebuilding} onClick={() => void handleRebuild()}>
                {rebuilding ? "重建中…" : "重新构建"}
              </button>
            </div>
          )
        ) : (
          // 数据就绪后画布保持挂载：重建 / 筛选期间的 loading 不再卸载 Cytoscape 容器。
          <div className="graph-canvas" ref={containerRef} />
        )}

        {selectedNode ? (
          <aside className="graph-detail-panel">
            <header className="graph-detail-header">
              <span className={`graph-node-badge ${selectedNode.nodeType.toLowerCase()}`}>
                {selectedNode.nodeType === "DOCUMENT" ? "文档" : "标签"}
              </span>
              <h3>{selectedNode.label}</h3>
              {selectedNode.documentId ? (
                <a
                  className="graph-detail-link"
                  href={`/knowledge/${selectedNode.documentId}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`}
                >
                  查看原文
                </a>
              ) : null}
            </header>
            {selectedEdges.length === 0 ? (
              <p className="muted-text">该节点没有关联边。</p>
            ) : (
              <ul className="graph-edge-list">
                {selectedEdges.map(({ edge, other }) => (
                  <li key={edge.id}>
                    <div className="graph-edge-title">
                      <span className="graph-filter-swatch" style={{ background: EDGE_TYPE_COLORS[edge.edgeType] }} />
                      <strong>{EDGE_TYPE_LABELS[edge.edgeType]}</strong>
                      <span className="graph-edge-confidence">{Math.round(edge.confidence * 100)}%</span>
                    </div>
                    <p className="graph-edge-other">{other ? other.label : "未知节点"}</p>
                    <p className="graph-edge-provenance">{edge.provenance}</p>
                    {edge.evidence ? (
                      <p className="graph-edge-evidence">
                        {Object.entries(edge.evidence)
                          .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
                          .join(" · ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </aside>
        ) : (
          <aside className="graph-detail-panel graph-detail-empty">
            <p>点击图中的节点查看关联关系与证据来源。</p>
          </aside>
        )}
      </div>
    </section>
  );
}

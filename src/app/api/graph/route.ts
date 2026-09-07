import { NextResponse } from "next/server";

import { getGraphStatus, getKnowledgeGraph, type GraphEdgeType } from "@/lib/graph";

const EDGE_TYPES: GraphEdgeType[] = ["MARKDOWN_LINK", "HAS_TAG", "SAME_SOURCE", "SEMANTIC"];

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const knowledgeBaseId = params.get("knowledgeBaseId")?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    const edgeTypes = (params.get("edgeTypes")?.split(",") ?? [])
      .filter((type): type is GraphEdgeType => EDGE_TYPES.includes(type as GraphEdgeType));
    const maxNodesParam = Number.parseInt(params.get("maxNodes") ?? "", 10);
    const graph = await getKnowledgeGraph(knowledgeBaseId, {
      edgeTypes: edgeTypes.length > 0 ? edgeTypes : undefined,
      tagFilter: params.get("tag")?.trim() || undefined,
      maxNodes: Number.isFinite(maxNodesParam) && maxNodesParam > 0 ? maxNodesParam : undefined,
    });
    const status = await getGraphStatus(knowledgeBaseId);
    return NextResponse.json({ ...graph, status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "图谱读取失败。" },
      { status: 500 },
    );
  }
}

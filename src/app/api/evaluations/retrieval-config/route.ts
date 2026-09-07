import { NextResponse } from "next/server";

import { getProductionRetrievalConfig, listRetrievalConfigChanges } from "@/lib/retrieval-config";

export async function GET(request: Request) {
  try {
    const knowledgeBaseId = new URL(request.url).searchParams.get("knowledgeBaseId")?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库标识。" }, { status: 400 });
    }
    const [production, changes] = await Promise.all([
      getProductionRetrievalConfig(knowledgeBaseId),
      listRetrievalConfigChanges(knowledgeBaseId),
    ]);
    return NextResponse.json({
      production,
      changes: changes.map((change) => ({
        ...change,
        createdAt: change.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "检索配置读取失败。" }, { status: 400 });
  }
}

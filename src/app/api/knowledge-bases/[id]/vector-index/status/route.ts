import { NextResponse } from "next/server";

import { getEmbeddingIndexStatus } from "@/lib/embedding";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const knowledgeBase = await requireKnowledgeBase(id);
    return NextResponse.json(getEmbeddingIndexStatus(knowledgeBase.id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取向量索引状态。" }, { status: 400 });
  }
}
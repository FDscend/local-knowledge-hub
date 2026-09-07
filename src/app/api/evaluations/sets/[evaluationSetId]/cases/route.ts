import { NextResponse } from "next/server";

import { listEvaluationCases } from "@/lib/evaluation";

export async function GET(request: Request, context: { params: Promise<{ evaluationSetId: string }> }) {
  try {
    const { evaluationSetId } = await context.params;
    const knowledgeBaseId = new URL(request.url).searchParams.get("knowledgeBaseId")?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库标识。" }, { status: 400 });
    }
    const cases = await listEvaluationCases(knowledgeBaseId, evaluationSetId);
    return NextResponse.json({
      cases: cases.map((evaluationCase) => ({ ...evaluationCase, updatedAt: evaluationCase.updatedAt.toISOString() })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "候选题列表读取失败。" }, { status: 400 });
  }
}

import { NextResponse } from "next/server";

import { compareEvaluationRuns } from "@/lib/evaluation";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    const url = new URL(request.url);
    const knowledgeBaseId = url.searchParams.get("knowledgeBaseId")?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库标识。" }, { status: 400 });
    }
    const baseRunId = url.searchParams.get("baseRunId")?.trim() || null;
    const comparison = await compareEvaluationRuns(knowledgeBaseId, runId, baseRunId);
    return NextResponse.json({
      ...comparison,
      base: comparison.base ? { ...comparison.base, startedAt: comparison.base.startedAt.toISOString(), finishedAt: comparison.base.finishedAt?.toISOString() ?? null } : null,
      target: { ...comparison.target, startedAt: comparison.target.startedAt.toISOString(), finishedAt: comparison.target.finishedAt?.toISOString() ?? null },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "评测运行对比失败。" }, { status: 400 });
  }
}

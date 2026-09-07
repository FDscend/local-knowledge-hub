import { NextResponse } from "next/server";

import { deserializeEvaluationResult, getEvaluationRun } from "@/lib/evaluation";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    const knowledgeBaseId = new URL(request.url).searchParams.get("knowledgeBaseId")?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库标识。" }, { status: 400 });
    }

    const run = await getEvaluationRun(knowledgeBaseId, runId);
    if (!run) {
      return NextResponse.json({ error: "评测运行记录不存在。" }, { status: 404 });
    }

    return NextResponse.json({
      ...run,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      results: run.results.map((result) => ({
        ...result,
        createdAt: result.createdAt.toISOString(),
        answerScore: result.answerScoreJson ? (JSON.parse(result.answerScoreJson) as Record<string, number>) : null,
        parsed: deserializeEvaluationResult(result),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "评测详情读取失败。" }, { status: 400 });
  }
}

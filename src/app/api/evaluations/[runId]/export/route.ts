import { NextResponse } from "next/server";

import { evaluationReportToCsv, exportEvaluationRun } from "@/lib/evaluation";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    const url = new URL(request.url);
    const knowledgeBaseId = url.searchParams.get("knowledgeBaseId")?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库标识。" }, { status: 400 });
    }
    const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
    const payload = await exportEvaluationRun(knowledgeBaseId, runId);

    if (format === "csv") {
      const csv = evaluationReportToCsv(payload);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="evaluation-${runId}.csv"`,
        },
      });
    }

    return NextResponse.json(
      { ...payload, run: { ...payload.run, startedAt: payload.run.startedAt.toISOString(), finishedAt: payload.run.finishedAt?.toISOString() ?? null } },
      { headers: { "Content-Disposition": `attachment; filename="evaluation-${runId}.json"` } },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "报告导出失败。" }, { status: 400 });
  }
}

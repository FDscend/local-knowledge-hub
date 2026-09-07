import { NextResponse } from "next/server";
import { z } from "zod";

import { scoreEvaluationRunAnswers } from "@/lib/evaluation-llm";
import { readRuntimeLlmOverridesFromRequest } from "@/lib/runtime-keys";

const scoreSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
});

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    const input = scoreSchema.parse(await request.json());
    const llm = readRuntimeLlmOverridesFromRequest(request);
    const summary = await scoreEvaluationRunAnswers(input.knowledgeBaseId, runId, llm);
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "答案要点评分失败。" }, { status: 400 });
  }
}

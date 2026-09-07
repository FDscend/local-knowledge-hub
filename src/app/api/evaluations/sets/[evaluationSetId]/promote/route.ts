import { NextResponse } from "next/server";
import { z } from "zod";

import { promoteEvaluationSetToReviewedRegression } from "@/lib/evaluation";

const promoteSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
});

export async function POST(request: Request, context: { params: Promise<{ evaluationSetId: string }> }) {
  try {
    const { evaluationSetId } = await context.params;
    const input = promoteSchema.parse(await request.json());
    const updated = await promoteEvaluationSetToReviewedRegression(input.knowledgeBaseId, evaluationSetId);
    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "评测集升级失败。" }, { status: 400 });
  }
}

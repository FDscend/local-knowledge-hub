import { NextResponse } from "next/server";
import { z } from "zod";

import { updateEvaluationCase } from "@/lib/evaluation";

const caseUpdateSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  evaluationSetId: z.string().trim().min(1),
  question: z.string().trim().min(1).optional(),
  expectedTitles: z.array(z.string()).optional(),
  expectedDocumentIds: z.array(z.string()).optional(),
  expectedChunkIds: z.array(z.string()).optional(),
  referenceAnswer: z.string().nullable().optional(),
  answerPoints: z.array(z.string()).optional(),
  reviewed: z.boolean().optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    const input = caseUpdateSchema.parse(await request.json());
    const updated = await updateEvaluationCase(input.knowledgeBaseId, input.evaluationSetId, caseId, {
      question: input.question,
      expectedTitles: input.expectedTitles,
      expectedDocumentIds: input.expectedDocumentIds,
      expectedChunkIds: input.expectedChunkIds,
      referenceAnswer: input.referenceAnswer,
      answerPoints: input.answerPoints,
      reviewed: input.reviewed,
    });
    return NextResponse.json({ ...updated, updatedAt: updated.updatedAt.toISOString() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "候选题更新失败。" }, { status: 400 });
  }
}

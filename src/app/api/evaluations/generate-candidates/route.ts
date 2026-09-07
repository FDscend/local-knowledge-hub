import { NextResponse } from "next/server";
import { z } from "zod";

import { generateCandidateCases } from "@/lib/evaluation-llm";
import { readRuntimeLlmOverridesFromRequest } from "@/lib/runtime-keys";

const generateSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  targetSetId: z.string().trim().min(1).optional(),
  maxCases: z.number().int().min(1).max(30).optional(),
  maxDocuments: z.number().int().min(1).max(20).optional(),
  replaceExisting: z.boolean().optional(),
});

export async function POST(request: Request) {
  try {
    const input = generateSchema.parse(await request.json());
    const llm = readRuntimeLlmOverridesFromRequest(request);
    const summary = await generateCandidateCases(input.knowledgeBaseId, {
      ...llm,
      targetSetId: input.targetSetId,
      maxCases: input.maxCases,
      maxDocuments: input.maxDocuments,
      replaceExisting: input.replaceExisting,
    });
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "候选题生成失败。" }, { status: 400 });
  }
}

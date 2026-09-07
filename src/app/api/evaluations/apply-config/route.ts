import { NextResponse } from "next/server";
import { z } from "zod";

import { applyRetrievalConfigAndTriggerEvaluation } from "@/lib/retrieval-config";

const applyConfigSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  reason: z.string().trim().max(200).optional(),
});

export async function POST(request: Request) {
  try {
    const input = applyConfigSchema.parse(await request.json());
    const result = await applyRetrievalConfigAndTriggerEvaluation(input.knowledgeBaseId, input.runId, input.reason);
    return NextResponse.json({
      config: result.config,
      change: {
        ...result.change,
        createdAt: result.change.createdAt.toISOString(),
      },
      queued: result.queued,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "应用检索配置失败。" }, { status: 400 });
  }
}

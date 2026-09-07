import { NextResponse } from "next/server";
import { z } from "zod";

import { rollbackRetrievalConfig } from "@/lib/retrieval-config";

const rollbackConfigSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  changeId: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    const input = rollbackConfigSchema.parse(await request.json());
    const result = await rollbackRetrievalConfig(input.knowledgeBaseId, input.changeId);
    return NextResponse.json({
      config: result.config,
      change: {
        ...result.change,
        createdAt: result.change.createdAt.toISOString(),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "回滚检索配置失败。" }, { status: 400 });
  }
}

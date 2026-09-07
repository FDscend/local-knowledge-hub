import { NextResponse } from "next/server";

import { askInConversation } from "@/lib/conversations";
import { readRuntimeEmbeddingOverridesFromRequest, readRuntimeLlmOverridesFromRequest } from "@/lib/runtime-keys";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { question?: string; knowledgeBaseId?: string };
    const knowledgeBaseId = body.knowledgeBaseId?.trim();
    const question = body.question?.trim();

    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    if (!question) {
      return NextResponse.json({ error: "问题不能为空。" }, { status: 400 });
    }

    const result = await askInConversation(id, question, knowledgeBaseId, {
      ...readRuntimeLlmOverridesFromRequest(request),
      ...readRuntimeEmbeddingOverridesFromRequest(request),
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "问答执行失败。" },
      { status: 500 },
    );
  }
}

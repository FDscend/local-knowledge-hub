import { NextResponse } from "next/server";

import { summarizeConversationToDraft } from "@/lib/controlled-writes";
import { readRuntimeLlmOverridesFromRequest } from "@/lib/runtime-keys";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { knowledgeBaseId?: string };
    const knowledgeBaseId = body.knowledgeBaseId?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    const draft = await summarizeConversationToDraft(id, knowledgeBaseId, {
      ...readRuntimeLlmOverridesFromRequest(request),
    });
    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "会话总结失败。" },
      { status: 500 },
    );
  }
}

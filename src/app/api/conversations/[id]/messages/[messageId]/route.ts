import { NextResponse } from "next/server";

import { updateMessageTitle } from "@/lib/conversations";

type RouteContext = { params: Promise<{ id: string; messageId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { messageId } = await context.params;
    const body = (await request.json()) as { knowledgeBaseId?: string; title?: string };
    const knowledgeBaseId = body.knowledgeBaseId?.trim();
    const title = body.title?.trim();

    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    if (!title) {
      return NextResponse.json({ error: "要点标题不能为空。" }, { status: 400 });
    }

    const message = await updateMessageTitle(messageId, title, knowledgeBaseId);
    return NextResponse.json({ message });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "要点标题更新失败。" },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";

import { rejectDraft } from "@/lib/controlled-writes";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { knowledgeBaseId?: string; reason?: string };
    const knowledgeBaseId = body.knowledgeBaseId?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    const draft = await rejectDraft(id, knowledgeBaseId, body.reason);
    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "草稿拒绝失败。" },
      { status: 500 },
    );
  }
}

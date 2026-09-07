import { NextResponse } from "next/server";

import { deleteDraft, getDraft } from "@/lib/controlled-writes";

function readKnowledgeBaseId(request: Request): string | null {
  return new URL(request.url).searchParams.get("knowledgeBaseId")?.trim() || null;
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const knowledgeBaseId = readKnowledgeBaseId(request);
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    const draft = await getDraft(id, knowledgeBaseId);
    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "草稿读取失败。" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const knowledgeBaseId = readKnowledgeBaseId(request);
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    await deleteDraft(id, knowledgeBaseId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "草稿删除失败。" },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";

import { deleteConversation, getConversationDetail, renameConversation, setConversationArchived } from "@/lib/conversations";

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
    const conversation = await getConversationDetail(id, knowledgeBaseId);
    return NextResponse.json({ conversation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "会话读取失败。" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { knowledgeBaseId?: string; title?: string; archived?: boolean };
    const knowledgeBaseId = body.knowledgeBaseId?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    if (typeof body.title === "string") {
      const conversation = await renameConversation(id, body.title, knowledgeBaseId);
      return NextResponse.json({ conversation });
    }
    if (typeof body.archived === "boolean") {
      const conversation = await setConversationArchived(id, body.archived, knowledgeBaseId);
      return NextResponse.json({ conversation });
    }
    return NextResponse.json({ error: "没有可更新的字段。" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "会话更新失败。" },
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
    await deleteConversation(id, knowledgeBaseId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "会话删除失败。" },
      { status: 500 },
    );
  }
}

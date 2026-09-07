import { NextResponse } from "next/server";

import { createConversation, listConversations } from "@/lib/conversations";

export async function GET(request: Request) {
  try {
    const knowledgeBaseId = new URL(request.url).searchParams.get("knowledgeBaseId")?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    const conversations = await listConversations(knowledgeBaseId);
    return NextResponse.json({ conversations });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "会话列表读取失败。" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { knowledgeBaseId?: string; title?: string | null };
    const knowledgeBaseId = body.knowledgeBaseId?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    const conversation = await createConversation(knowledgeBaseId, body.title);
    return NextResponse.json({ conversation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "会话创建失败。" },
      { status: 500 },
    );
  }
}

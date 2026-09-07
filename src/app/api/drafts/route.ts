import { NextResponse } from "next/server";

import { listDrafts } from "@/lib/controlled-writes";

export async function GET(request: Request) {
  try {
    const knowledgeBaseId = new URL(request.url).searchParams.get("knowledgeBaseId")?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    const drafts = await listDrafts(knowledgeBaseId);
    return NextResponse.json({ drafts });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "草稿列表读取失败。" },
      { status: 500 },
    );
  }
}

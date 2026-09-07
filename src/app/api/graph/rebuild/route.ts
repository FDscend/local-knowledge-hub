import { NextResponse } from "next/server";

import { TASK_KIND, enqueueTask } from "@/lib/tasks";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { knowledgeBaseId?: string };
    const knowledgeBaseId = body.knowledgeBaseId?.trim();
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: "缺少知识库 ID。" }, { status: 400 });
    }
    // 手动重建：不标记自动触发、不做防抖去重。
    const { id, deduplicated } = await enqueueTask(knowledgeBaseId, TASK_KIND.GRAPH_BUILD, { reason: "手动重建" });
    return NextResponse.json({ taskId: id, deduplicated, queued: !deduplicated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "图谱重建排队失败。" },
      { status: 500 },
    );
  }
}

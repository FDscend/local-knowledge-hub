import { NextResponse } from "next/server";

import { readRuntimeEmbeddingOverridesFromRequest } from "@/lib/runtime-keys";
import { TASK_KIND, enqueueTask } from "@/lib/tasks";
import { storeTaskRuntimeOverrides } from "@/lib/task-executor";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const overrides = readRuntimeEmbeddingOverridesFromRequest(request);
    // 重建改为后台任务执行；浏览器传入的 Key 仅驻留进程内存，不写入任务表。
    const queued = await enqueueTask(id, TASK_KIND.VECTOR_INDEX, {
      ...(overrides.embeddingModel?.trim() ? { model: overrides.embeddingModel.trim() } : {}),
    });
    storeTaskRuntimeOverrides(queued.id, {
      embedding: {
        apiKey: overrides.embeddingApiKey,
        baseURL: overrides.embeddingBaseURL,
        model: overrides.embeddingModel,
      },
    });
    return NextResponse.json({ queued: true, taskId: queued.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "向量索引重建任务排队失败。" }, { status: 400 });
  }
}

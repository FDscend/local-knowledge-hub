import { prisma } from "@/lib/prisma";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

export const TASK_KIND = {
  EVALUATION: "EVALUATION",
  CANDIDATE_GENERATION: "CANDIDATE_GENERATION",
  VECTOR_INDEX: "VECTOR_INDEX",
  AUTO_EVALUATION: "AUTO_EVALUATION",
  INGEST: "INGEST",
  GRAPH_BUILD: "GRAPH_BUILD",
} as const;

export type TaskKind = (typeof TASK_KIND)[keyof typeof TASK_KIND];

export const TASK_STATUS = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** 将任务加入队列；同一知识库的同类自动评测在防抖窗口内不会重复排队。 */
export async function enqueueTask(
  knowledgeBaseId: string,
  kind: TaskKind,
  payload: Record<string, unknown> = {},
  options: { autoTriggered?: boolean; maxAttempts?: number; debounceSeconds?: number } = {},
): Promise<{ id: string; deduplicated: boolean }> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  if (options.autoTriggered && options.debounceSeconds && options.debounceSeconds > 0) {
    const since = new Date(Date.now() - options.debounceSeconds * 1000);
    const existing = await prisma.task.findFirst({
      where: {
        knowledgeBaseId: knowledgeBase.id,
        kind,
        autoTriggered: true,
        status: { in: ["QUEUED", "RUNNING"] },
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (existing) {
      return { id: existing.id, deduplicated: true };
    }
  }

  const task = await prisma.task.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      kind,
      autoTriggered: Boolean(options.autoTriggered),
      maxAttempts: options.maxAttempts ?? 2,
      payloadJson: json(payload),
    },
  });
  return { id: task.id, deduplicated: false };
}

/** 为已同步完成的操作写入任务历史记录（导入等入口仍保持同步执行）。 */
export async function recordCompletedTask(
  knowledgeBaseId: string,
  kind: TaskKind,
  result: Record<string, unknown>,
  options: { autoTriggered?: boolean } = {},
): Promise<void> {
  await prisma.task.create({
    data: {
      knowledgeBaseId,
      kind,
      status: "SUCCEEDED",
      autoTriggered: Boolean(options.autoTriggered),
      resultJson: json(result),
      progressTotal: 1,
      progressCurrent: 1,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
}

/** 导入 / 配置变更完成后自动排队冒烟评测：5 分钟内同库同类自动任务去重。 */
export async function enqueueAutoEvaluation(knowledgeBaseId: string, reason: string): Promise<{ id: string; deduplicated: boolean }> {
  return enqueueTask(
    knowledgeBaseId,
    TASK_KIND.AUTO_EVALUATION,
    { reason },
    { autoTriggered: true, debounceSeconds: 5 * 60 },
  );
}

/** 文档或向量索引变更后自动排队图谱重建：5 分钟内同库去重。 */
export async function enqueueGraphBuild(knowledgeBaseId: string, reason: string): Promise<{ id: string; deduplicated: boolean }> {
  return enqueueTask(
    knowledgeBaseId,
    TASK_KIND.GRAPH_BUILD,
    { reason },
    { autoTriggered: true, debounceSeconds: 5 * 60 },
  );
}

export async function cancelQueuedTask(knowledgeBaseId: string, taskId: string): Promise<boolean> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const updated = await prisma.task.updateMany({
    where: { id: taskId, knowledgeBaseId: knowledgeBase.id, status: "QUEUED" },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  return updated.count > 0;
}

export async function retryTask(knowledgeBaseId: string, taskId: string): Promise<boolean> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const task = await prisma.task.findFirst({
    where: { id: taskId, knowledgeBaseId: knowledgeBase.id },
    select: { id: true, status: true, maxAttempts: true },
  });
  if (!task || task.status !== "FAILED") {
    return false;
  }
  await prisma.task.update({
    where: { id: task.id },
    data: {
      status: "QUEUED",
      attempts: 0,
      errorText: null,
      resultJson: null,
      progressCurrent: 0,
      progressTotal: 0,
      startedAt: null,
      finishedAt: null,
    },
  });
  return true;
}

/** 删除任务记录（多选）：按知识库归属校验，写 task-deleted 审计；部分不存在时返回已删 / 缺失数量。 */
export async function deleteTasks(knowledgeBaseId: string, taskIds: string[]): Promise<{ deleted: number; missing: number }> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const uniqueIds = Array.from(new Set(taskIds));
  const existing = await prisma.task.findMany({
    where: { id: { in: uniqueIds }, knowledgeBaseId: knowledgeBase.id },
    select: { id: true, kind: true, status: true },
  });
  const existingIds = new Set(existing.map((task) => task.id));
  const missing = uniqueIds.filter((id) => !existingIds.has(id));
  if (existing.length > 0) {
    await prisma.$transaction(async (transaction) => {
      await transaction.auditLog.create({
        data: {
          knowledgeBaseId: knowledgeBase.id,
          actor: "local-user",
          action: "task-deleted",
          targetType: "Task",
          targetId: existing.map((task) => task.id).join(","),
          afterData: JSON.stringify(existing.map((task) => ({ id: task.id, kind: task.kind, status: task.status }))),
        },
      });
      await transaction.task.deleteMany({ where: { id: { in: existing.map((task) => task.id) }, knowledgeBaseId: knowledgeBase.id } });
    });
  }
  return { deleted: existing.length, missing: missing.length };
}

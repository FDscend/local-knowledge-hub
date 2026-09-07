import "dotenv/config";

import { EvaluationSetKind } from "@prisma/client";

import { createEvaluationRun, runEvaluationSet } from "../src/lib/evaluation";
import { prisma } from "../src/lib/prisma";
import { processOneTask } from "../src/lib/task-executor";
import { TASK_KIND, cancelQueuedTask, enqueueAutoEvaluation, enqueueTask, retryTask } from "../src/lib/tasks";

const KNOWLEDGE_BASE_ID = "default";
const SET_NAME = "__verify_tasks__";

async function drainUntilFinal(taskId: string, maxRounds = 120): Promise<{ status: string; resultJson: string | null; errorText: string | null }> {
  for (let round = 0; round < maxRounds; round += 1) {
    await processOneTask();
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true, resultJson: true, errorText: true } });
    if (!task) {
      throw new Error("任务记录不存在");
    }
    if (task.status === "SUCCEEDED" || task.status === "FAILED" || task.status === "CANCELLED") {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`任务 ${taskId} 未在预期轮次内结束`);
}

async function main(): Promise<void> {
  await prisma.task.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, kind: { in: ["EVALUATION", "AUTO_EVALUATION", "VECTOR_INDEX"] } } });
  await prisma.evaluationSet.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, name: SET_NAME } });

  const evaluationSet = await prisma.evaluationSet.create({
    data: {
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      name: SET_NAME,
      description: "任务执行器验证用临时评测集，验证后删除。",
      kind: EvaluationSetKind.AUTO_CANDIDATE,
      cases: {
        create: [
          { externalId: "v1", question: "什么是检索增强生成（RAG）？", expectedTitles: JSON.stringify(["RAG检索增强生成"]), reviewed: false },
          { externalId: "v2", question: "混合检索如何融合词法与语义结果？", expectedTitles: JSON.stringify(["混合检索", "向量索引与Embedding"]), reviewed: false },
        ],
      },
    },
    select: { id: true },
  });

  try {
    // 1. 直连对照运行。
    const directRun = await runEvaluationSet(KNOWLEDGE_BASE_ID, evaluationSet.id, {});
    if (!directRun.id) throw new Error("对照评测运行失败");

    // 2. 通过任务队列执行评测。
    const queuedRun = await createEvaluationRun(KNOWLEDGE_BASE_ID, evaluationSet.id, {});
    const queued = await enqueueTask(KNOWLEDGE_BASE_ID, TASK_KIND.EVALUATION, { runId: queuedRun.id, isSandbox: false });
    const finished = await drainUntilFinal(queued.id);
    if (finished.status !== "SUCCEEDED") throw new Error(`评测任务未成功：${finished.status} ${finished.errorText ?? ""}`);
    const metrics = JSON.parse(finished.resultJson ?? "{}") as { hitAt5Count?: number; caseCount?: number };
    if (typeof metrics.hitAt5Count !== "number" || metrics.caseCount !== 2) throw new Error(`评测任务结果异常：${finished.resultJson}`);

    // 3. 无效运行 ID 任务：应重试一次后失败。
    const broken = await prisma.task.create({
      data: {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        kind: TASK_KIND.EVALUATION,
        payloadJson: JSON.stringify({ runId: "nonexistent-run" }),
        maxAttempts: 2,
      },
    });
    const brokenFinished = await drainUntilFinal(broken.id);
    if (brokenFinished.status !== "FAILED") throw new Error("无效任务应最终失败");
    const brokenAfterRetry = await prisma.task.findUnique({ where: { id: broken.id }, select: { attempts: true } });
    if (brokenAfterRetry?.attempts !== 2) throw new Error("失败任务应重试一次");

    // 4. 失败任务手动重试 → 重新排队 → 取消。
    const retried = await retryTask(KNOWLEDGE_BASE_ID, broken.id);
    if (!retried) throw new Error("失败任务应可重试");
    const cancelled = await cancelQueuedTask(KNOWLEDGE_BASE_ID, broken.id);
    if (!cancelled) throw new Error("排队中任务应可取消");
    const cancelledState = await prisma.task.findUnique({ where: { id: broken.id }, select: { status: true } });
    if (cancelledState?.status !== "CANCELLED") throw new Error("任务应处于已取消状态");

    // 5. 自动评测防抖：5 分钟内第二次入队应去重。
    const firstAuto = await enqueueAutoEvaluation(KNOWLEDGE_BASE_ID, "验证脚本第一次触发");
    const secondAuto = await enqueueAutoEvaluation(KNOWLEDGE_BASE_ID, "验证脚本第二次触发");
    if (!secondAuto.deduplicated) throw new Error("自动评测任务应去重");
    await cancelQueuedTask(KNOWLEDGE_BASE_ID, firstAuto.id);

    // 6. 向量索引任务取消（不实际执行，仅验证排队与取消路径）。
    const vectorTask = await enqueueTask(KNOWLEDGE_BASE_ID, TASK_KIND.VECTOR_INDEX, {});
    const vectorCancelled = await cancelQueuedTask(KNOWLEDGE_BASE_ID, vectorTask.id);
    if (!vectorCancelled) throw new Error("向量索引任务应可取消");

    console.log(JSON.stringify({
      status: "ok",
      directRun: { hitAt5: directRun.hitAt5Count, mrr: directRun.meanReciprocalRank },
      queuedRunMetrics: metrics,
      retryOnceThenFailed: "confirmed",
      manualRetryThenCancel: cancelledState?.status,
      autoDeduplicated: secondAuto.deduplicated,
      vectorTaskCancelled: vectorCancelled,
    }));
  } finally {
    await prisma.evaluationSet.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, name: SET_NAME } });
    await prisma.task.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, kind: { in: ["EVALUATION", "AUTO_EVALUATION", "VECTOR_INDEX"] } } });
  }
}

void main().finally(async () => prisma.$disconnect());

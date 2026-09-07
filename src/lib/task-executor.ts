import { getLlmConfig } from "@/lib/llm";
import { executeEvaluationRun, runEvaluationSet, type EvaluationRunOptions } from "@/lib/evaluation";
import { generateCandidateCases } from "@/lib/evaluation-llm";
import { rebuildKnowledgeBaseVectorIndex } from "@/lib/embedding";
import { buildKnowledgeGraph } from "@/lib/graph";
import { importDirectorySnapshotFromDisk } from "@/lib/directory-sync";
import { prisma } from "@/lib/prisma";
import { TASK_KIND, TASK_STATUS, enqueueGraphBuild, type TaskKind } from "@/lib/tasks";
import { rm } from "node:fs/promises";

declare global {
  var __taskExecutorStarted: boolean | undefined;
  var __taskRuntimeOverrides: Map<string, TaskRuntimeOverrides> | undefined;
}

export type TaskRuntimeOverrides = {
  llm?: { apiKey?: string; baseURL?: string; model?: string };
  embedding?: { apiKey?: string; baseURL?: string; model?: string };
};

/** 请求内浏览器传入的运行时密钥仅驻留进程内存（不落库），执行器取用后即清除；进程重启后回落环境变量。 */
export function storeTaskRuntimeOverrides(taskId: string, overrides: TaskRuntimeOverrides): void {
  if (!Object.values(overrides).some((group) => group && Object.values(group).some((value) => Boolean(value)))) {
    return;
  }
  globalThis.__taskRuntimeOverrides ??= new Map();
  globalThis.__taskRuntimeOverrides.set(taskId, overrides);
}

type TaskRecord = {
  id: string;
  knowledgeBaseId: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  autoTriggered: boolean;
  payloadJson: string | null;
  resultJson: string | null;
  errorText: string | null;
  progressCurrent: number;
  progressTotal: number;
};

type TaskHandler = (task: TaskRecord, updateProgress: (current: number, total: number) => Promise<void>) => Promise<Record<string, unknown>>;

const POLL_INTERVAL_MS = 2_000;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsePayload(value: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function markTaskStatus(taskId: string, status: string, data: { resultJson?: string; errorText?: string | null; progressCurrent?: number; progressTotal?: number; finishedAt?: Date | null }): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: {
      ...(data.resultJson !== undefined ? { resultJson: data.resultJson } : {}),
      ...(data.errorText !== undefined ? { errorText: data.errorText } : {}),
      ...(data.progressCurrent !== undefined ? { progressCurrent: data.progressCurrent } : {}),
      ...(data.progressTotal !== undefined ? { progressTotal: data.progressTotal } : {}),
      ...(data.finishedAt !== undefined ? { finishedAt: data.finishedAt } : {}),
      status,
    },
  });
}

/** 评测运行：执行已创建好的 EvaluationRun，并周期性同步完成题数到任务进度。 */
const runEvaluationTask: TaskHandler = async (task, updateProgress) => {
  const payload = parsePayload(task.payloadJson);
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  if (!runId) {
    throw new Error("评测任务缺少运行记录 ID。");
  }
  const runtime = globalThis.__taskRuntimeOverrides?.get(task.id);
  const options: EvaluationRunOptions = {
    isSandbox: Boolean(payload.isSandbox),
    ...(payload.configOverrides && typeof payload.configOverrides === "object" ? { configOverrides: payload.configOverrides as EvaluationRunOptions["configOverrides"] } : {}),
    llmApiKey: runtime?.llm?.apiKey,
    llmBaseURL: runtime?.llm?.baseURL,
    llmModel: runtime?.llm?.model,
    embeddingApiKey: runtime?.embedding?.apiKey,
    embeddingBaseURL: runtime?.embedding?.baseURL,
    embeddingModel: runtime?.embedding?.model,
  };

  const progressSync = setInterval(() => {
    void prisma.evaluationRun
      .findUnique({ where: { id: runId }, select: { completedCount: true, caseCount: true } })
      .then((run) => {
        if (run) {
          return updateProgress(run.completedCount, run.caseCount);
        }
        return undefined;
      })
      .catch(() => undefined);
  }, 3_000);

  try {
    const summary = await executeEvaluationRun(runId, options);
    return {
      runId,
      status: summary.status,
      caseCount: summary.caseCount,
      completedCount: summary.completedCount,
      hitAt5Count: summary.hitAt5Count,
      meanRecallAt5: summary.meanRecallAt5,
      meanReciprocalRank: summary.meanReciprocalRank,
    };
  } finally {
    clearInterval(progressSync);
  }
};

/** 自动评测：无评测集时在有 LLM Key 的前提下生成候选题，然后跑一次冒烟评测。 */
const runAutoEvaluationTask: TaskHandler = async (task, updateProgress) => {
  const knowledgeBaseId = task.knowledgeBaseId;
  const activeDocumentCount = await prisma.knowledgeDocument.count({
    where: { knowledgeBaseId, status: "ACTIVE" },
  });
  if (activeDocumentCount === 0) {
    return { skipped: true, reason: "当前知识库没有可评测的文档，已跳过。" };
  }

  const latestSet = await prisma.evaluationSet.findFirst({
    where: { knowledgeBaseId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  let evaluationSetId = latestSet?.id ?? null;
  if (!evaluationSetId) {
    const llmConfig = getLlmConfig({});
    if (!llmConfig.apiKey) {
      return { skipped: true, reason: "当前知识库没有评测集，且未配置 LLM API Key，无法自动生成候选题。" };
    }
    const generated = await generateCandidateCases(knowledgeBaseId, { maxCases: 8, maxDocuments: 8, replaceExisting: false });
    evaluationSetId = generated.evaluationSetId;
  }

  const run = await runEvaluationSet(knowledgeBaseId, evaluationSetId, {});
  await updateProgress(run.caseCount, run.caseCount);
  return {
    runId: run.id,
    evaluationSetId,
    status: run.status,
    caseCount: run.caseCount,
    hitAt5Count: run.hitAt5Count,
    meanRecallAt5: run.meanRecallAt5,
    meanReciprocalRank: run.meanReciprocalRank,
  };
};

/** 向量索引：重建当前知识库的 sqlite-vec 索引；API Key 与 Base URL 回落环境变量。 */
const runVectorIndexTask: TaskHandler = async (task) => {
  const payload = parsePayload(task.payloadJson);
  const runtime = globalThis.__taskRuntimeOverrides?.get(task.id);
  const result = await rebuildKnowledgeBaseVectorIndex(task.knowledgeBaseId, {
    apiKey: runtime?.embedding?.apiKey,
    baseURL: runtime?.embedding?.baseURL,
    model: (typeof payload.model === "string" && payload.model.trim() ? payload.model : runtime?.embedding?.model) || undefined,
  });
  // 向量变化后语义近邻边需要重算。
  await enqueueGraphBuild(task.knowledgeBaseId, "向量索引重建完成");
  return { ...result, indexedAt: new Date().toISOString() };
};

/** 目录导入：解析任务工作目录中已落盘的文件（含 MinerU），完成后清理工作目录并触发自动评测。 */
const runIngestTask: TaskHandler = async (task, updateProgress) => {
  const payload = parsePayload(task.payloadJson);
  const jobDir = typeof payload.jobDir === "string" && payload.jobDir.trim() ? payload.jobDir.trim() : "";
  const files = Array.isArray(payload.files) ? (payload.files as Array<{ relativePath?: unknown; filePath?: unknown }>) : [];
  if (!jobDir || files.length === 0) {
    throw new Error("导入任务缺少文件清单或工作目录。");
  }
  const entries = files
    .filter((file) => typeof file.relativePath === "string" && typeof file.filePath === "string")
    .map((file) => ({ relativePath: file.relativePath as string, filePath: file.filePath as string }));
  if (entries.length !== files.length) {
    throw new Error("导入任务文件清单格式无效。");
  }
  const mineruMode = payload.mineruMode === "precise" ? "precise" : "light";

  try {
    const result = await importDirectorySnapshotFromDisk(
      task.knowledgeBaseId,
      entries,
      { mineruMode },
      (done, total) => updateProgress(done, total),
    );
    // 导入成功后才清理任务工作目录；失败保留文件，手动重试可复用。
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    // 文档集合变化后自动重建图谱（防抖）。
    await enqueueGraphBuild(task.knowledgeBaseId, "导入任务完成");
    return {
      runId: result.runId,
      fileCount: entries.length,
      importedCount: result.importedCount,
      unchangedCount: result.unchangedCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
      errors: result.errors.slice(0, 20),
      status: result.errorCount > 0 ? (result.importedCount + result.unchangedCount > 0 ? "PARTIAL" : "FAILED") : "SUCCEEDED",
    };
  } catch (error) {
    // 抛出的错误由执行器统一处理重试；文件保留在任务工作目录。
    throw error;
  }
};

/** 图谱：全量重建当前知识库的节点与三类边（显式链接 / 规则 / 语义近邻）。 */
const runGraphBuildTask: TaskHandler = async (task, updateProgress) => {
  await updateProgress(0, 3);
  const result = await buildKnowledgeGraph(task.knowledgeBaseId);
  await updateProgress(3, 3);
  return { ...result, builtAt: new Date().toISOString() };
};

const handlers: Partial<Record<TaskKind, TaskHandler>> = {
  [TASK_KIND.EVALUATION]: runEvaluationTask,
  [TASK_KIND.AUTO_EVALUATION]: runAutoEvaluationTask,
  [TASK_KIND.VECTOR_INDEX]: runVectorIndexTask,
  [TASK_KIND.INGEST]: runIngestTask,
  [TASK_KIND.GRAPH_BUILD]: runGraphBuildTask,
};

export async function processOneTask(): Promise<void> {
  // 条件更新保证单消费者：只有仍处于 QUEUED 的任务才被抢占为 RUNNING。
  const claimed = await prisma.task.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (!claimed) {
    return;
  }
  const updated = await prisma.task.updateMany({
    where: { id: claimed.id, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (updated.count === 0) {
    return;
  }

  const handler = handlers[claimed.kind as TaskKind];
  const updateProgress = async (current: number, total: number): Promise<void> => {
    await prisma.task.update({
      where: { id: claimed.id },
      data: { progressCurrent: current, progressTotal: total },
    });
  };

  try {
    if (!handler) {
      throw new Error(`未知任务类型：${claimed.kind}`);
    }
    const result = await handler(claimed, updateProgress);
    const resultJson = json(result);
    const progressTotal = typeof result.caseCount === "number"
      ? result.caseCount
      : typeof result.fileCount === "number"
        ? result.fileCount
        : claimed.progressTotal;
    await markTaskStatus(claimed.id, TASK_STATUS.SUCCEEDED, {
      resultJson,
      progressCurrent: progressTotal,
      progressTotal,
      finishedAt: new Date(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const canRetry = claimed.attempts + 1 < claimed.maxAttempts;
    if (canRetry) {
      await markTaskStatus(claimed.id, TASK_STATUS.QUEUED, {
        errorText: message,
        finishedAt: null,
      });
      await prisma.task.update({ where: { id: claimed.id }, data: { attempts: claimed.attempts + 1 } });
      return;
    }
    await markTaskStatus(claimed.id, TASK_STATUS.FAILED, {
      errorText: message,
      finishedAt: new Date(),
    });
    await prisma.task.update({ where: { id: claimed.id }, data: { attempts: claimed.attempts + 1 } });
  } finally {
    globalThis.__taskRuntimeOverrides?.delete(claimed.id);
  }
}

export function startTaskExecutor(): void {
  if (globalThis.__taskExecutorStarted) {
    return;
  }
  globalThis.__taskExecutorStarted = true;

  // 上次进程退出遗留的 RUNNING 任务重新入队，保证可恢复。
  void prisma.task
    .updateMany({ where: { status: "RUNNING" }, data: { status: "QUEUED", errorText: "任务因进程重启中断，已重新排队。" } })
    .then(() => undefined)
    .catch(() => undefined);

  console.log("[task-executor] 后台任务执行器已启动");
  setInterval(() => {
    void processOneTask().catch((error) => {
      console.error("[task-executor] 处理任务失败：", error);
    });
  }, POLL_INTERVAL_MS);
}

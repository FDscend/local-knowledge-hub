import { NextResponse } from "next/server";
import { z } from "zod";

import { createEvaluationRun, deleteEvaluationRuns, type EvaluationRunSummary } from "@/lib/evaluation";
import { readRuntimeEmbeddingOverridesFromRequest, readRuntimeLlmOverridesFromRequest } from "@/lib/runtime-keys";
import { TASK_KIND, enqueueTask } from "@/lib/tasks";
import { storeTaskRuntimeOverrides } from "@/lib/task-executor";

const evaluationRequestSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  evaluationSetId: z.string().trim().min(1),
  channelTopK: z.number().int().min(5).max(100).optional(),
  rrfK: z.number().int().min(1).max(200).optional(),
  mmrLambda: z.number().min(0).max(1).optional(),
  rrfScoreWeight: z.number().min(0).max(10000).optional(),
  isSandbox: z.boolean().optional(),
});

type RunPayload = Omit<EvaluationRunSummary, "startedAt" | "finishedAt"> & {
  startedAt: string;
  finishedAt: string | null;
};

function serializeRun(run: EvaluationRunSummary): RunPayload {
  return {
    ...run,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export async function POST(request: Request) {
  try {
    const input = evaluationRequestSchema.parse(await request.json());
    const embedding = readRuntimeEmbeddingOverridesFromRequest(request);
    const llm = readRuntimeLlmOverridesFromRequest(request);
    const options = {
      embeddingApiKey: embedding.embeddingApiKey,
      embeddingBaseURL: embedding.embeddingBaseURL,
      embeddingModel: embedding.embeddingModel,
      llmApiKey: llm.llmApiKey,
      llmBaseURL: llm.llmBaseURL,
      llmModel: llm.llmModel,
      configOverrides: {
        ...(input.channelTopK !== undefined ? { channelTopK: input.channelTopK } : {}),
        ...(input.rrfK !== undefined ? { rrfK: input.rrfK } : {}),
        ...(input.mmrLambda !== undefined ? { mmrLambda: input.mmrLambda } : {}),
        ...(input.rrfScoreWeight !== undefined ? { rrfScoreWeight: input.rrfScoreWeight } : {}),
      },
      isSandbox: input.isSandbox,
    };

    // 先创建运行记录并立即返回；执行交给后台任务执行器（常驻队列，失败自动重试一次），前端轮询进度。
    const run = await createEvaluationRun(input.knowledgeBaseId, input.evaluationSetId, options);
    const queued = await enqueueTask(input.knowledgeBaseId, TASK_KIND.EVALUATION, {
      runId: run.id,
      isSandbox: Boolean(input.isSandbox),
      ...(options.configOverrides && Object.keys(options.configOverrides).length > 0
        ? { configOverrides: options.configOverrides }
        : {}),
    });
    // 浏览器运行时密钥只驻留进程内存，由执行器取用后清除，不写入任务表。
    storeTaskRuntimeOverrides(queued.id, {
      llm: { apiKey: llm.llmApiKey, baseURL: llm.llmBaseURL, model: llm.llmModel },
      embedding: { apiKey: embedding.embeddingApiKey, baseURL: embedding.embeddingBaseURL, model: embedding.embeddingModel },
    });
    return NextResponse.json(serializeRun(run));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "评测运行失败。" }, { status: 400 });
  }
}

const deleteRunsSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  runIds: z.array(z.string().trim().min(1)).min(1),
});

export async function DELETE(request: Request) {
  try {
    const input = deleteRunsSchema.parse(await request.json());
    const deleted = await deleteEvaluationRuns(input.knowledgeBaseId, input.runIds);
    return NextResponse.json({ deleted });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "评测记录删除失败。" }, { status: 400 });
  }
}

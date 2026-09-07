import { EvaluationSetKind, EvaluationRunStatus, type EvaluationCase, type EvaluationResult } from "@prisma/client";

import { defaultEvaluationCases, DEFAULT_EVALUATION_SET_DESCRIPTION, DEFAULT_EVALUATION_SET_NAME, LEGACY_DEFAULT_EVALUATION_SET_NAME, type EvaluationCaseDefinition } from "@/lib/evaluation-cases";
import { getEmbeddingIndexStatus } from "@/lib/embedding";
import { initializeKnowledgeBaseState, requireKnowledgeBase } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";
import { understandQuery } from "@/lib/query-understanding";
import { resolveRetrievalConfig, searchRelevantChunksDetailed, type RetrievalConfigOverrides, type RetrievalDebugSnapshot } from "@/lib/rag";
import { getProductionRetrievalConfig } from "@/lib/retrieval-config";

export type EvaluationRunOptions = {
  embeddingApiKey?: string | null;
  embeddingBaseURL?: string | null;
  embeddingModel?: string | null;
  llmApiKey?: string | null;
  llmBaseURL?: string | null;
  llmModel?: string | null;
  configOverrides?: RetrievalConfigOverrides;
  isSandbox?: boolean;
};

type EvaluationCaseJson = {
  expectedTitles: string[];
  expectedDocumentIds: string[];
  expectedChunkIds: string[];
};

type EvaluationResultJson = EvaluationCaseJson & {
  actualTitles: string[];
  actualDocumentIds: string[];
  actualChunkIds: string[];
  retrievalDebug: RetrievalDebugSnapshot;
};

export type EvaluationRunSummary = {
  id: string;
  status: EvaluationRunStatus;
  caseCount: number;
  completedCount: number;
  hitAt1Count: number;
  hitAt3Count: number;
  hitAt5Count: number;
  meanRecallAt5: number;
  meanReciprocalRank: number;
  startedAt: Date;
  finishedAt: Date | null;
  errorText: string | null;
};

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function calculateMetrics(expectedIds: string[], actualIds: string[]): { firstRelevantRank: number | null; hitAt1: boolean; hitAt3: boolean; hitAt5: boolean; recallAt5: number; reciprocalRank: number } {
  const expected = new Set(expectedIds);
  const firstRelevantIndex = actualIds.findIndex((id) => expected.has(id));
  const firstRelevantRank = firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : null;
  const topFive = new Set(actualIds.slice(0, 5));
  const matchedCount = Array.from(expected).filter((id) => topFive.has(id)).length;

  return {
    firstRelevantRank,
    hitAt1: firstRelevantRank === 1,
    hitAt3: firstRelevantRank !== null && firstRelevantRank <= 3,
    hitAt5: firstRelevantRank !== null && firstRelevantRank <= 5,
    recallAt5: expected.size > 0 ? matchedCount / expected.size : 0,
    reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
  };
}

async function createRetrievalConfigSnapshot(knowledgeBaseId: string, options: EvaluationRunOptions): Promise<string> {
  const production = await getProductionRetrievalConfig(knowledgeBaseId);
  const resolved = resolveRetrievalConfig({ ...production, ...options.configOverrides });
  return json({
    channelTopK: resolved.channelTopK,
    rrfK: resolved.rrfK,
    mmrLambda: resolved.mmrLambda,
    rrfScoreWeight: resolved.rrfScoreWeight,
    finalLimit: 5,
    embeddingModel: options.embeddingModel?.trim() || process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    embeddingConfigured: Boolean(options.embeddingApiKey?.trim() || process.env.EMBEDDING_API_KEY?.trim()),
    isSandbox: Boolean(options.isSandbox),
    production,
    overrides: options.configOverrides && Object.keys(options.configOverrides).length > 0 ? options.configOverrides : null,
  });
}

async function resolveExpectedEvidence(knowledgeBaseId: string, evaluationCase: EvaluationCase): Promise<EvaluationCaseJson> {
  const expectedTitles = parseJsonArray(evaluationCase.expectedTitles);
  const expectedDocumentIds = parseJsonArray(evaluationCase.expectedDocumentIds);
  const expectedChunkIds = parseJsonArray(evaluationCase.expectedChunkIds);

  const documents = expectedDocumentIds.length > 0
    ? await prisma.knowledgeDocument.findMany({
        where: { knowledgeBaseId, id: { in: expectedDocumentIds } },
        select: { id: true, title: true },
      })
    : await prisma.knowledgeDocument.findMany({
        where: { knowledgeBaseId, title: { in: expectedTitles } },
        select: { id: true, title: true },
      });

  const resolvedDocumentIds = uniqueStrings(documents.map((document) => document.id));
  const resolvedTitles = uniqueStrings([
    ...expectedTitles,
    ...documents.map((document) => document.title),
  ]);
  const chunks = expectedChunkIds.length > 0
    ? await prisma.knowledgeChunk.findMany({
        where: { id: { in: expectedChunkIds }, document: { knowledgeBaseId } },
        select: { id: true },
      })
    : [];

  return {
    expectedTitles: resolvedTitles,
    expectedDocumentIds: resolvedDocumentIds,
    expectedChunkIds: uniqueStrings(chunks.map((chunk) => chunk.id)),
  };
}

export async function ensureDefaultEvaluationSet(knowledgeBaseId = "default"): Promise<{ id: string; created: boolean }> {
  await initializeKnowledgeBaseState();
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);

  // 兼容历史名称：默认库评测集曾叫“阶段 2 问答回归”，题目已重新生成，这里只做幂等重命名，不重复建集。
  const existing = await prisma.evaluationSet.findUnique({
    where: {
      knowledgeBaseId_name: {
        knowledgeBaseId: knowledgeBase.id,
        name: DEFAULT_EVALUATION_SET_NAME,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return { id: existing.id, created: false };
  }
  const legacy = await prisma.evaluationSet.findUnique({
    where: {
      knowledgeBaseId_name: {
        knowledgeBaseId: knowledgeBase.id,
        name: LEGACY_DEFAULT_EVALUATION_SET_NAME,
      },
    },
    select: { id: true },
  });
  if (legacy) {
    await prisma.evaluationSet.update({
      where: { id: legacy.id },
      data: { name: DEFAULT_EVALUATION_SET_NAME, description: DEFAULT_EVALUATION_SET_DESCRIPTION },
    });
    return { id: legacy.id, created: false };
  }

  const evaluationSet = await prisma.evaluationSet.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      name: DEFAULT_EVALUATION_SET_NAME,
      description: DEFAULT_EVALUATION_SET_DESCRIPTION,
      kind: EvaluationSetKind.AUTO_CANDIDATE,
      cases: {
        create: defaultEvaluationCases.map((evaluationCase) => ({
          externalId: evaluationCase.externalId,
          question: evaluationCase.question,
          expectedTitles: json(evaluationCase.expectedTitles),
          reviewed: false,
        })),
      },
    },
    select: { id: true },
  });

  return { id: evaluationSet.id, created: true };
}

export async function listEvaluationSets(knowledgeBaseId: string) {
  await requireKnowledgeBase(knowledgeBaseId);
  return prisma.evaluationSet.findMany({
    where: { knowledgeBaseId },
    include: { _count: { select: { cases: true, runs: true } } },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
  });
}

export async function listEvaluationRuns(knowledgeBaseId: string, evaluationSetId?: string): Promise<EvaluationRunSummary[]> {
  await requireKnowledgeBase(knowledgeBaseId);
  const runs = await prisma.evaluationRun.findMany({
    where: { knowledgeBaseId, ...(evaluationSetId ? { evaluationSetId } : {}) },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return runs;
}

export async function deleteEvaluationRuns(knowledgeBaseId: string, runIds: string[]): Promise<{ deleted: number; missing: number }> {
  await requireKnowledgeBase(knowledgeBaseId);
  const validRunIds = runIds.filter((id) => typeof id === "string" && id.trim().length > 0);
  if (validRunIds.length === 0) {
    throw new Error("未选择要删除的评测运行记录。");
  }
  const existing = await prisma.evaluationRun.findMany({
    where: { id: { in: validRunIds }, knowledgeBaseId },
    select: { id: true },
  });
  const existingIds = existing.map((run) => run.id);
  if (existingIds.length === 0) {
    return { deleted: 0, missing: validRunIds.length };
  }
  const deleted = await prisma.evaluationRun.deleteMany({
    where: { id: { in: existingIds } },
  });
  await prisma.auditLog.create({
    data: {
      knowledgeBaseId,
      action: "evaluation-runs-deleted",
      targetType: "EvaluationRun",
      targetId: existingIds.join(","),
      afterData: json({ runIds: existingIds }),
    },
  });
  return { deleted: deleted.count, missing: validRunIds.length - deleted.count };
}

export async function getEvaluationRun(knowledgeBaseId: string, runId: string) {
  await requireKnowledgeBase(knowledgeBaseId);
  return prisma.evaluationRun.findFirst({
    where: { id: runId, knowledgeBaseId },
    include: {
      evaluationSet: true,
      results: { orderBy: { externalId: "asc" } },
    },
  });
}

export async function runEvaluationSet(
  knowledgeBaseId: string,
  evaluationSetId: string,
  options: EvaluationRunOptions = {},
): Promise<EvaluationRunSummary> {
  const run = await createEvaluationRun(knowledgeBaseId, evaluationSetId, options);
  return executeEvaluationRun(run.id, options);
}

export async function createEvaluationRun(
  knowledgeBaseId: string,
  evaluationSetId: string,
  options: EvaluationRunOptions = {},
): Promise<EvaluationRunSummary> {
  await initializeKnowledgeBaseState();
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const evaluationSet = await prisma.evaluationSet.findFirst({
    where: { id: evaluationSetId, knowledgeBaseId: knowledgeBase.id },
    include: { cases: { orderBy: { externalId: "asc" } } },
  });
  if (!evaluationSet) {
    throw new Error("评测集不存在或不属于当前知识库。");
  }

  const embeddingStatus = getEmbeddingIndexStatus(knowledgeBase.id);
  const configOverridesJson = options.configOverrides && Object.keys(options.configOverrides).length > 0 ? json(options.configOverrides) : null;
  const run = await prisma.evaluationRun.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      evaluationSetId: evaluationSet.id,
      status: EvaluationRunStatus.RUNNING,
      retrievalConfigSnapshot: await createRetrievalConfigSnapshot(knowledgeBase.id, options),
      configOverridesJson,
      isSandbox: Boolean(options.isSandbox),
      indexSnapshot: json({
        embeddingStatus: embeddingStatus.status,
        embeddingModel: embeddingStatus.model,
        dimensions: embeddingStatus.dimensions,
        indexedCount: embeddingStatus.indexedCount,
        indexedAt: embeddingStatus.indexedAt,
      }),
      dataSnapshot: json({
        evaluationSetId: evaluationSet.id,
        evaluationSetKind: evaluationSet.kind,
        caseIds: evaluationSet.cases.map((evaluationCase) => evaluationCase.id),
      }),
      caseCount: evaluationSet.cases.length,
    },
  });

  return {
    id: run.id,
    status: run.status,
    caseCount: run.caseCount,
    completedCount: run.completedCount,
    hitAt1Count: run.hitAt1Count,
    hitAt3Count: run.hitAt3Count,
    hitAt5Count: run.hitAt5Count,
    meanRecallAt5: run.meanRecallAt5,
    meanReciprocalRank: run.meanReciprocalRank,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorText: run.errorText,
  };
}

export async function executeEvaluationRun(runId: string, options: EvaluationRunOptions = {}): Promise<EvaluationRunSummary> {
  const run = await prisma.evaluationRun.findUnique({
    where: { id: runId },
    include: { evaluationSet: { include: { cases: { orderBy: { externalId: "asc" } } } } },
  });
  if (!run) {
    throw new Error("评测运行记录不存在。");
  }
  const knowledgeBase = await requireKnowledgeBase(run.knowledgeBaseId);
  const evaluationSet = run.evaluationSet;
  let completedCount = 0;
  let hitAt1Count = 0;
  let hitAt3Count = 0;
  let hitAt5Count = 0;
  let recallTotal = 0;
  let reciprocalRankTotal = 0;
  let failedCount = 0;

  try {
    for (const evaluationCase of evaluationSet.cases) {
      const startedAt = Date.now();
      let expected: EvaluationCaseJson = {
        expectedTitles: parseJsonArray(evaluationCase.expectedTitles),
        expectedDocumentIds: parseJsonArray(evaluationCase.expectedDocumentIds),
        expectedChunkIds: parseJsonArray(evaluationCase.expectedChunkIds),
      };

      try {
        expected = await resolveExpectedEvidence(knowledgeBase.id, evaluationCase);
        const queryUnderstanding = await understandQuery(evaluationCase.question, options);
        const search = await searchRelevantChunksDetailed(evaluationCase.question, knowledgeBase.id, 5, options, options.configOverrides, queryUnderstanding);
        const actualDocumentIds = uniqueStrings(search.chunks.map((chunk) => chunk.document.id));
        const actualTitles = uniqueStrings(search.chunks.map((chunk) => chunk.document.title));
        const actualChunkIds = search.chunks.map((chunk) => chunk.id);
        const actualEvidenceIds = expected.expectedChunkIds.length > 0 ? actualChunkIds : actualDocumentIds;
        const expectedEvidenceIds = expected.expectedChunkIds.length > 0 ? expected.expectedChunkIds : expected.expectedDocumentIds;
        const metrics = calculateMetrics(expectedEvidenceIds, actualEvidenceIds);
        const chunkLevel = expected.expectedChunkIds.length > 0;
        const hitChunkCount = chunkLevel
          ? actualChunkIds.slice(0, 5).filter((id) => expected.expectedChunkIds.includes(id)).length
          : null;
        const failureReason = expectedEvidenceIds.length === 0
          ? "当前知识库中未找到题目标注的预期文档或切片。"
          : !metrics.hitAt5
            ? chunkLevel
              ? `切片级判定：预期 ${expected.expectedChunkIds.length} 个切片，Top 5 中命中 ${hitChunkCount ?? 0} 个。相关文档可能已出现，但预期切片未进入 Top 5。`
              : "文档级判定：预期文档未进入 Top 5。"
            : null;
        const resultJson: EvaluationResultJson = {
          ...expected,
          actualTitles,
          actualDocumentIds,
          actualChunkIds,
          retrievalDebug: search.debug,
        };

        await prisma.evaluationResult.upsert({
          where: { runId_caseId: { runId: run.id, caseId: evaluationCase.id } },
          create: {
            runId: run.id,
            caseId: evaluationCase.id,
            externalId: evaluationCase.externalId,
            question: evaluationCase.question,
            expectedTitles: json(expected.expectedTitles),
            expectedDocumentIds: json(expected.expectedDocumentIds),
            expectedChunkIds: json(expected.expectedChunkIds),
            actualTitles: json(resultJson.actualTitles),
            actualDocumentIds: json(resultJson.actualDocumentIds),
            actualChunkIds: json(resultJson.actualChunkIds),
            retrievalMode: search.debug.vectorCandidateCount > 0 ? "hybrid" : "fts",
            retrievalDebug: json(search.debug),
            status: "SUCCEEDED",
            firstRelevantRank: metrics.firstRelevantRank,
            hitAt1: metrics.hitAt1,
            hitAt3: metrics.hitAt3,
            hitAt5: metrics.hitAt5,
            recallAt5: metrics.recallAt5,
            reciprocalRank: metrics.reciprocalRank,
            durationMs: Date.now() - startedAt,
            failureReason,
          },
          update: {
            expectedTitles: json(expected.expectedTitles),
            expectedDocumentIds: json(expected.expectedDocumentIds),
            expectedChunkIds: json(expected.expectedChunkIds),
            actualTitles: json(resultJson.actualTitles),
            actualDocumentIds: json(resultJson.actualDocumentIds),
            actualChunkIds: json(resultJson.actualChunkIds),
            retrievalMode: search.debug.vectorCandidateCount > 0 ? "hybrid" : "fts",
            retrievalDebug: json(search.debug),
            status: "SUCCEEDED",
            firstRelevantRank: metrics.firstRelevantRank,
            hitAt1: metrics.hitAt1,
            hitAt3: metrics.hitAt3,
            hitAt5: metrics.hitAt5,
            recallAt5: metrics.recallAt5,
            reciprocalRank: metrics.reciprocalRank,
            durationMs: Date.now() - startedAt,
            failureReason,
          },
        });

        hitAt1Count += metrics.hitAt1 ? 1 : 0;
        hitAt3Count += metrics.hitAt3 ? 1 : 0;
        hitAt5Count += metrics.hitAt5 ? 1 : 0;
        recallTotal += metrics.recallAt5;
        reciprocalRankTotal += metrics.reciprocalRank;
      } catch (error) {
        failedCount += 1;
        await prisma.evaluationResult.upsert({
          where: { runId_caseId: { runId: run.id, caseId: evaluationCase.id } },
          create: {
            runId: run.id,
            caseId: evaluationCase.id,
            externalId: evaluationCase.externalId,
            question: evaluationCase.question,
            expectedTitles: json(expected.expectedTitles),
            expectedDocumentIds: json(expected.expectedDocumentIds),
            expectedChunkIds: json(expected.expectedChunkIds),
            status: "FAILED",
            durationMs: Date.now() - startedAt,
            failureReason: error instanceof Error ? error.message : String(error),
          },
          update: {
            expectedTitles: json(expected.expectedTitles),
            expectedDocumentIds: json(expected.expectedDocumentIds),
            expectedChunkIds: json(expected.expectedChunkIds),
            actualTitles: "[]",
            actualDocumentIds: "[]",
            actualChunkIds: "[]",
            retrievalMode: null,
            retrievalDebug: null,
            status: "FAILED",
            firstRelevantRank: null,
            hitAt1: false,
            hitAt3: false,
            hitAt5: false,
            recallAt5: 0,
            reciprocalRank: 0,
            durationMs: Date.now() - startedAt,
            failureReason: error instanceof Error ? error.message : String(error),
          },
        });
      }

      completedCount += 1;
      await prisma.evaluationRun.update({
        where: { id: run.id },
        data: { completedCount, hitAt1Count, hitAt3Count, hitAt5Count },
      });
    }

    const summary = await prisma.evaluationRun.update({
      where: { id: run.id },
      data: {
        status: failedCount === evaluationSet.cases.length && evaluationSet.cases.length > 0
          ? EvaluationRunStatus.FAILED
          : failedCount > 0
            ? EvaluationRunStatus.PARTIAL
            : EvaluationRunStatus.SUCCEEDED,
        completedCount,
        hitAt1Count,
        hitAt3Count,
        hitAt5Count,
        meanRecallAt5: evaluationSet.cases.length > 0 ? recallTotal / evaluationSet.cases.length : 0,
        meanReciprocalRank: evaluationSet.cases.length > 0 ? reciprocalRankTotal / evaluationSet.cases.length : 0,
        metricsJson: json({
          hitAt1: evaluationSet.cases.length > 0 ? hitAt1Count / evaluationSet.cases.length : 0,
          hitAt3: evaluationSet.cases.length > 0 ? hitAt3Count / evaluationSet.cases.length : 0,
          hitAt5: evaluationSet.cases.length > 0 ? hitAt5Count / evaluationSet.cases.length : 0,
          recallAt5: evaluationSet.cases.length > 0 ? recallTotal / evaluationSet.cases.length : 0,
          mrr: evaluationSet.cases.length > 0 ? reciprocalRankTotal / evaluationSet.cases.length : 0,
          failedCount,
        }),
        finishedAt: new Date(),
      },
    });
    return summary;
  } catch (error) {
    return prisma.evaluationRun.update({
      where: { id: run.id },
      data: {
        status: completedCount > 0 ? EvaluationRunStatus.PARTIAL : EvaluationRunStatus.FAILED,
        completedCount,
        hitAt1Count,
        hitAt3Count,
        hitAt5Count,
        errorText: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      },
    });
  }
}

export function deserializeEvaluationResult(result: EvaluationResult): EvaluationResultJson {
  return {
    expectedTitles: parseJsonArray(result.expectedTitles),
    expectedDocumentIds: parseJsonArray(result.expectedDocumentIds),
    expectedChunkIds: parseJsonArray(result.expectedChunkIds),
    actualTitles: parseJsonArray(result.actualTitles),
    actualDocumentIds: parseJsonArray(result.actualDocumentIds),
    actualChunkIds: parseJsonArray(result.actualChunkIds),
    retrievalDebug: result.retrievalDebug ? (JSON.parse(result.retrievalDebug) as RetrievalDebugSnapshot) : {
      query: result.question,
      terms: [],
      queryMode: "fallback",
      llmKeywords: null,
      semanticQuery: null,
      queryUnderstandingWarning: null,
      lexicalCandidateCount: 0,
      vectorCandidateCount: 0,
      mergedCandidateCount: 0,
      finalLimit: 5,
      candidates: [],
    },
  };
}

export function evaluationCaseDefinitions(): EvaluationCaseDefinition[] {
  return defaultEvaluationCases;
}

export type EvaluationCaseSummary = {
  id: string;
  externalId: string;
  question: string;
  expectedTitles: string[];
  expectedDocumentIds: string[];
  expectedChunkIds: string[];
  referenceAnswer: string | null;
  answerPoints: string[] | null;
  reviewed: boolean;
  updatedAt: Date;
};

export async function listEvaluationCases(knowledgeBaseId: string, evaluationSetId: string): Promise<EvaluationCaseSummary[]> {
  await requireKnowledgeBase(knowledgeBaseId);
  const evaluationSet = await prisma.evaluationSet.findFirst({
    where: { id: evaluationSetId, knowledgeBaseId },
    select: { id: true },
  });
  if (!evaluationSet) {
    throw new Error("评测集不存在或不属于当前知识库。");
  }
  const cases = await prisma.evaluationCase.findMany({
    where: { evaluationSetId: evaluationSet.id },
    orderBy: { externalId: "asc" },
  });
  return cases.map((evaluationCase) => ({
    id: evaluationCase.id,
    externalId: evaluationCase.externalId,
    question: evaluationCase.question,
    expectedTitles: parseJsonArray(evaluationCase.expectedTitles),
    expectedDocumentIds: parseJsonArray(evaluationCase.expectedDocumentIds),
    expectedChunkIds: parseJsonArray(evaluationCase.expectedChunkIds),
    referenceAnswer: evaluationCase.referenceAnswer,
    answerPoints: evaluationCase.answerPoints ? parseJsonArray(evaluationCase.answerPoints) : null,
    reviewed: evaluationCase.reviewed,
    updatedAt: evaluationCase.updatedAt,
  }));
}

export type EvaluationCaseUpdateInput = {
  question?: string;
  expectedTitles?: string[];
  expectedDocumentIds?: string[];
  expectedChunkIds?: string[];
  referenceAnswer?: string | null;
  answerPoints?: string[];
  reviewed?: boolean;
};

export async function updateEvaluationCase(
  knowledgeBaseId: string,
  evaluationSetId: string,
  caseId: string,
  input: EvaluationCaseUpdateInput,
): Promise<EvaluationCaseSummary> {
  await requireKnowledgeBase(knowledgeBaseId);
  const existing = await prisma.evaluationCase.findFirst({
    where: { id: caseId, evaluationSet: { id: evaluationSetId, knowledgeBaseId } },
  });
  if (!existing) {
    throw new Error("候选题不存在或不属于当前评测集。");
  }

  const data = {
    ...(input.question !== undefined ? { question: input.question } : {}),
    ...(input.expectedTitles !== undefined ? { expectedTitles: json(input.expectedTitles) } : {}),
    ...(input.expectedDocumentIds !== undefined ? { expectedDocumentIds: json(input.expectedDocumentIds) } : {}),
    ...(input.expectedChunkIds !== undefined ? { expectedChunkIds: json(input.expectedChunkIds) } : {}),
    ...(input.referenceAnswer !== undefined ? { referenceAnswer: input.referenceAnswer } : {}),
    ...(input.answerPoints !== undefined ? { answerPoints: input.answerPoints.length > 0 ? json(input.answerPoints) : null } : {}),
    ...(input.reviewed !== undefined ? { reviewed: input.reviewed } : {}),
  };

  const updated = await prisma.evaluationCase.update({
    where: { id: existing.id },
    data,
  });

  await prisma.auditLog.create({
    data: {
      knowledgeBaseId,
      action: input.reviewed === true ? "evaluation-case-reviewed" : "evaluation-case-updated",
      targetType: "EvaluationCase",
      targetId: existing.id,
      beforeData: json({
        question: existing.question,
        expectedTitles: parseJsonArray(existing.expectedTitles),
        expectedDocumentIds: parseJsonArray(existing.expectedDocumentIds),
        expectedChunkIds: parseJsonArray(existing.expectedChunkIds),
        referenceAnswer: existing.referenceAnswer,
        answerPoints: existing.answerPoints ? parseJsonArray(existing.answerPoints) : null,
        reviewed: existing.reviewed,
      }),
      afterData: json({
        question: updated.question,
        expectedTitles: parseJsonArray(updated.expectedTitles),
        expectedDocumentIds: parseJsonArray(updated.expectedDocumentIds),
        expectedChunkIds: parseJsonArray(updated.expectedChunkIds),
        referenceAnswer: updated.referenceAnswer,
        answerPoints: updated.answerPoints ? parseJsonArray(updated.answerPoints) : null,
        reviewed: updated.reviewed,
      }),
    },
  });

  return {
    id: updated.id,
    externalId: updated.externalId,
    question: updated.question,
    expectedTitles: parseJsonArray(updated.expectedTitles),
    expectedDocumentIds: parseJsonArray(updated.expectedDocumentIds),
    expectedChunkIds: parseJsonArray(updated.expectedChunkIds),
    referenceAnswer: updated.referenceAnswer,
    answerPoints: updated.answerPoints ? parseJsonArray(updated.answerPoints) : null,
    reviewed: updated.reviewed,
    updatedAt: updated.updatedAt,
  };
}

export async function promoteEvaluationSetToReviewedRegression(knowledgeBaseId: string, evaluationSetId: string): Promise<{ id: string; kind: string }> {
  await requireKnowledgeBase(knowledgeBaseId);
  const evaluationSet = await prisma.evaluationSet.findFirst({
    where: { id: evaluationSetId, knowledgeBaseId },
    include: { cases: { select: { reviewed: true, answerPoints: true } } },
  });
  if (!evaluationSet) {
    throw new Error("评测集不存在或不属于当前知识库。");
  }
  if (evaluationSet.kind === EvaluationSetKind.REVIEWED_REGRESSION) {
    throw new Error("该评测集已是人工审核回归集。");
  }
  if (evaluationSet.cases.length === 0) {
    throw new Error("空评测集不能升级为人工审核回归集。");
  }
  const unreviewed = evaluationSet.cases.filter((evaluationCase) => !evaluationCase.reviewed);
  if (unreviewed.length > 0) {
    throw new Error(`仍有 ${unreviewed.length} 道候选题未完成人工审核。`);
  }
  const missingPoints = evaluationSet.cases.filter((evaluationCase) => !evaluationCase.answerPoints || evaluationCase.answerPoints === "[]");
  if (missingPoints.length > 0) {
    throw new Error(`仍有 ${missingPoints.length} 道题未填写答案要点，无法用于答案要点评分。`);
  }

  const updated = await prisma.evaluationSet.update({
    where: { id: evaluationSet.id },
    data: { kind: EvaluationSetKind.REVIEWED_REGRESSION },
    select: { id: true, kind: true },
  });

  await prisma.auditLog.create({
    data: {
      knowledgeBaseId,
      action: "evaluation-set-promoted",
      targetType: "EvaluationSet",
      targetId: updated.id,
      afterData: json({ kind: updated.kind, caseCount: evaluationSet.cases.length }),
    },
  });

  return updated;
}

export type EvaluationRunComparison = {
  base: EvaluationRunSummary | null;
  target: EvaluationRunSummary;
  metricsDelta: {
    hitAt1: number | null;
    hitAt3: number | null;
    hitAt5: number | null;
    recallAt5: number | null;
    mrr: number | null;
  };
  caseDeltas: Array<{
    externalId: string;
    question: string;
    base: { hitAt5: boolean; firstRelevantRank: number | null; failureReason: string | null } | null;
    target: { hitAt5: boolean; firstRelevantRank: number | null; failureReason: string | null };
    status: "improved" | "regressed" | "unchanged" | "new";
  }>;
};

function parseMetricsJson(metricsJson: string | null): Record<string, number> | null {
  if (!metricsJson) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(metricsJson);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, number>;
    }
  } catch {
    return null;
  }
  return null;
}

export async function compareEvaluationRuns(
  knowledgeBaseId: string,
  targetRunId: string,
  baseRunId?: string | null,
): Promise<EvaluationRunComparison> {
  await requireKnowledgeBase(knowledgeBaseId);
  const target = await prisma.evaluationRun.findFirst({
    where: { id: targetRunId, knowledgeBaseId },
    include: {
      evaluationSet: { select: { id: true } },
      results: { orderBy: { externalId: "asc" } },
    },
  });
  if (!target) {
    throw new Error("评测运行记录不存在。");
  }

  const baseRun = baseRunId
    ? await prisma.evaluationRun.findFirst({
        where: { id: baseRunId, knowledgeBaseId },
        include: { results: { orderBy: { externalId: "asc" } } },
      })
    : await prisma.evaluationRun.findFirst({
        where: {
          knowledgeBaseId,
          evaluationSetId: target.evaluationSet.id,
          id: { not: targetRunId },
          status: { in: [EvaluationRunStatus.SUCCEEDED, EvaluationRunStatus.PARTIAL] },
        },
        orderBy: { startedAt: "desc" },
        include: { results: { orderBy: { externalId: "asc" } } },
      });

  const summarize = (run: {
    id: string;
    status: EvaluationRunStatus;
    caseCount: number;
    completedCount: number;
    hitAt1Count: number;
    hitAt3Count: number;
    hitAt5Count: number;
    meanRecallAt5: number;
    meanReciprocalRank: number;
    startedAt: Date;
    finishedAt: Date | null;
    errorText: string | null;
  }): EvaluationRunSummary => ({
    id: run.id,
    status: run.status,
    caseCount: run.caseCount,
    completedCount: run.completedCount,
    hitAt1Count: run.hitAt1Count,
    hitAt3Count: run.hitAt3Count,
    hitAt5Count: run.hitAt5Count,
    meanRecallAt5: run.meanRecallAt5,
    meanReciprocalRank: run.meanReciprocalRank,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorText: run.errorText,
  });

  const baseMetrics = parseMetricsJson(baseRun?.metricsJson ?? null);
  const targetMetrics = parseMetricsJson(target.metricsJson);
  const delta = (key: string): number | null =>
    baseMetrics && targetMetrics ? Number(((targetMetrics[key] ?? 0) - (baseMetrics[key] ?? 0)).toFixed(4)) : null;

  const baseResults = new Map((baseRun?.results ?? []).map((result) => [result.externalId, result]));
  const caseDeltas: EvaluationRunComparison["caseDeltas"] = target.results.map((result) => {
    const baseResult = baseResults.get(result.externalId);
    const status: "improved" | "regressed" | "unchanged" | "new" = !baseResult
      ? "new"
      : baseResult.hitAt5 === result.hitAt5
        ? "unchanged"
        : result.hitAt5
          ? "improved"
          : "regressed";
    return {
      externalId: result.externalId,
      question: result.question,
      base: baseResult
        ? { hitAt5: baseResult.hitAt5, firstRelevantRank: baseResult.firstRelevantRank, failureReason: baseResult.failureReason }
        : null,
      target: { hitAt5: result.hitAt5, firstRelevantRank: result.firstRelevantRank, failureReason: result.failureReason },
      status,
    };
  });

  return {
    base: baseRun ? summarize(baseRun) : null,
    target: summarize(target),
    metricsDelta: {
      hitAt1: delta("hitAt1"),
      hitAt3: delta("hitAt3"),
      hitAt5: delta("hitAt5"),
      recallAt5: delta("recallAt5"),
      mrr: delta("mrr"),
    },
    caseDeltas,
  };
}

export type EvaluationExportPayload = {
  run: EvaluationRunSummary;
  evaluationSet: { name: string; kind: string };
  retrievalConfig: Record<string, unknown> | null;
  index: Record<string, unknown> | null;
  metrics: Record<string, number> | null;
  results: Array<EvaluationResultJson & {
    externalId: string;
    question: string;
    status: string;
    hitAt5: boolean;
    recallAt5: number;
    reciprocalRank: number;
    firstRelevantRank: number | null;
    failureReason: string | null;
    answerScore: Record<string, number> | null;
  }>;
};

export async function exportEvaluationRun(knowledgeBaseId: string, runId: string): Promise<EvaluationExportPayload> {
  await requireKnowledgeBase(knowledgeBaseId);
  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, knowledgeBaseId },
    include: { evaluationSet: { select: { name: true, kind: true } }, results: { orderBy: { externalId: "asc" } } },
  });
  if (!run) {
    throw new Error("评测运行记录不存在。");
  }

  const parseConfig = (value: string | null): Record<string, unknown> | null => {
    if (!value) return null;
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  return {
    run: {
      id: run.id,
      status: run.status,
      caseCount: run.caseCount,
      completedCount: run.completedCount,
      hitAt1Count: run.hitAt1Count,
      hitAt3Count: run.hitAt3Count,
      hitAt5Count: run.hitAt5Count,
      meanRecallAt5: run.meanRecallAt5,
      meanReciprocalRank: run.meanReciprocalRank,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      errorText: run.errorText,
    },
    evaluationSet: run.evaluationSet,
    retrievalConfig: parseConfig(run.retrievalConfigSnapshot),
    index: parseConfig(run.indexSnapshot),
    metrics: parseMetricsJson(run.metricsJson),
    results: run.results.map((result) => ({
      ...deserializeEvaluationResult(result),
      externalId: result.externalId,
      question: result.question,
      status: result.status,
      hitAt5: result.hitAt5,
      recallAt5: result.recallAt5,
      reciprocalRank: result.reciprocalRank,
      firstRelevantRank: result.firstRelevantRank,
      failureReason: result.failureReason,
      answerScore: result.answerScoreJson ? (JSON.parse(result.answerScoreJson) as Record<string, number>) : null,
    })),
  };
}

export function evaluationReportToCsv(payload: EvaluationExportPayload): string {
  const escape = (value: string | number | boolean | null | undefined): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = [
    "externalId",
    "question",
    "status",
    "hitAt5",
    "recallAt5",
    "reciprocalRank",
    "firstRelevantRank",
    "expectedTitles",
    "actualTitles",
    "failureReason",
    "answerScore",
  ];
  const rows = payload.results.map((result) =>
    [
      result.externalId,
      result.question,
      result.status,
      result.hitAt5,
      result.recallAt5,
      result.reciprocalRank,
      result.firstRelevantRank,
      result.expectedTitles.join(" | "),
      result.actualTitles.join(" | "),
      result.failureReason,
      result.answerScore ? JSON.stringify(result.answerScore) : "",
    ]
      .map(escape)
      .join(","),
  );
  return [header.map(escape).join(","), ...rows].join("\n");
}

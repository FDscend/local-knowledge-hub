import { requireKnowledgeBase } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";
import { RETRIEVAL_CONFIG, resolveRetrievalConfig, type RetrievalConfigOverrides } from "@/lib/rag";
import { enqueueAutoEvaluation } from "@/lib/tasks";

export type ProductionRetrievalConfig = Required<RetrievalConfigOverrides>;

export type RetrievalConfigChangeSummary = {
  id: string;
  kind: "APPLY" | "ROLLBACK";
  sourceRunId: string | null;
  before: ProductionRetrievalConfig;
  after: ProductionRetrievalConfig;
  reason: string | null;
  createdAt: Date;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseRetrievalConfig(value: string | null | undefined): ProductionRetrievalConfig {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      return {
        channelTopK: numberOr(record.channelTopK, RETRIEVAL_CONFIG.channelTopK),
        rrfK: numberOr(record.rrfK, RETRIEVAL_CONFIG.rrfK),
        mmrLambda: numberOr(record.mmrLambda, RETRIEVAL_CONFIG.mmrLambda),
        rrfScoreWeight: numberOr(record.rrfScoreWeight, RETRIEVAL_CONFIG.rrfScoreWeight),
      };
    }
  } catch {
    // 损坏的配置快照回退默认值，不影响检索链路。
  }
  return { ...RETRIEVAL_CONFIG };
}

export function sameRetrievalConfig(left: ProductionRetrievalConfig, right: ProductionRetrievalConfig): boolean {
  return (
    left.channelTopK === right.channelTopK &&
    left.rrfK === right.rrfK &&
    left.mmrLambda === right.mmrLambda &&
    left.rrfScoreWeight === right.rrfScoreWeight
  );
}

/** 当前生效的生产检索配置；未显式应用过时返回内置默认值。 */
export async function getProductionRetrievalConfig(knowledgeBaseId: string): Promise<ProductionRetrievalConfig> {
  const record = await prisma.retrievalConfig.findUnique({ where: { knowledgeBaseId } });
  if (!record) {
    return { ...RETRIEVAL_CONFIG };
  }
  return {
    channelTopK: record.channelTopK,
    rrfK: record.rrfK,
    mmrLambda: record.mmrLambda,
    rrfScoreWeight: record.rrfScoreWeight,
  };
}

function toChangeSummary(change: {
  id: string;
  kind: string;
  sourceRunId: string | null;
  beforeJson: string;
  afterJson: string;
  reason: string | null;
  createdAt: Date;
}): RetrievalConfigChangeSummary {
  return {
    id: change.id,
    kind: change.kind === "ROLLBACK" ? "ROLLBACK" : "APPLY",
    sourceRunId: change.sourceRunId,
    before: parseRetrievalConfig(change.beforeJson),
    after: parseRetrievalConfig(change.afterJson),
    reason: change.reason,
    createdAt: change.createdAt,
  };
}

/** 将一次已完成沙盒运行的覆盖参数应用为当前知识库的生产检索配置，并写入变更记录与审计。 */
export async function applyRetrievalConfig(
  knowledgeBaseId: string,
  sourceRunId: string,
  reason?: string | null,
): Promise<{ config: ProductionRetrievalConfig; change: RetrievalConfigChangeSummary }> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const run = await prisma.evaluationRun.findFirst({
    where: { id: sourceRunId, knowledgeBaseId: knowledgeBase.id },
    select: { id: true, status: true, isSandbox: true, configOverridesJson: true },
  });
  if (!run) {
    throw new Error("评测运行记录不存在或不属于当前知识库。");
  }
  if (run.status === "RUNNING") {
    throw new Error("评测运行尚未完成，不能应用其候选配置。");
  }
  if (!run.isSandbox || !run.configOverridesJson) {
    throw new Error("只有带覆盖参数的沙盒运行才能应用为生产配置。");
  }

  const before = await getProductionRetrievalConfig(knowledgeBase.id);
  const after = resolveRetrievalConfig({ ...before, ...parseRetrievalConfig(run.configOverridesJson) });
  if (sameRetrievalConfig(before, after)) {
    throw new Error("该候选配置与当前生产配置相同，无需应用。");
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.retrievalConfig.upsert({
      where: { knowledgeBaseId: knowledgeBase.id },
      create: {
        knowledgeBaseId: knowledgeBase.id,
        channelTopK: after.channelTopK,
        rrfK: after.rrfK,
        mmrLambda: after.mmrLambda,
        rrfScoreWeight: after.rrfScoreWeight,
        appliedFromRunId: run.id,
      },
      update: {
        channelTopK: after.channelTopK,
        rrfK: after.rrfK,
        mmrLambda: after.mmrLambda,
        rrfScoreWeight: after.rrfScoreWeight,
        appliedFromRunId: run.id,
      },
    });
    const change = await tx.retrievalConfigChange.create({
      data: {
        knowledgeBaseId: knowledgeBase.id,
        kind: "APPLY",
        sourceRunId: run.id,
        beforeJson: json(before),
        afterJson: json(after),
        reason: reason?.trim() || null,
      },
    });
    await tx.auditLog.create({
      data: {
        knowledgeBaseId: knowledgeBase.id,
        actor: "local-admin",
        action: "retrieval-config-applied",
        targetType: "EvaluationRun",
        targetId: run.id,
        beforeData: json(before),
        afterData: json({ ...after, reason: reason?.trim() || null }),
      },
    });
    return change;
  });

  return { config: after, change: toChangeSummary(created) };
}

/** 应用生产检索配置后自动排队一次冒烟评测（文档 8.4：检索权重变更后）。 */
export async function applyRetrievalConfigAndTriggerEvaluation(
  knowledgeBaseId: string,
  sourceRunId: string,
  reason?: string | null,
): Promise<{ config: ProductionRetrievalConfig; change: RetrievalConfigChangeSummary; queued: { id: string; deduplicated: boolean } }> {
  const result = await applyRetrievalConfig(knowledgeBaseId, sourceRunId, reason);
  const queued = await enqueueAutoEvaluation(knowledgeBaseId, `生产检索配置已应用（${sourceRunId.slice(0, 8)}）`);
  return { ...result, queued };
}

/**
 * 回滚生产检索配置：恢复到最近一次“应用”变更之前的状态；指定 changeId 时针对该次应用。
 * 仅当当前配置仍等于该次应用后的状态才允许回滚，避免重复回滚。
 */
export async function rollbackRetrievalConfig(
  knowledgeBaseId: string,
  changeId?: string,
): Promise<{ config: ProductionRetrievalConfig; change: RetrievalConfigChangeSummary }> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const current = await getProductionRetrievalConfig(knowledgeBase.id);
  const targetChange = await prisma.retrievalConfigChange.findFirst({
    where: { knowledgeBaseId: knowledgeBase.id, ...(changeId ? { id: changeId } : { kind: "APPLY" }) },
    orderBy: { createdAt: "desc" },
  });
  if (!targetChange) {
    throw new Error("没有可回滚的配置变更记录。");
  }
  if (targetChange.kind !== "APPLY") {
    throw new Error("只能回滚到一次“应用”变更之前的状态。");
  }
  const appliedAfter = parseRetrievalConfig(targetChange.afterJson);
  if (!sameRetrievalConfig(current, appliedAfter)) {
    throw new Error("当前生产配置已不是该次应用后的状态，不能重复回滚。");
  }

  const target = parseRetrievalConfig(targetChange.beforeJson);
  const created = await prisma.$transaction(async (tx) => {
    await tx.retrievalConfig.upsert({
      where: { knowledgeBaseId: knowledgeBase.id },
      create: {
        knowledgeBaseId: knowledgeBase.id,
        channelTopK: target.channelTopK,
        rrfK: target.rrfK,
        mmrLambda: target.mmrLambda,
        rrfScoreWeight: target.rrfScoreWeight,
        appliedFromRunId: null,
      },
      update: {
        channelTopK: target.channelTopK,
        rrfK: target.rrfK,
        mmrLambda: target.mmrLambda,
        rrfScoreWeight: target.rrfScoreWeight,
        appliedFromRunId: null,
      },
    });
    const change = await tx.retrievalConfigChange.create({
      data: {
        knowledgeBaseId: knowledgeBase.id,
        kind: "ROLLBACK",
        sourceRunId: targetChange.sourceRunId,
        beforeJson: json(current),
        afterJson: json(target),
      },
    });
    await tx.auditLog.create({
      data: {
        knowledgeBaseId: knowledgeBase.id,
        actor: "local-admin",
        action: "retrieval-config-rolled-back",
        targetType: "RetrievalConfigChange",
        targetId: targetChange.id,
        beforeData: json(current),
        afterData: json(target),
      },
    });
    return change;
  });

  return { config: target, change: toChangeSummary(created) };
}

export async function listRetrievalConfigChanges(knowledgeBaseId: string, take = 10): Promise<RetrievalConfigChangeSummary[]> {
  const changes = await prisma.retrievalConfigChange.findMany({
    where: { knowledgeBaseId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return changes.map(toChangeSummary);
}

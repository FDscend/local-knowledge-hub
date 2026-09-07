import "dotenv/config";

import { EvaluationSetKind } from "@prisma/client";

import { runEvaluationSet } from "../src/lib/evaluation";
import { prisma } from "../src/lib/prisma";
import {
  applyRetrievalConfig,
  getProductionRetrievalConfig,
  rollbackRetrievalConfig,
  sameRetrievalConfig,
} from "../src/lib/retrieval-config";

const KNOWLEDGE_BASE_ID = "default";
const SET_NAME = "__verify_apply_config__";

async function main(): Promise<void> {
  await prisma.evaluationSet.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, name: SET_NAME } });
  await prisma.retrievalConfigChange.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID } });
  await prisma.retrievalConfig.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID } });

  const before = await getProductionRetrievalConfig(KNOWLEDGE_BASE_ID);
  const evaluationSet = await prisma.evaluationSet.create({
    data: {
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      name: SET_NAME,
      description: "检索配置一键应用验证用临时评测集，验证后删除。",
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
    // 1. 沙盒复跑（覆盖 rrfK）。
    const sandboxRun = await runEvaluationSet(KNOWLEDGE_BASE_ID, evaluationSet.id, {
      configOverrides: { rrfK: 30 },
      isSandbox: true,
    });
    if (!sandboxRun.id) throw new Error("沙盒评测运行失败");

    // 2. 将沙盒配置应用为生产配置。
    const applied = await applyRetrievalConfig(KNOWLEDGE_BASE_ID, sandboxRun.id, "验证脚本临时应用");
    if (applied.config.rrfK !== 30 || applied.change.kind !== "APPLY") throw new Error("应用候选配置结果异常");
    const afterApply = await getProductionRetrievalConfig(KNOWLEDGE_BASE_ID);
    if (afterApply.rrfK !== 30) throw new Error("应用后生产配置未生效");

    // 3. 生产运行应使用新生产配置（快照中 rrfK=30）。
    const productionRun = await runEvaluationSet(KNOWLEDGE_BASE_ID, evaluationSet.id, {});
    const snapshot = await prisma.evaluationRun.findUnique({ where: { id: productionRun.id }, select: { retrievalConfigSnapshot: true } });
    const snapshotConfig = JSON.parse(snapshot?.retrievalConfigSnapshot ?? "{}") as { rrfK?: number; production?: { rrfK?: number } };
    if (snapshotConfig.rrfK !== 30 || snapshotConfig.production?.rrfK !== 30) {
      throw new Error(`生产运行未使用新配置: ${JSON.stringify(snapshotConfig)}`);
    }

    // 4. 再次应用同一沙盒运行应被拒绝（与生产配置相同）。
    let duplicateBlocked = false;
    try {
      await applyRetrievalConfig(KNOWLEDGE_BASE_ID, sandboxRun.id);
    } catch {
      duplicateBlocked = true;
    }
    if (!duplicateBlocked) throw new Error("重复应用相同配置应被拒绝");

    // 5. 回滚到应用前状态。
    const rolledBack = await rollbackRetrievalConfig(KNOWLEDGE_BASE_ID);
    if (rolledBack.change.kind !== "ROLLBACK" || !sameRetrievalConfig(rolledBack.config, before)) {
      throw new Error("回滚后配置未恢复到应用前状态");
    }
    const afterRollback = await getProductionRetrievalConfig(KNOWLEDGE_BASE_ID);
    if (!sameRetrievalConfig(afterRollback, before)) throw new Error("回滚后生产配置未生效");

    // 6. 重复回滚应被拒绝。
    let secondRollbackBlocked = false;
    try {
      await rollbackRetrievalConfig(KNOWLEDGE_BASE_ID);
    } catch {
      secondRollbackBlocked = true;
    }
    if (!secondRollbackBlocked) throw new Error("重复回滚应被拒绝");

    const changeCount = await prisma.retrievalConfigChange.count({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID } });
    if (changeCount !== 2) throw new Error(`变更历史数量异常: ${changeCount}`);

    console.log(JSON.stringify({
      status: "ok",
      before,
      sandboxMetrics: { hitAt5: sandboxRun.hitAt5Count, mrr: sandboxRun.meanReciprocalRank },
      applied: applied.config,
      productionRunUsesNewConfig: snapshotConfig.rrfK,
      duplicateApplyBlocked: "confirmed",
      rolledBack: rolledBack.config,
      secondRollbackBlocked: "confirmed",
      changeCount,
    }));
  } finally {
    await prisma.evaluationSet.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, name: SET_NAME } });
    await prisma.retrievalConfigChange.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID } });
    await prisma.retrievalConfig.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID } });
    await prisma.task.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, autoTriggered: true, kind: "AUTO_EVALUATION" } });
  }
}

void main().finally(async () => prisma.$disconnect());

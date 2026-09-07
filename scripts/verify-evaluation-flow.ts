import "dotenv/config";

import { EvaluationSetKind } from "@prisma/client";

import {
  compareEvaluationRuns,
  evaluationReportToCsv,
  exportEvaluationRun,
  listEvaluationCases,
  promoteEvaluationSetToReviewedRegression,
  runEvaluationSet,
  updateEvaluationCase,
} from "../src/lib/evaluation";
import { prisma } from "../src/lib/prisma";

const KNOWLEDGE_BASE_ID = "default";
const SET_NAME = "__verify_stage_c__";

async function main(): Promise<void> {
  // 清理上次未完成的验证数据，保证可重复执行。
  await prisma.evaluationSet.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, name: SET_NAME } });

  const evaluationSet = await prisma.evaluationSet.create({
    data: {
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      name: SET_NAME,
      description: "阶段 C 流程验证用临时评测集，验证后删除。",
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
    const cases = await listEvaluationCases(KNOWLEDGE_BASE_ID, evaluationSet.id);
    if (cases.length !== 2) throw new Error(`候选题列表数量异常: ${cases.length}`);

    // 未审核时升级必须被拒绝。
    let promoteBlocked = false;
    try {
      await promoteEvaluationSetToReviewedRegression(KNOWLEDGE_BASE_ID, evaluationSet.id);
    } catch {
      promoteBlocked = true;
    }
    if (!promoteBlocked) throw new Error("未审核评测集不应允许升级");

    // 逐题补充答案要点并标记已审核。
    for (const evaluationCase of cases) {
      await updateEvaluationCase(KNOWLEDGE_BASE_ID, evaluationSet.id, evaluationCase.id, {
        answerPoints: ["答案要点 A", "答案要点 B"],
        reviewed: true,
      });
    }

    const promoted = await promoteEvaluationSetToReviewedRegression(KNOWLEDGE_BASE_ID, evaluationSet.id);
    if (promoted.kind !== EvaluationSetKind.REVIEWED_REGRESSION) throw new Error("升级后类型不正确");

    // 沙盒复跑：覆盖 RRF 参数，确认指标可计算且不修改生产配置。
    const sandboxRun = await runEvaluationSet(KNOWLEDGE_BASE_ID, evaluationSet.id, {
      configOverrides: { rrfK: 30, channelTopK: 20, mmrLambda: 0.5 },
      isSandbox: true,
    });
    if (!sandboxRun.id) throw new Error("沙盒评测运行失败");

    const compared = await compareEvaluationRuns(KNOWLEDGE_BASE_ID, sandboxRun.id);
    if (!compared.target || compared.caseDeltas.length !== 2) throw new Error("运行对比结果异常");

    const exported = await exportEvaluationRun(KNOWLEDGE_BASE_ID, sandboxRun.id);
    const csv = evaluationReportToCsv(exported);
    if (exported.results.length !== 2 || !csv.startsWith('"externalId"')) throw new Error("报告导出结果异常");

    console.log(JSON.stringify({
      status: "ok",
      promoteBlocked: "confirmed",
      promoted: promoted.kind,
      sandboxRunStatus: sandboxRun.status,
      sandboxMetrics: { hitAt5: sandboxRun.hitAt5Count, mrr: sandboxRun.meanReciprocalRank },
      compareCaseCount: compared.caseDeltas.length,
      exportRows: exported.results.length,
    }));
  } finally {
    await prisma.evaluationSet.deleteMany({ where: { knowledgeBaseId: KNOWLEDGE_BASE_ID, name: SET_NAME } });
  }
}

void main().finally(async () => prisma.$disconnect());

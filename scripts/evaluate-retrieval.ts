import "dotenv/config";

import { ensureDefaultEvaluationSet, runEvaluationSet } from "../src/lib/evaluation";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "../src/lib/knowledge-base";
import { prisma } from "../src/lib/prisma";

function readKnowledgeBaseId(): string {
  return process.argv.find((argument) => argument.startsWith("--knowledgeBaseId="))?.slice("--knowledgeBaseId=".length).trim() || "default";
}

async function main(): Promise<void> {
  const knowledgeBaseId = readKnowledgeBaseId();
  if (knowledgeBaseId !== DEFAULT_KNOWLEDGE_BASE_ID) {
    throw new Error("默认自动候选评测集只属于默认收件箱；请先为当前知识库建立专属评测集。");
  }
  const evaluationSet = await ensureDefaultEvaluationSet(knowledgeBaseId);
  const result = await runEvaluationSet(knowledgeBaseId, evaluationSet.id);
  console.log(
    JSON.stringify({
      id: result.id,
      knowledgeBaseId,
      status: result.status,
      caseCount: result.caseCount,
      completedCount: result.completedCount,
      hitAt1: result.caseCount > 0 ? result.hitAt1Count / result.caseCount : 0,
      hitAt3: result.caseCount > 0 ? result.hitAt3Count / result.caseCount : 0,
      hitAt5: result.caseCount > 0 ? result.hitAt5Count / result.caseCount : 0,
      recallAt5: result.meanRecallAt5,
      mrr: result.meanReciprocalRank,
    }),
  );
}

void main().finally(async () => prisma.$disconnect());

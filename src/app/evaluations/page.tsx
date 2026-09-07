import Link from "next/link";

import { EvaluationComparePanel } from "@/components/EvaluationComparePanel";
import { EvaluationInitPanel } from "@/components/EvaluationInitPanel";
import { EvaluationPanel } from "@/components/EvaluationPanel";
import { EvaluationReviewPanel } from "@/components/EvaluationReviewPanel";
import { ensureDefaultEvaluationSet, listEvaluationRuns, listEvaluationSets } from "@/lib/evaluation";
import { DEFAULT_KNOWLEDGE_BASE_ID, requireKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type EvaluationPageProps = {
  searchParams: Promise<{ knowledgeBaseId?: string }>;
};

export default async function EvaluationPage({ searchParams }: EvaluationPageProps) {
  const { knowledgeBaseId } = await searchParams;
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  if (knowledgeBase.id === DEFAULT_KNOWLEDGE_BASE_ID) {
    await ensureDefaultEvaluationSet(knowledgeBase.id);
  }
  const [evaluationSets, runs] = await Promise.all([
    listEvaluationSets(knowledgeBase.id),
    listEvaluationRuns(knowledgeBase.id),
  ]);

  return (
    <div className="workspace-page evaluations-page">
      <header className="workspace-toolbar evaluations-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">QUALITY REGRESSION</p>
          <h2>评测</h2>
          <p className="muted-text">评测只运行当前知识库的检索链路，保存题目、证据、索引配置和每次运行结果。自动候选集不等同于人工审核准确率。</p>
        </div>
        <div className="workspace-toolbar-actions">
          <Link className="button secondary" href={`/knowledge-bases`}>知识库管理</Link>
        </div>
      </header>

      {evaluationSets.length > 0 ? (
        <>
          <EvaluationPanel
            knowledgeBaseId={knowledgeBase.id}
            evaluationSets={evaluationSets.map((evaluationSet) => ({
              id: evaluationSet.id,
              name: evaluationSet.name,
              description: evaluationSet.description,
              kind: evaluationSet.kind,
              caseCount: evaluationSet._count.cases,
            }))}
            initialRuns={runs.map((run) => ({
              id: run.id,
              status: run.status,
              caseCount: run.caseCount,
              completedCount: run.completedCount,
              hitAt1Count: run.hitAt1Count,
              hitAt3Count: run.hitAt3Count,
              hitAt5Count: run.hitAt5Count,
              meanRecallAt5: run.meanRecallAt5,
              meanReciprocalRank: run.meanReciprocalRank,
              startedAt: run.startedAt.toISOString(),
              finishedAt: run.finishedAt?.toISOString() ?? null,
              errorText: run.errorText,
            }))}
          />
          <EvaluationReviewPanel
            knowledgeBaseId={knowledgeBase.id}
            evaluationSets={evaluationSets.map((evaluationSet) => ({
              id: evaluationSet.id,
              name: evaluationSet.name,
              description: evaluationSet.description,
              kind: evaluationSet.kind,
              caseCount: evaluationSet._count.cases,
            }))}
          />
          <EvaluationComparePanel
            knowledgeBaseId={knowledgeBase.id}
            initialRuns={runs.map((run) => ({
              id: run.id,
              status: run.status,
              caseCount: run.caseCount,
              startedAt: run.startedAt.toISOString(),
              finishedAt: run.finishedAt?.toISOString() ?? null,
              hitAt5Count: run.hitAt5Count,
              meanRecallAt5: run.meanRecallAt5,
              meanReciprocalRank: run.meanReciprocalRank,
            }))}
          />
        </>
      ) : (
        <EvaluationInitPanel knowledgeBaseId={knowledgeBase.id} />
      )}
    </div>
  );
}

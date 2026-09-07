"use client";

import { useState, useTransition } from "react";

type EvaluationRunSummary = {
  id: string;
  status: string;
  caseCount: number;
  startedAt: string;
  finishedAt: string | null;
  hitAt5Count: number;
  meanRecallAt5: number;
  meanReciprocalRank: number;
};

type ComparisonPayload = {
  base: (EvaluationRunSummary & { startedAt: string; finishedAt: string | null }) | null;
  target: EvaluationRunSummary & { startedAt: string; finishedAt: string | null };
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDelta(value: number | null): string {
  if (value === null) {
    return "无基线";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function deltaClass(value: number | null): string {
  if (value === null || value === 0) {
    return "";
  }
  return value > 0 ? "delta-improved" : "delta-regressed";
}

export function EvaluationComparePanel({
  knowledgeBaseId,
  initialRuns,
}: {
  knowledgeBaseId: string;
  initialRuns: EvaluationRunSummary[];
}) {
  const [targetRunId, setTargetRunId] = useState(initialRuns[0]?.id ?? "");
  const [baseRunId, setBaseRunId] = useState("");
  const [comparison, setComparison] = useState<ComparisonPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const compare = () => {
    if (!targetRunId) {
      setError("请先选择要对比的运行。");
      return;
    }
    setError(null);
    startTransition(() => {
      void (async () => {
        try {
          const baseParam = baseRunId ? `&baseRunId=${encodeURIComponent(baseRunId)}` : "";
          const response = await fetch(`/api/evaluations/${encodeURIComponent(targetRunId)}/compare?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}${baseParam}`);
          const payload = (await response.json()) as ComparisonPayload & { error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "对比失败。");
          }
          setComparison(payload);
        } catch (compareError) {
          setError(compareError instanceof Error ? compareError.message : "对比失败。");
        }
      })();
    });
  };

  const regressedCount = (comparison?.caseDeltas ?? []).filter((item) => item.status === "regressed").length;
  const improvedCount = (comparison?.caseDeltas ?? []).filter((item) => item.status === "improved").length;

  return (
    <section className="workspace-section">
      <div className="workspace-section-heading">
        <div>
          <p className="section-kicker">当前版本对比上一次通过版本</p>
          <h3>历史版本对比</h3>
        </div>
        <span className="badge">仅当前知识库</span>
      </div>
      <p className="muted-text">选择两次评测运行对比指标与逐题变化；基线留空时自动取同一评测集最近一次通过（SUCCEEDED / PARTIAL）的运行。</p>

      <div className="inline-actions evaluation-controls">
        <label className="field compact-field">
          <span>当前运行</span>
          <select className="input" value={targetRunId} onChange={(event) => setTargetRunId(event.target.value)}>
            {initialRuns.map((run) => (
              <option key={run.id} value={run.id}>{formatDate(run.startedAt)} · {run.caseCount} 题 · Hit@5 {run.caseCount ? formatPercent(run.hitAt5Count / run.caseCount) : "-"}</option>
            ))}
          </select>
        </label>
        <label className="field compact-field">
          <span>基线运行（可选）</span>
          <select className="input" value={baseRunId} onChange={(event) => setBaseRunId(event.target.value)}>
            <option value="">自动取最近一次通过</option>
            {initialRuns.map((run) => (
              <option key={run.id} value={run.id}>{formatDate(run.startedAt)} · {run.caseCount} 题 · Hit@5 {run.caseCount ? formatPercent(run.hitAt5Count / run.caseCount) : "-"}</option>
            ))}
          </select>
        </label>
        <button type="button" className="button primary" onClick={compare} disabled={isPending || !targetRunId}>
          {isPending ? "对比中..." : "对比"}
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}

      {comparison ? (
        <>
          <div className="card-grid evaluation-summary-grid">
            <article className="stat-card">
              <p className="stat-label">Hit@5 变化</p>
              <p className={`stat-value ${deltaClass(comparison.metricsDelta.hitAt5)}`}>{formatDelta(comparison.metricsDelta.hitAt5)}</p>
            </article>
            <article className="stat-card">
              <p className="stat-label">Recall@5 变化</p>
              <p className={`stat-value ${deltaClass(comparison.metricsDelta.recallAt5)}`}>{formatDelta(comparison.metricsDelta.recallAt5)}</p>
            </article>
            <article className="stat-card">
              <p className="stat-label">MRR 变化</p>
              <p className={`stat-value ${deltaClass(comparison.metricsDelta.mrr)}`}>{formatDelta(comparison.metricsDelta.mrr)}</p>
            </article>
          </div>
          <div className="inline-actions">
            <span className="badge">改进 {improvedCount} 题</span>
            <span className="badge">回归 {regressedCount} 题</span>
            {comparison.base ? (
              <span className="field-helper">基线：{formatDate(comparison.base.startedAt)}</span>
            ) : (
              <span className="field-helper">当前评测集暂无基线运行。</span>
            )}
          </div>
          <div className="evaluation-case-list">
            {comparison.caseDeltas.map((item) => (
              <article key={item.externalId} className="evaluation-case-row"
                data-status={item.status === "regressed" ? "miss" : item.status === "improved" || item.status === "unchanged" ? "hit" : "hit"}>
                <div className="evaluation-case-heading">
                  <strong>{item.externalId}</strong>
                  <span className="badge">
                    {item.status === "improved" ? "改进" : item.status === "regressed" ? "回归" : item.status === "new" ? "新增题" : "不变"}
                  </span>
                </div>
                <p>{item.question}</p>
                <dl className="evaluation-case-meta">
                  <div>
                    <dt>基线</dt>
                    <dd>{item.base ? `${item.base.hitAt5 ? "Top 5 命中" : "未命中"}${item.base.failureReason ? ` · ${item.base.failureReason}` : ""}` : "无"}</dd>
                  </div>
                  <div>
                    <dt>当前</dt>
                    <dd>{`${item.target.hitAt5 ? "Top 5 命中" : "未命中"}${item.target.failureReason ? ` · ${item.target.failureReason}` : ""}`}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className="muted-text">选择运行后点击“对比”查看指标变化与逐题回归。</p>
      )}
    </section>
  );
}

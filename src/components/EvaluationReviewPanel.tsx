"use client";

import { useState, useTransition } from "react";

import { useApiKeySettings } from "@/components/ApiKeySettingsProvider";
import { RUNTIME_LLM_API_KEY_HEADER, RUNTIME_LLM_BASE_URL_HEADER, RUNTIME_LLM_MODEL_HEADER } from "@/lib/runtime-keys";

type EvaluationSetSummary = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  caseCount: number;
};

type EvaluationCaseSummary = {
  id: string;
  externalId: string;
  question: string;
  expectedTitles: string[];
  expectedDocumentIds: string[];
  expectedChunkIds: string[];
  referenceAnswer: string | null;
  answerPoints: string[] | null;
  reviewed: boolean;
  updatedAt: string;
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function EvaluationReviewPanel({
  knowledgeBaseId,
  evaluationSets,
}: {
  knowledgeBaseId: string;
  evaluationSets: EvaluationSetSummary[];
}) {
  const { llmApiKey, llmBaseURL, llmModel } = useApiKeySettings();
  const [selectedSetId, setSelectedSetId] = useState(evaluationSets[0]?.id ?? "");
  const [cases, setCases] = useState<EvaluationCaseSummary[] | null>(null);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    question: string;
    expectedTitles: string;
    expectedDocumentIds: string;
    expectedChunkIds: string;
    answerPoints: string;
    referenceAnswer: string;
  }>({ question: "", expectedTitles: "", expectedDocumentIds: "", expectedChunkIds: "", answerPoints: "", referenceAnswer: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [replaceExisting, setReplaceExisting] = useState(true);

  const loadCases = (evaluationSetId: string) => {
    setError(null);
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/evaluations/sets/${encodeURIComponent(evaluationSetId)}/cases?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
          const payload = (await response.json()) as { cases?: EvaluationCaseSummary[]; error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "候选题列表读取失败。");
          }
          setCases(payload.cases ?? []);
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "候选题列表读取失败。");
          setCases(null);
        }
      })();
    });
  };

  const selectSet = (evaluationSetId: string) => {
    setSelectedSetId(evaluationSetId);
    setCases(null);
    setEditingCaseId(null);
    loadCases(evaluationSetId);
  };

  const startEdit = (evaluationCase: EvaluationCaseSummary) => {
    setEditingCaseId(evaluationCase.id);
    setDraft({
      question: evaluationCase.question,
      expectedTitles: evaluationCase.expectedTitles.join("\n"),
      expectedDocumentIds: evaluationCase.expectedDocumentIds.join("\n"),
      expectedChunkIds: evaluationCase.expectedChunkIds.join("\n"),
      answerPoints: (evaluationCase.answerPoints ?? []).join("\n"),
      referenceAnswer: evaluationCase.referenceAnswer ?? "",
    });
    setError(null);
    setMessage(null);
  };

  const saveCase = (evaluationCase: EvaluationCaseSummary, reviewed: boolean) => {
    setError(null);
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const payload = {
            knowledgeBaseId,
            evaluationSetId: selectedSetId,
            ...(editingCaseId === evaluationCase.id
              ? {
                  question: draft.question.trim() || evaluationCase.question,
                  expectedTitles: splitLines(draft.expectedTitles),
                  expectedDocumentIds: splitLines(draft.expectedDocumentIds),
                  expectedChunkIds: splitLines(draft.expectedChunkIds),
                  answerPoints: splitLines(draft.answerPoints),
                  referenceAnswer: draft.referenceAnswer.trim() || null,
                }
              : {}),
            reviewed,
          };
          const response = await fetch(`/api/evaluations/cases/${encodeURIComponent(evaluationCase.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const updated = (await response.json()) as EvaluationCaseSummary & { error?: string };
          if (!response.ok) {
            throw new Error(updated.error || "候选题保存失败。");
          }
          setCases((current) => (current ?? []).map((item) => (item.id === updated.id ? { ...updated, updatedAt: updated.updatedAt } : item)));
          setEditingCaseId(null);
          setMessage(reviewed ? `已标记「${updated.externalId}」为已审核。` : `已保存「${updated.externalId}」。`);
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : "候选题保存失败。");
        }
      })();
    });
  };

  const promote = () => {
    setError(null);
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/evaluations/sets/${encodeURIComponent(selectedSetId)}/promote`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ knowledgeBaseId }),
          });
          const payload = (await response.json()) as { kind?: string; error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "评测集升级失败。");
          }
          setMessage("评测集已升级为人工审核回归集，可对外展示质量指标。");
          setCases((current) => current);
        } catch (promoteError) {
          setError(promoteError instanceof Error ? promoteError.message : "评测集升级失败。");
        }
      })();
    });
  };

  const generateCandidates = () => {
    setError(null);
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const headers: HeadersInit = { "Content-Type": "application/json" };
          if (llmApiKey) headers[RUNTIME_LLM_API_KEY_HEADER] = llmApiKey;
          if (llmBaseURL) headers[RUNTIME_LLM_BASE_URL_HEADER] = llmBaseURL;
          if (llmModel) headers[RUNTIME_LLM_MODEL_HEADER] = llmModel;
          const response = await fetch("/api/evaluations/generate-candidates", {
            method: "POST",
            headers,
            body: JSON.stringify({ knowledgeBaseId, targetSetId: selectedSetId, maxCases: 10, maxDocuments: 10, replaceExisting }),
          });
          const payload = (await response.json()) as { evaluationSetId?: string; createdCases?: number; replacedCases?: number; error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "候选题生成失败。");
          }
          setMessage(replaceExisting
            ? `已替换 ${payload.replacedCases ?? 0} 道旧候选题，生成 ${payload.createdCases} 道新题（均未审核）。`
            : `已生成 ${payload.createdCases} 道候选题并追加到当前评测集，均为未审核状态。`);
          loadCases(selectedSetId);
        } catch (generateError) {
          setError(generateError instanceof Error ? generateError.message : "候选题生成失败。");
        }
      })();
    });
  };

  const selectedSet = evaluationSets.find((evaluationSet) => evaluationSet.id === selectedSetId) ?? evaluationSets[0];
  const reviewedCount = (cases ?? []).filter((evaluationCase) => evaluationCase.reviewed).length;
  const allReviewed = (cases?.length ?? 0) > 0 && reviewedCount === (cases?.length ?? 0);

  return (
    <section className="workspace-section" id="evaluation-cases">
      <div className="workspace-section-heading">
        <div>
          <p className="section-kicker">人工审核回归集</p>
          <h3>候选题审核</h3>
        </div>
        <span className="badge">{selectedSet?.kind === "REVIEWED_REGRESSION" ? "人工审核回归集" : "自动候选集"}</span>
      </div>
      <p className="muted-text">逐题核对问题、预期证据与答案要点后标记“已审核”；全部审核完成后可升级为人工审核回归集，其指标才可对外展示。审核动作不会被自动跳过。</p>

      <div className="inline-actions evaluation-controls">
        <label className="field compact-field">
          <span>评测集</span>
          <select className="input" value={selectedSet?.id} onChange={(event) => selectSet(event.target.value)}>
            {evaluationSets.map((evaluationSet) => (
              <option key={evaluationSet.id} value={evaluationSet.id}>{evaluationSet.name}（{evaluationSet.caseCount} 题）</option>
            ))}
          </select>
        </label>
        <button type="button" className="button secondary" onClick={() => selectSet(selectedSet?.id ?? "")} disabled={isPending}>
          加载候选题
        </button>
        <button type="button" className="button secondary" onClick={generateCandidates} disabled={isPending || !selectedSetId}>
          {isPending ? "生成中..." : "按文档生成候选题"}
        </button>
        <label className="field compact-field check-field">
          <input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />
          <span>替换现有未审核候选题</span>
        </label>
      </div>
      <p className="field-helper">“按文档生成候选题”使用 LLM 从当前知识库文档章节生成题目与答案要点，需要已配置 LLM API Key；生成结果始终为未审核状态。勾选“替换”会先删除当前评测集的未审核旧题（已审核题目不受影响），取消勾选则追加。人工审核回归集不允许追加或替换。</p>

      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="field-helper">{message}</p> : null}

      {cases === null ? (
        <p className="muted-text">选择评测集后加载候选题列表。</p>
      ) : cases.length === 0 ? (
        <p className="muted-text">当前评测集没有候选题。</p>
      ) : (
        <>
          <div className="inline-actions">
            <span className="badge">审核进度 {reviewedCount}/{cases.length}</span>
            {selectedSet?.kind !== "REVIEWED_REGRESSION" && allReviewed ? (
              <button type="button" className="button primary" onClick={promote} disabled={isPending}>
                升级为人工审核回归集
              </button>
            ) : selectedSet?.kind === "REVIEWED_REGRESSION" ? (
              <span className="badge">已升级，指标可对外展示</span>
            ) : null}
          </div>

          <div className="evaluation-case-list">
            {cases.map((evaluationCase) => {
              const isEditing = editingCaseId === evaluationCase.id;
              return (
                <article key={evaluationCase.id} className="evaluation-case-row" data-status={evaluationCase.reviewed ? "hit" : "miss"}>
                  <div className="evaluation-case-heading">
                    <strong>{evaluationCase.externalId}</strong>
                    <span className="badge">{evaluationCase.reviewed ? "已审核" : "未审核"}</span>
                  </div>

                  {isEditing ? (
                    <div className="review-form">
                      <label className="field">
                        <span>问题</span>
                        <textarea className="input" rows={2} value={draft.question} onChange={(event) => setDraft({ ...draft, question: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>预期文档标题（每行一个）</span>
                        <textarea className="input" rows={2} value={draft.expectedTitles} onChange={(event) => setDraft({ ...draft, expectedTitles: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>预期文档 ID（每行一个，可选）</span>
                        <textarea className="input" rows={2} value={draft.expectedDocumentIds} onChange={(event) => setDraft({ ...draft, expectedDocumentIds: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>预期切片 ID（每行一个，可选；留空则为文档级判定）</span>
                        <textarea className="input" rows={2} value={draft.expectedChunkIds} onChange={(event) => setDraft({ ...draft, expectedChunkIds: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>答案要点（每行一个，评分依据）</span>
                        <textarea className="input" rows={3} value={draft.answerPoints} onChange={(event) => setDraft({ ...draft, answerPoints: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>参考答案（可选）</span>
                        <textarea className="input" rows={3} value={draft.referenceAnswer} onChange={(event) => setDraft({ ...draft, referenceAnswer: event.target.value })} />
                      </label>
                      <div className="inline-actions">
                        <button type="button" className="button secondary" onClick={() => saveCase(evaluationCase, false)} disabled={isPending}>保存</button>
                        <button type="button" className="button primary" onClick={() => saveCase(evaluationCase, true)} disabled={isPending}>保存并标记已审核</button>
                        <button type="button" className="button" onClick={() => setEditingCaseId(null)} disabled={isPending}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p>{evaluationCase.question}</p>
                      <dl className="evaluation-case-meta">
                        <div><dt>预期文档</dt><dd>{evaluationCase.expectedTitles.join(" / ") || "未设置"}</dd></div>
                        <div><dt>判定粒度</dt><dd>{evaluationCase.expectedChunkIds.length > 0 ? `切片级（${evaluationCase.expectedChunkIds.length} 个预期切片）` : "文档级"}</dd></div>
                        <div><dt>答案要点</dt><dd>{evaluationCase.answerPoints?.join(" / ") || "未填写"}</dd></div>
                        <div><dt>更新时间</dt><dd>{formatDate(evaluationCase.updatedAt)}</dd></div>
                      </dl>
                      <div className="inline-actions">
                        <button type="button" className="button secondary" onClick={() => startEdit(evaluationCase)} disabled={isPending}>编辑</button>
                        {!evaluationCase.reviewed ? (
                          <button type="button" className="button primary" onClick={() => saveCase(evaluationCase, true)} disabled={isPending}>标记已审核</button>
                        ) : null}
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

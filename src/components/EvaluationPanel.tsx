"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type CSSProperties } from "react";

import { useApiKeySettings } from "@/components/ApiKeySettingsProvider";
import { AppAuxiliaryPanel } from "@/components/AppAuxiliaryPanel";
import { evaluationDebugPanelWidthStore } from "@/lib/panel-width";
import {
  RUNTIME_EMBEDDING_API_KEY_HEADER,
  RUNTIME_EMBEDDING_BASE_URL_HEADER,
  RUNTIME_EMBEDDING_MODEL_HEADER,
  RUNTIME_LLM_API_KEY_HEADER,
  RUNTIME_LLM_BASE_URL_HEADER,
  RUNTIME_LLM_MODEL_HEADER,
} from "@/lib/runtime-keys";

type EvaluationSetSummary = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  caseCount: number;
};

type EvaluationRunSummary = {
  id: string;
  status: string;
  caseCount: number;
  completedCount: number;
  hitAt1Count: number;
  hitAt3Count: number;
  hitAt5Count: number;
  meanRecallAt5: number;
  meanReciprocalRank: number;
  startedAt: string;
  finishedAt: string | null;
  errorText: string | null;
};

type ProductionRetrievalConfig = {
  channelTopK: number;
  rrfK: number;
  mmrLambda: number;
  rrfScoreWeight: number;
};

type RetrievalConfigChangeSummary = {
  id: string;
  kind: "APPLY" | "ROLLBACK";
  sourceRunId: string | null;
  before: ProductionRetrievalConfig;
  after: ProductionRetrievalConfig;
  reason: string | null;
  createdAt: string;
};

type RetrievalConfigPanelState = {
  production: ProductionRetrievalConfig;
  changes: RetrievalConfigChangeSummary[];
};

type EvaluationRunDetail = EvaluationRunSummary & {
  evaluationSet: { name: string; kind: string };
  isSandbox: boolean;
  configOverridesJson: string | null;
  results: Array<{
    id: string;
    externalId: string;
    question: string;
    expectedTitles: string;
    expectedChunkIds: string;
    actualTitles: string;
    retrievalMode: string | null;
    firstRelevantRank: number | null;
    hitAt5: boolean;
    recallAt5: number;
    reciprocalRank: number;
    failureReason: string | null;
    generatedAnswer: string | null;
    answerScore: Record<string, number> | null;
    answerScoreStatus: string;
    parsed: {
      retrievalDebug: {
        query: string;
        terms: string[];
        queryMode: string;
        llmKeywords: string[] | null;
        semanticQuery: string | null;
        queryUnderstandingWarning: string | null;
        lexicalCandidateCount: number;
        vectorCandidateCount: number;
        mergedCandidateCount: number;
        finalLimit: number;
        candidates: Array<{
          chunkId: string;
          title: string;
          sectionPath: string;
          score: number;
          rrfScore: number;
          lexicalRank: number | null;
          vectorRank: number | null;
          initialRank: number;
          selectedRank: number | null;
          selectionReason: string | null;
        }>;
      };
    };
  }>;
};

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function parseTitles(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function statusLabel(status: string): string {
  return status === "SUCCEEDED" ? "完成" : status === "PARTIAL" ? "部分完成" : status === "FAILED" ? "失败" : "运行中";
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseConfigJson(value: string | null): Partial<ProductionRetrievalConfig> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as Partial<Record<keyof ProductionRetrievalConfig, unknown>>;
    const result: Partial<ProductionRetrievalConfig> = {};
    const keys: Array<keyof ProductionRetrievalConfig> = ["channelTopK", "rrfK", "mmrLambda", "rrfScoreWeight"];
    for (const key of keys) {
      const candidate = parsed[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        result[key] = candidate;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function sameRetrievalConfig(left: ProductionRetrievalConfig, right: ProductionRetrievalConfig): boolean {
  return (
    left.channelTopK === right.channelTopK &&
    left.rrfK === right.rrfK &&
    left.mmrLambda === right.mmrLambda &&
    left.rrfScoreWeight === right.rrfScoreWeight
  );
}

function formatConfig(config: ProductionRetrievalConfig): string {
  return `channelTopK=${config.channelTopK}, rrfK=${config.rrfK}, mmrLambda=${config.mmrLambda}, rrfScoreWeight=${config.rrfScoreWeight}`;
}

function formatConfigDiff(before: ProductionRetrievalConfig, after: ProductionRetrievalConfig): string {
  const labels: Array<[keyof ProductionRetrievalConfig, string]> = [
    ["channelTopK", "channelTopK"],
    ["rrfK", "rrfK"],
    ["mmrLambda", "mmrLambda"],
    ["rrfScoreWeight", "rrfScoreWeight"],
  ];
  return labels
    .filter(([key]) => before[key] !== after[key])
    .map(([key, label]) => `${label} ${before[key]} → ${after[key]}`)
    .join("，");
}

const SANDBOX_PARAMS_KEY = "evaluation-sandbox-params";

function loadSandboxParams(): { channelTopK: string; rrfK: string; mmrLambda: string; rrfScoreWeight: string } {
  if (typeof window === "undefined") {
    return { channelTopK: "", rrfK: "", mmrLambda: "", rrfScoreWeight: "" };
  }
  try {
    const raw = window.localStorage.getItem(SANDBOX_PARAMS_KEY);
    if (!raw) {
      return { channelTopK: "", rrfK: "", mmrLambda: "", rrfScoreWeight: "" };
    }
    const parsed = JSON.parse(raw) as Partial<{ channelTopK: unknown; rrfK: unknown; mmrLambda: unknown; rrfScoreWeight: unknown }>;
    const asString = (value: unknown): string => (typeof value === "string" ? value : "");
    return {
      channelTopK: asString(parsed.channelTopK),
      rrfK: asString(parsed.rrfK),
      mmrLambda: asString(parsed.mmrLambda),
      rrfScoreWeight: asString(parsed.rrfScoreWeight),
    };
  } catch {
    return { channelTopK: "", rrfK: "", mmrLambda: "", rrfScoreWeight: "" };
  }
}

export function EvaluationPanel({
  knowledgeBaseId,
  evaluationSets,
  initialRuns,
}: {
  knowledgeBaseId: string;
  evaluationSets: EvaluationSetSummary[];
  initialRuns: EvaluationRunSummary[];
}) {
  const { embeddingApiKey, embeddingBaseURL, embeddingModel, llmApiKey, llmBaseURL, llmModel } = useApiKeySettings();
  const [selectedSetId, setSelectedSetId] = useState(evaluationSets[0]?.id ?? "");
  const [runs, setRuns] = useState(initialRuns);
  const [selectedRun, setSelectedRun] = useState<EvaluationRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [showSandbox, setShowSandbox] = useState(false);
  const [sandboxParams, setSandboxParams] = useState<{ channelTopK: string; rrfK: string; mmrLambda: string; rrfScoreWeight: string }>(() => loadSandboxParams());
  const [scoringMessage, setScoringMessage] = useState<string | null>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState<{ completed: number; total: number } | null>(null);
  const [configPanel, setConfigPanel] = useState<RetrievalConfigPanelState | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  // 右侧检索调试面板：选中题目 id，null 时面板完全收起
  const [debugCaseId, setDebugCaseId] = useState<string | null>(null);
  const [evalResizing, setEvalResizing] = useState(false);
  const evalResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const evalPanelWidth = useSyncExternalStore(
    evaluationDebugPanelWidthStore.subscribe,
    evaluationDebugPanelWidthStore.read,
    evaluationDebugPanelWidthStore.getServer,
  );

  // 加载当前知识库的生产检索配置与变更历史。
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`/api/evaluations/retrieval-config?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as RetrievalConfigPanelState;
        setConfigPanel(payload);
      } catch {
        // 配置面板加载失败不阻塞评测主流程。
      }
    })();
  }, [knowledgeBaseId]);

  const refreshConfigPanel = async () => {
    try {
      const response = await fetch(`/api/evaluations/retrieval-config?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
      if (!response.ok) {
        return;
      }
      setConfigPanel((await response.json()) as RetrievalConfigPanelState);
    } catch {
      // 刷新失败时保留旧数据。
    }
  };

  // 沙盒参数持久化到 localStorage，刷新页面不丢失。
  const updateSandboxParams = (next: typeof sandboxParams) => {
    setSandboxParams(next);
    try {
      window.localStorage.setItem(SANDBOX_PARAMS_KEY, JSON.stringify(next));
    } catch {
      // localStorage 不可用时静默忽略，参数仅在当前会话生效。
    }
  };

  const runEvaluation = () => {
    setError(null);
    setSelectedRun(null);
    startTransition(() => {
      void (async () => {
        try {
          const headers: HeadersInit = { "Content-Type": "application/json" };
          if (embeddingApiKey) headers[RUNTIME_EMBEDDING_API_KEY_HEADER] = embeddingApiKey;
          if (embeddingBaseURL) headers[RUNTIME_EMBEDDING_BASE_URL_HEADER] = embeddingBaseURL;
          if (embeddingModel) headers[RUNTIME_EMBEDDING_MODEL_HEADER] = embeddingModel;
          if (llmApiKey) headers[RUNTIME_LLM_API_KEY_HEADER] = llmApiKey;
          if (llmBaseURL) headers[RUNTIME_LLM_BASE_URL_HEADER] = llmBaseURL;
          if (llmModel) headers[RUNTIME_LLM_MODEL_HEADER] = llmModel;

          const channelTopK = parsePositiveInt(sandboxParams.channelTopK);
          const rrfK = parsePositiveInt(sandboxParams.rrfK);
          const mmrLambda = parseFloat(sandboxParams.mmrLambda);
          const rrfScoreWeight = parseFloat(sandboxParams.rrfScoreWeight);
          const isSandbox = showSandbox && (channelTopK !== null || rrfK !== null || (!Number.isNaN(mmrLambda) && sandboxParams.mmrLambda.trim() !== "") || (!Number.isNaN(rrfScoreWeight) && sandboxParams.rrfScoreWeight.trim() !== ""));

          const response = await fetch("/api/evaluations", {
            method: "POST",
            headers,
            body: JSON.stringify({
              knowledgeBaseId,
              evaluationSetId: selectedSetId,
              ...(channelTopK !== null ? { channelTopK } : {}),
              ...(rrfK !== null ? { rrfK } : {}),
              ...(!Number.isNaN(mmrLambda) && sandboxParams.mmrLambda.trim() !== "" ? { mmrLambda } : {}),
              ...(!Number.isNaN(rrfScoreWeight) && sandboxParams.rrfScoreWeight.trim() !== "" ? { rrfScoreWeight } : {}),
              isSandbox,
            }),
          });
          const payload = (await response.json()) as EvaluationRunSummary & { error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "评测运行失败。");
          }
          setRuns((current) => [payload, ...current.filter((run) => run.id !== payload.id)]);
          // 后台评测：轮询运行状态显示进度，完成后加载详情。
          setRunningRunId(payload.id);
          setRunProgress({ completed: 0, total: payload.caseCount });
          void pollRunProgress(payload.id, payload.caseCount);
        } catch (runError) {
          setError(runError instanceof Error ? runError.message : "评测运行失败。");
        }
      })();
    });
  };

  const pollRunProgress = async (runId: string, total: number) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const response = await fetch(`/api/evaluations/${encodeURIComponent(runId)}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
        if (!response.ok) {
          continue;
        }
        const detail = (await response.json()) as EvaluationRunDetail;
        setRunProgress({ completed: detail.completedCount, total: detail.caseCount });
        setRuns((current) => current.map((run) => (run.id === runId ? {
          ...run,
          status: detail.status,
          completedCount: detail.completedCount,
          hitAt1Count: detail.hitAt1Count,
          hitAt3Count: detail.hitAt3Count,
          hitAt5Count: detail.hitAt5Count,
          meanRecallAt5: detail.meanRecallAt5,
          meanReciprocalRank: detail.meanReciprocalRank,
          finishedAt: detail.finishedAt,
          errorText: detail.errorText,
        } : run)));
        if (detail.status !== "RUNNING") {
          setRunningRunId(null);
          setRunProgress(null);
          await loadRun(runId);
          return;
        }
      } catch {
        // 轮询失败继续尝试，避免偶发网络错误中断进度显示。
      }
    }
    setRunningRunId(null);
    setRunProgress(null);
  };

  const deleteSelectedRuns = () => {
    if (selectedRunIds.size === 0) {
      return;
    }
    setError(null);
    setScoringMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const response = await fetch("/api/evaluations", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ knowledgeBaseId, runIds: Array.from(selectedRunIds) }),
          });
          const payload = (await response.json()) as { deleted?: number; missing?: number; error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "评测记录删除失败。");
          }
          const deletedCount = payload.deleted ?? 0;
          const missingCount = payload.missing ?? 0;
          setRuns((current) => current.filter((run) => !selectedRunIds.has(run.id)));
          setSelectedRunIds(new Set());
          if (selectedRun && selectedRunIds.has(selectedRun.id)) {
            setSelectedRun(null);
          }
          setScoringMessage(missingCount > 0
            ? `已删除 ${deletedCount} 条评测记录；${missingCount} 条记录已不存在（可能已被清理），已跳过。`
            : `已删除 ${deletedCount} 条评测记录。`);
        } catch (deleteError) {
          setError(deleteError instanceof Error ? deleteError.message : "评测记录删除失败。");
        }
      })();
    });
  };

  const toggleRunSelection = (runId: string) => {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };

  const loadRun = async (runId: string) => {
    setError(null);
    try {
      const response = await fetch(`/api/evaluations/${encodeURIComponent(runId)}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
      const payload = (await response.json()) as EvaluationRunDetail & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "评测详情读取失败。");
      }
      setSelectedRun(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "评测详情读取失败。");
    }
  };

  const selectedSet = evaluationSets.find((evaluationSet) => evaluationSet.id === selectedSetId) ?? evaluationSets[0];

  // 管理员确认后，将一次已完成沙盒运行的覆盖参数应用为生产检索配置。
  const applySelectedConfig = () => {
    if (!selectedRun || !configPanel) {
      setError("无法应用：请先查看运行详情。");
      return;
    }
    const overrides = parseConfigJson(selectedRun.configOverridesJson);
    const target = { ...configPanel.production, ...overrides };
    const diff = formatConfigDiff(configPanel.production, target);
    if (!diff) {
      setError("该沙盒运行没有可应用的覆盖参数。");
      return;
    }
    const confirmed = window.confirm(
      `将沙盒运行 ${selectedRun.id.slice(0, 8)} 的候选配置应用到当前知识库生产检索？\n\n当前：${formatConfig(configPanel.production)}\n新配置：${formatConfig(target)}\n\n应用后请重跑评测验证；如需撤销可随时回滚。`,
    );
    if (!confirmed) {
      return;
    }
    setError(null);
    setConfigMessage(null);
    setConfigBusy(true);
    void (async () => {
      try {
        const response = await fetch("/api/evaluations/apply-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ knowledgeBaseId, runId: selectedRun.id }),
        });
        const payload = (await response.json()) as { config?: ProductionRetrievalConfig; error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "应用检索配置失败。");
        }
        setConfigMessage(`已应用候选配置：${formatConfig(payload.config!)}。建议立即重跑一次评测确认指标无回归。`);
        await refreshConfigPanel();
      } catch (applyError) {
        setError(applyError instanceof Error ? applyError.message : "应用检索配置失败。");
      } finally {
        setConfigBusy(false);
      }
    })();
  };

  // 回滚到最近一次“应用”之前的生产配置。
  const rollbackConfig = () => {
    if (!configPanel) {
      return;
    }
    const latestApply = configPanel.changes.find((change) => change.kind === "APPLY");
    if (!latestApply || !sameRetrievalConfig(latestApply.after, configPanel.production)) {
      setConfigMessage("当前没有可回滚的配置变更（生产配置已是初始或已回滚状态）。");
      return;
    }
    const confirmed = window.confirm(
      `将生产检索配置回滚到 ${latestApply.createdAt.slice(0, 16).replace("T", " ")} 之前的状态？\n\n当前：${formatConfig(configPanel.production)}\n回滚后：${formatConfig(latestApply.before)}`,
    );
    if (!confirmed) {
      return;
    }
    setError(null);
    setConfigMessage(null);
    setConfigBusy(true);
    void (async () => {
      try {
        const response = await fetch("/api/evaluations/rollback-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ knowledgeBaseId }),
        });
        const payload = (await response.json()) as { config?: ProductionRetrievalConfig; error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "回滚检索配置失败。");
        }
        setConfigMessage(`已回滚生产检索配置：${formatConfig(payload.config!)}`);
        await refreshConfigPanel();
      } catch (rollbackError) {
        setError(rollbackError instanceof Error ? rollbackError.message : "回滚检索配置失败。");
      } finally {
        setConfigBusy(false);
      }
    })();
  };

  const scoreAnswers = () => {
    if (!selectedRun) {
      return;
    }
    setError(null);
    setScoringMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const headers: HeadersInit = { "Content-Type": "application/json" };
          if (llmApiKey) headers[RUNTIME_LLM_API_KEY_HEADER] = llmApiKey;
          if (llmBaseURL) headers[RUNTIME_LLM_BASE_URL_HEADER] = llmBaseURL;
          if (llmModel) headers[RUNTIME_LLM_MODEL_HEADER] = llmModel;
          const response = await fetch(`/api/evaluations/${encodeURIComponent(selectedRun.id)}/score`, {
            method: "POST",
            headers,
            body: JSON.stringify({ knowledgeBaseId }),
          });
          const payload = (await response.json()) as { scored?: number; skipped?: number; failed?: number; skippedReason?: string | null; error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "答案要点评分失败。");
          }
          setScoringMessage(`评分完成：成功 ${payload.scored ?? 0} 题，跳过 ${payload.skipped ?? 0} 题，失败 ${payload.failed ?? 0} 题。${payload.skippedReason ?? ""}`);
          await loadRun(selectedRun.id);
        } catch (scoreError) {
          setError(scoreError instanceof Error ? scoreError.message : "答案要点评分失败。");
        }
      })();
    });
  };

  const debugResult = selectedRun && debugCaseId ? (selectedRun.results.find((result) => result.id === debugCaseId) ?? null) : null;

  function handleDebugResizeStart(event: React.PointerEvent<HTMLDivElement>): void {
    evalResizeStartRef.current = { startX: event.clientX, startWidth: evalPanelWidth };
    setEvalResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleDebugResizeMove(event: React.PointerEvent<HTMLDivElement>): void {
    const start = evalResizeStartRef.current;
    if (!start) {
      return;
    }
    // resizer 位于辅助栏左边缘：向右拖表示面板变窄
    evaluationDebugPanelWidthStore.update(start.startWidth - (event.clientX - start.startX));
  }

  function handleDebugResizeEnd(event: React.PointerEvent<HTMLDivElement>): void {
    if (evalResizeStartRef.current) {
      evalResizeStartRef.current = null;
      setEvalResizing(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleDebugResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      evaluationDebugPanelWidthStore.update(evalPanelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      evaluationDebugPanelWidthStore.update(evalPanelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      evaluationDebugPanelWidthStore.update(evaluationDebugPanelWidthStore.max);
    } else if (event.key === "End") {
      event.preventDefault();
      evaluationDebugPanelWidthStore.update(evaluationDebugPanelWidthStore.min);
    }
  }

  return (
    <div
      className={`evaluation-layout${evalResizing ? " is-panel-resizing" : ""}`}
      style={{ "--auxiliary-panel-width": `${evalPanelWidth}px` } as CSSProperties}
    >
      <div className="evaluation-main-column">
      <section className="workspace-section evaluation-launcher" id="evaluation-run">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">可复现运行</p>
            <h3>运行检索评测</h3>
            <p className="muted-text">当前首版只计算文档 / 切片证据的 `Hit@K`、`Recall@5` 和 `MRR`，不会调用 LLM，也不会修改知识内容。</p>
          </div>
        </div>
        <div className="inline-actions evaluation-controls">
          <label className="field compact-field">
            <span>评测集</span>
            <select className="input" value={selectedSet?.id} onChange={(event) => setSelectedSetId(event.target.value)}>
              {evaluationSets.map((evaluationSet) => (
                <option key={evaluationSet.id} value={evaluationSet.id}>{evaluationSet.name}（{evaluationSet.caseCount} 题）</option>
              ))}
            </select>
          </label>
          <button type="button" className="button primary" onClick={runEvaluation} disabled={isPending || !selectedSetId || runningRunId !== null}>
            {runningRunId !== null ? "评测运行中..." : isPending ? "提交中..." : "运行评测"}
          </button>
        </div>
        {runningRunId !== null && runProgress ? (
          <div className="evaluation-progress">
            <span className="spinner" aria-hidden="true" />
            <span>评测运行中：{runProgress.completed}/{runProgress.total} 题</span>
            <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={runProgress.total} aria-valuenow={runProgress.completed}>
              <div className="progress-fill" style={{ width: `${runProgress.total > 0 ? (runProgress.completed / runProgress.total) * 100 : 0}%` }} />
            </div>
          </div>
        ) : null}
        <details className="evaluation-debug" open={showSandbox}>
          <summary onClick={(event) => { event.preventDefault(); setShowSandbox((current) => !current); }}>
            检索配置沙盒（可选，覆盖 RRF / 通道 TopK / MMR 参数复跑）
          </summary>
          <div className="inline-actions evaluation-controls">
            <label className="field compact-field" title="词法（FTS5）与向量两条检索通道各取的前 N 个候选数。调大提升查全但更慢更杂，调小更快但可能漏答案。默认 30。">
              <span>channelTopK</span>
              <input className="input" type="number" min={5} max={100} placeholder="默认 30" value={sandboxParams.channelTopK}
                onChange={(event) => updateSandboxParams({ ...sandboxParams, channelTopK: event.target.value })} />
            </label>
            <label className="field compact-field" title="RRF 融合常数 k：决定词法与向量两路排名融合时的平滑程度。k 越小，排名靠前的候选优势越大；k 越大，两路结果越平均。默认 60。">
              <span>rrfK</span>
              <input className="input" type="number" min={1} max={200} placeholder="默认 60" value={sandboxParams.rrfK}
                onChange={(event) => updateSandboxParams({ ...sandboxParams, rrfK: event.target.value })} />
            </label>
            <label className="field compact-field" title="MMR 多样性系数 λ（0-1）：λ 越接近 1 越看重相关度（允许结果集中在同一文档），越接近 0 越强制结果分散到不同文档。默认 0.7。">
              <span>mmrLambda</span>
              <input className="input" type="number" min={0} max={1} step={0.05} placeholder="默认 0.7" value={sandboxParams.mmrLambda}
                onChange={(event) => updateSandboxParams({ ...sandboxParams, mmrLambda: event.target.value })} />
            </label>
            <label className="field compact-field" title="RRF 分数在最终排序中的权重：最终得分 = 有界词法命中加分（0~6）+ RRF 分数 × 本系数。scoreChunk 重构后两个通道已同量级：默认 1 时词法主导；需要让向量排名参与竞争时建议 100~200，通常无需更大。默认 1。">
              <span>rrfScoreWeight</span>
              <input className="input" type="number" min={0} max={10000} step={10} placeholder="默认 1" value={sandboxParams.rrfScoreWeight}
                onChange={(event) => updateSandboxParams({ ...sandboxParams, rrfScoreWeight: event.target.value })} />
            </label>
          </div>
          <p className="field-helper">沙盒运行不会修改生产检索配置，只记录覆盖参数并可与基线运行对比。鼠标悬停参数名可查看说明；参数会自动保存，刷新页面不丢失；留空表示沿用当前配置。</p>
        </details>
        {selectedSet ? <p className="field-helper">{selectedSet.description} · 类型：{selectedSet.kind === "REVIEWED_REGRESSION" ? "人工审核回归集" : "自动候选集"}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="workspace-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">当前生效</p>
            <h3>生产检索配置</h3>
          </div>
          <div className="inline-actions">
            <span className="badge">仅当前知识库</span>
            <button type="button" className="button secondary" onClick={rollbackConfig} disabled={configBusy || !configPanel}>
              {configBusy ? "处理中..." : "回滚到上一配置"}
            </button>
          </div>
        </div>
        {configPanel ? (
          <>
            <div className="inline-actions evaluation-controls">
              <span className="badge">channelTopK={configPanel.production.channelTopK}</span>
              <span className="badge">rrfK={configPanel.production.rrfK}</span>
              <span className="badge">mmrLambda={configPanel.production.mmrLambda}</span>
              <span className="badge">rrfScoreWeight={configPanel.production.rrfScoreWeight}</span>
            </div>
            <p className="field-helper">该配置作为所有检索（评测与问答）的基准，沙盒覆盖参数只叠加在其上。应用新配置与回滚都会写入变更历史与审计日志，可随时恢复上一次状态。</p>
            {configMessage ? <p className="field-helper">{configMessage}</p> : null}
            {error ? <p className="error-text">{error}</p> : null}
            {configPanel.changes.length > 0 ? (
              <div className="evaluation-run-list">
                {configPanel.changes.map((change) => {
                  const diff = formatConfigDiff(change.before, change.after);
                  return (
                    <div key={change.id} className="evaluation-run-row-wrap">
                      <div className="evaluation-run-row">
                        <span className="evaluation-run-main">
                          <strong>{change.kind === "APPLY" ? "应用配置" : "回滚配置"}</strong>
                          <span>{formatDate(change.createdAt)}{change.sourceRunId ? ` · 来源运行 ${change.sourceRunId.slice(0, 8)}` : ""}</span>
                        </span>
                        <span className="evaluation-metric-strip">
                          <span>{diff}</span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted-text">尚未应用过检索配置，当前为内置默认值。</p>
            )}
          </>
        ) : (
          <p className="muted-text">生产检索配置读取中...</p>
        )}
      </section>

      <section className="workspace-section" id="evaluation-history">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">历史记录</p>
            <h3>评测运行</h3>
          </div>
          <div className="inline-actions">
            <span className="badge">仅当前知识库</span>
            {selectedRunIds.size > 0 ? (
              <button type="button" className="button danger" onClick={deleteSelectedRuns} disabled={isPending}>
                删除选中（{selectedRunIds.size}）
              </button>
            ) : null}
          </div>
        </div>
        {runs.length === 0 ? (
          <p className="muted-text">还没有评测运行记录。</p>
        ) : (
          <div className="evaluation-run-list">
            {runs.map((run) => (
              <div key={run.id} className={`evaluation-run-row-wrap ${selectedRunIds.has(run.id) ? "is-selected" : ""}`}>
                <label className="run-select-box" title="选择后可批量删除">
                  <input type="checkbox" checked={selectedRunIds.has(run.id)} onChange={() => toggleRunSelection(run.id)} />
                </label>
                <button type="button" className="evaluation-run-row" onClick={() => void loadRun(run.id)}>
                  <span className="evaluation-run-main">
                    <strong>{statusLabel(run.status)}</strong>
                    <span>{formatDate(run.startedAt)}</span>
                  </span>
                  <span className="evaluation-metric-strip">
                    <span>Hit@1 {run.caseCount ? `${run.hitAt1Count}/${run.caseCount}` : "-"}</span>
                    <span>Hit@3 {run.caseCount ? `${run.hitAt3Count}/${run.caseCount}` : "-"}</span>
                    <span>Hit@5 {run.caseCount ? `${run.hitAt5Count}/${run.caseCount}` : "-"}</span>
                    <span>Recall@5 {formatPercent(run.meanRecallAt5)}</span>
                    <span>MRR {run.meanReciprocalRank.toFixed(3)}</span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {selectedRun ? (
        <section className="workspace-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">运行详情 · {selectedRun.evaluationSet.name}{selectedRun.isSandbox ? " · 沙盒" : ""}</p>
              <h3>失败定位</h3>
            </div>
            <span className="badge">{statusLabel(selectedRun.status)} · {formatDate(selectedRun.finishedAt || selectedRun.startedAt)}</span>
          </div>
          <div className="inline-actions">
            {selectedRun.isSandbox && selectedRun.configOverridesJson ? (
              <button type="button" className="button primary" onClick={applySelectedConfig} disabled={configBusy}>
                {configBusy ? "处理中..." : "应用候选配置到生产"}
              </button>
            ) : null}
            <button type="button" className="button secondary" onClick={() => void scoreAnswers()} disabled={isPending}>
              {isPending ? "评分中..." : "答案要点评分"}
            </button>
            <a className="button secondary" href={`/api/evaluations/${encodeURIComponent(selectedRun.id)}/export?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}&format=json`} download>导出 JSON</a>
            <a className="button secondary" href={`/api/evaluations/${encodeURIComponent(selectedRun.id)}/export?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}&format=csv`} download>导出 CSV</a>
          </div>
          <p className="field-helper">“应用候选配置到生产”仅在沙盒运行上出现：管理员确认后，该运行的覆盖参数将成为当前知识库的生产检索基准，并写入变更历史与审计日志，可随时回滚。“答案要点评分”仅对已审核且填写了答案要点的题目生效，使用 LLM 生成回答并按 rubric（忠实性 / 引用覆盖率 / 问题完成度 / 答案要点覆盖）打分；未配置 LLM Key 时跳过并标记。</p>
          {scoringMessage ? <p className="field-helper">{scoringMessage}</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
          <div className="card-grid evaluation-summary-grid">
            <article className="stat-card"><p className="stat-label">Hit@5</p><p className="stat-value">{selectedRun.caseCount ? formatPercent(selectedRun.hitAt5Count / selectedRun.caseCount) : "-"}</p></article>
            <article className="stat-card"><p className="stat-label">Recall@5</p><p className="stat-value">{formatPercent(selectedRun.meanRecallAt5)}</p></article>
            <article className="stat-card"><p className="stat-label">MRR</p><p className="stat-value">{selectedRun.meanReciprocalRank.toFixed(3)}</p></article>
          </div>
          {selectedRun.errorText ? <p className="error-text">运行错误：{selectedRun.errorText}</p> : null}
          <div className="evaluation-case-list">
            {selectedRun.results.map((result) => {
              const expectedTitles = parseTitles(result.expectedTitles);
              const actualTitles = parseTitles(result.actualTitles);
              const expectedChunkIds = parseTitles(result.expectedChunkIds);
              const debug = result.parsed.retrievalDebug;
              const chunkLevel = expectedChunkIds.length > 0;
              return (
                <article key={result.id} className="evaluation-case-row" data-status={result.hitAt5 ? "hit" : "miss"}>
                  <div className="evaluation-case-heading">
                    <strong>{result.externalId}</strong>
                    <span className="badge">{result.hitAt5 ? "Top 5 命中" : "Top 5 未命中"}</span>
                  </div>
                  <p>{result.question}</p>
                  <dl className="evaluation-case-meta">
                    <div><dt>预期文档</dt><dd>{expectedTitles.join(" / ") || "未解析"}</dd></div>
                    <div><dt>实际文档</dt><dd>{actualTitles.join(" / ") || "无"}</dd></div>
                    <div><dt>判定粒度</dt><dd>{chunkLevel ? `切片级（预期 ${expectedChunkIds.length} 个切片，Top 5 命中 ${debug.candidates.slice(0, 5).filter((candidate) => expectedChunkIds.includes(candidate.chunkId)).length} 个）` : "文档级"}</dd></div>
                    <div><dt>首个相关排名</dt><dd>{result.firstRelevantRank ?? "未命中"}</dd></div>
                    <div><dt>Recall@5</dt><dd>{formatPercent(result.recallAt5)}</dd></div>
                  </dl>
                  {result.answerScore ? (
                    <div className="evaluation-answer-score">
                      <span>答案要点评分：忠实 {result.answerScore.faithfulness?.toFixed(1) ?? "-"} · 引用 {result.answerScore.citationCoverage?.toFixed(1) ?? "-"} · 完成 {result.answerScore.completion?.toFixed(1) ?? "-"} · 要点 {result.answerScore.answerPointCoverage?.toFixed(1) ?? "-"} · 总分 {result.answerScore.total?.toFixed(2) ?? "-"}</span>
                      {result.generatedAnswer ? <p className="field-helper">生成回答：{result.generatedAnswer.slice(0, 200)}{result.generatedAnswer.length > 200 ? "…" : ""}</p> : null}
                    </div>
                  ) : null}
                  {result.failureReason ? <p className="field-helper">原因：{result.failureReason}</p> : null}
                  <button
                    type="button"
                    className={`evaluation-debug-toggle${debugCaseId === result.id ? " is-active" : ""}`}
                    onClick={() => setDebugCaseId((current) => (current === result.id ? null : result.id))}
                  >
                    检索调试：词法 {debug.lexicalCandidateCount} · 向量 {debug.vectorCandidateCount} · 融合 {debug.mergedCandidateCount} · {debug.queryMode === "llm" ? "LLM 查询理解" : "确定性回退"}
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      </div>
      {debugResult ? (
        <>
          <div
            className={`evaluation-panel-resizer${evalResizing ? " is-resizing" : ""}`}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="调整检索调试面板宽度"
            aria-valuemin={evaluationDebugPanelWidthStore.min}
            aria-valuemax={evaluationDebugPanelWidthStore.max}
            aria-valuenow={evalPanelWidth}
            onPointerDown={handleDebugResizeStart}
            onPointerMove={handleDebugResizeMove}
            onPointerUp={handleDebugResizeEnd}
            onPointerCancel={handleDebugResizeEnd}
            onKeyDown={handleDebugResizeKeyDown}
          />
          <AppAuxiliaryPanel kicker="RETRIEVAL DEBUG" title={`检索调试 · ${debugResult.externalId}`} note={debugResult.hitAt5 ? "Top 5 命中" : "Top 5 未命中"}>
            <p className="field-helper">题目：{debugResult.question}</p>
            <p className="field-helper">
              {debugResult.parsed.retrievalDebug.queryMode === "llm" && debugResult.parsed.retrievalDebug.llmKeywords ? (
                <>LLM 关键词：{debugResult.parsed.retrievalDebug.llmKeywords.join("、")}<br /></>
              ) : null}
              {debugResult.parsed.retrievalDebug.semanticQuery ? (
                <>语义查询：{debugResult.parsed.retrievalDebug.semanticQuery}<br /></>
              ) : null}
              {debugResult.parsed.retrievalDebug.queryUnderstandingWarning ? (
                <><span className="error-text">{debugResult.parsed.retrievalDebug.queryUnderstandingWarning}</span><br /></>
              ) : null}
              查询词：{debugResult.parsed.retrievalDebug.terms.join("、") || "原问题"} · 最终取 {debugResult.parsed.retrievalDebug.finalLimit} 条
            </p>
            <div className="evaluation-debug-list">
              {[...debugResult.parsed.retrievalDebug.candidates]
                .sort((left, right) => {
                  const leftSelected = left.selectedRank ?? Number.POSITIVE_INFINITY;
                  const rightSelected = right.selectedRank ?? Number.POSITIVE_INFINITY;
                  if (leftSelected !== rightSelected) {
                    return leftSelected - rightSelected;
                  }
                  return left.initialRank - right.initialRank;
                })
                .slice(0, 10)
                .map((candidate) => (
                  <div key={candidate.chunkId} className={`evaluation-debug-candidate${candidate.selectedRank ? " is-selected" : ""}`}>
                    <strong>{candidate.title}</strong>
                    <span>{candidate.sectionPath}</span>
                    <span>初始 #{candidate.initialRank} · 词法 {candidate.lexicalRank ?? "-"} · 向量 {candidate.vectorRank ?? "-"} · RRF {candidate.rrfScore.toFixed(4)}</span>
                    <span>{candidate.selectedRank ? `MMR 入选 #${candidate.selectedRank}` : "未进入最终结果"}{candidate.selectionReason ? ` · ${candidate.selectionReason}` : ""}</span>
                  </div>
                ))}
            </div>
          </AppAuxiliaryPanel>
        </>
      ) : null}
    </div>
  );
}

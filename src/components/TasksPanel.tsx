"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cancelTaskAction, retryTaskAction } from "@/app/actions";

export type TaskListItem = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  kind: string;
  status: string;
  autoTriggered: boolean;
  attempts: number;
  maxAttempts: number;
  payloadJson: string | null;
  resultJson: string | null;
  errorText: string | null;
  progressCurrent: number;
  progressTotal: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const KIND_LABELS: Record<string, string> = {
  EVALUATION: "评测运行",
  AUTO_EVALUATION: "自动评测",
  CANDIDATE_GENERATION: "候选题生成",
  VECTOR_INDEX: "向量索引重建",
  INGEST: "导入",
};

const STATUS_LABELS: Record<string, string> = {
  QUEUED: "排队中",
  RUNNING: "运行中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  CANCELLED: "已取消",
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

function resultSummary(resultJson: string | null): string | null {
  if (!resultJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    if (parsed.skipped === true) {
      return `跳过：${typeof parsed.reason === "string" ? parsed.reason : "无原因"}`;
    }
    if (typeof parsed.hitAt5Count === "number" && typeof parsed.caseCount === "number") {
      return `Hit@5 ${parsed.hitAt5Count}/${parsed.caseCount} · Recall@5 ${formatPercent(typeof parsed.meanRecallAt5 === "number" ? parsed.meanRecallAt5 : 0)} · MRR ${typeof parsed.meanReciprocalRank === "number" ? parsed.meanReciprocalRank.toFixed(3) : "-"}`;
    }
    if (typeof parsed.indexedCount === "number") {
      return `已索引 ${parsed.indexedCount} 个切片 · 维度 ${typeof parsed.dimensions === "number" ? parsed.dimensions : "-"} · 模型 ${typeof parsed.model === "string" ? parsed.model : "-"}`;
    }
    if (typeof parsed.importedCount === "number") {
      return `新增 ${parsed.importedCount} 份${typeof parsed.errorCount === "number" ? ` · 失败 ${parsed.errorCount}` : ""}`;
    }
    return null;
  } catch {
    return null;
  }
}

// 详情展开用：尽力美化 JSON，无法解析时原样展示。
function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function TasksPanel({ tasks }: { tasks: TaskListItem[] }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 行内展开的任务详情（payload / 完整结果），自动刷新不丢失
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 多选删除的任务记录
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 存在未完成任务时每 5 秒自动刷新服务端快照；全部结束即停止。
  useEffect(() => {
    const hasActive = tasks.some((task) => task.status === "QUEUED" || task.status === "RUNNING");
    if (refreshTimerRef.current !== null) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (hasActive) {
      refreshTimerRef.current = setInterval(() => router.refresh(), 5_000);
    }
    return () => {
      if (refreshTimerRef.current !== null) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [tasks, router]);

  const retry = (task: TaskListItem) => {
    startTransition(() => {
      const formData = new FormData();
      formData.set("taskId", task.id);
      formData.set("knowledgeBaseId", task.knowledgeBaseId);
      void retryTaskAction(formData);
    });
  };

  const cancel = (task: TaskListItem) => {
    startTransition(() => {
      const formData = new FormData();
      formData.set("taskId", task.id);
      formData.set("knowledgeBaseId", task.knowledgeBaseId);
      void cancelTaskAction(formData);
    });
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  // 多选删除任务记录（参考评测历史的多选删除），成功后刷新服务端快照。
  const deleteSelectedTasks = () => {
    if (selectedTaskIds.size === 0) {
      return;
    }
    setDeleteError(null);
    setDeleteMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const response = await fetch("/api/tasks", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ knowledgeBaseId: tasks[0]?.knowledgeBaseId ?? "default", taskIds: Array.from(selectedTaskIds) }),
          });
          const payload = (await response.json()) as { deleted?: number; missing?: number; error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "任务记录删除失败。");
          }
          const deletedCount = payload.deleted ?? 0;
          const missingCount = payload.missing ?? 0;
          setSelectedTaskIds(new Set());
          setDeleteMessage(
            missingCount > 0
              ? `已删除 ${deletedCount} 条任务记录；${missingCount} 条记录已不存在（可能已被清理），已跳过。`
              : `已删除 ${deletedCount} 条任务记录。`,
          );
          router.refresh();
        } catch (deleteTaskError) {
          setDeleteError(deleteTaskError instanceof Error ? deleteTaskError.message : "任务记录删除失败。");
        }
      })();
    });
  };

  if (tasks.length === 0) {
    return (
      <section className="workspace-section">
        <p className="muted-text">当前筛选条件下没有任务记录。导入、评测、向量索引重建与自动评测都会在这里留下记录。</p>
      </section>
    );
  }

  return (
    <section className="workspace-section tasks-section">
      <div className="workspace-section-heading">
        <div>
          <p className="section-kicker">QUEUE</p>
          <h3>任务记录（{tasks.length}）</h3>
        </div>
        <span className="badge">失败自动重试一次 · 可手动重试 / 取消排队</span>
        <button type="button" className="button danger" onClick={deleteSelectedTasks} disabled={isPending || selectedTaskIds.size === 0}>
          删除选中（{selectedTaskIds.size}）
        </button>
      </div>
      {deleteMessage ? <p className="task-action-notice">{deleteMessage}</p> : null}
      {deleteError ? <p className="task-action-error">{deleteError}</p> : null}
      <div className="evaluation-run-list">
        {tasks.map((task) => {
          const summary = resultSummary(task.resultJson);
          const isQueued = task.status === "QUEUED";
          const isFailed = task.status === "FAILED";
          const isExpanded = expandedId === task.id;
          const showProgress = task.progressTotal > 0 && task.status === "RUNNING";
          return (
            <div key={task.id} className="evaluation-run-row-wrap" data-status={task.status === "FAILED" ? "miss" : task.status === "SUCCEEDED" ? "hit" : undefined}>
              <div
                className="evaluation-run-row task-row-clickable"
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-label={isExpanded ? "收起任务详情" : "展开任务详情"}
                onClick={() => setExpandedId((current) => (current === task.id ? null : task.id))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setExpandedId((current) => (current === task.id ? null : task.id));
                  }
                }}
              >
                <label
                  className="run-select-box"
                  title="选择后可批量删除"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selectedTaskIds.has(task.id)}
                    onChange={() => toggleTaskSelection(task.id)}
                  />
                </label>
                <span className="evaluation-run-main">
                  <strong>{KIND_LABELS[task.kind] ?? task.kind}{task.autoTriggered ? " · 自动触发" : ""}</strong>
                  <span>{task.knowledgeBaseName} · {formatDate(task.createdAt)}{task.finishedAt ? ` → ${formatDate(task.finishedAt)}` : ""}</span>
                </span>
                <span className="evaluation-metric-strip">
                  <span className="badge">{STATUS_LABELS[task.status] ?? task.status}</span>
                  {task.attempts > 0 ? <span>第 {task.attempts + 1} 次尝试</span> : null}
                  {summary ? <span>{summary}</span> : null}
                </span>
                <span className={`task-row-caret${isExpanded ? " is-open" : ""}`} aria-hidden="true">▾</span>
              </div>
              {showProgress ? (
                <div className="evaluation-progress">
                  <span className="spinner" aria-hidden="true" />
                  <span>任务执行中：{task.progressCurrent}/{task.progressTotal}</span>
                  <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={task.progressTotal} aria-valuenow={task.progressCurrent}>
                    <div className="progress-fill" style={{ width: `${task.progressTotal > 0 ? (task.progressCurrent / task.progressTotal) * 100 : 0}%` }} />
                  </div>
                </div>
              ) : null}
              {task.errorText ? <p className="error-text">失败原因：{task.errorText}</p> : null}
              {isExpanded ? (
                <div className="task-detail-expanded">
                  {task.payloadJson ? (
                    <div className="task-detail-block">
                      <strong>任务参数</strong>
                      <pre>{formatJson(task.payloadJson)}</pre>
                    </div>
                  ) : null}
                  {task.resultJson ? (
                    <div className="task-detail-block">
                      <strong>结果数据</strong>
                      <pre>{formatJson(task.resultJson)}</pre>
                    </div>
                  ) : null}
                  {!task.payloadJson && !task.resultJson ? (
                    <p className="muted-text">该任务没有可展开的参数或结果数据。</p>
                  ) : null}
                </div>
              ) : null}
              <div className="inline-actions">
                {isFailed ? (
                  <button type="button" className="button secondary" onClick={() => retry(task)} disabled={isPending}>
                    {isPending ? "处理中..." : "重试"}
                  </button>
                ) : null}
                {isQueued ? (
                  <button type="button" className="button danger" onClick={() => cancel(task)} disabled={isPending}>
                    {isPending ? "处理中..." : "取消排队"}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { useApiKeySettings } from "@/components/ApiKeySettingsProvider";
import {
  RUNTIME_EMBEDDING_API_KEY_HEADER,
  RUNTIME_EMBEDDING_BASE_URL_HEADER,
  RUNTIME_EMBEDDING_MODEL_HEADER,
} from "@/lib/runtime-keys";

type VectorIndexPanelProps = {
  knowledgeBaseId: string;
  serverConfigured: boolean;
  indexedCount: number;
  dimensions: number | null;
  model: string;
  indexedAt: string | null;
  indexStatus?: "IDLE" | "PENDING" | "READY" | "FAILED";
  errorText?: string | null;
};

type VectorIndexResponse = {
  indexedCount: number;
  dimensions: number;
  model: string;
  indexedAt: string | null;
  status?: "IDLE" | "PENDING" | "READY" | "FAILED";
  errorText?: string | null;
};

function statusLabel(status: string | undefined): string {
  switch (status) {
    case "PENDING":
      return "重建中";
    case "READY":
      return "就绪";
    case "FAILED":
      return "失败";
    default:
      return "未构建";
  }
}

export function VectorIndexPanel({ knowledgeBaseId, serverConfigured, indexedCount, dimensions, model, indexedAt, indexStatus = "IDLE", errorText = null }: VectorIndexPanelProps) {
  const { embeddingApiKey, embeddingBaseURL, embeddingModel, hasEmbeddingKey, openApiKeySettings } = useApiKeySettings();
  const [result, setResult] = useState<VectorIndexResponse | null>(null);
  const [error, setError] = useState<string | null>(errorText);
  const [isPending, startTransition] = useTransition();
  const [rebuilding, setRebuilding] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const refreshStatus = async (): Promise<Partial<VectorIndexResponse> | null> => {
    const response = await fetch(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/vector-index/status`, { cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as Partial<VectorIndexResponse> & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "无法刷新向量索引状态。");
    }
    setResult({
      indexedCount: payload.indexedCount ?? 0,
      dimensions: payload.dimensions ?? 0,
      model: payload.model || model,
      indexedAt: payload.indexedAt ?? null,
      status: payload.status,
      errorText: payload.errorText ?? null,
    });
    setError(payload.errorText ?? null);
    return payload;
  };

  const rebuild = () => {
    setError(null);
    startTransition(() => {
      void (async () => {
        try {
          const headers = new Headers();
          if (embeddingApiKey) {
            headers.set(RUNTIME_EMBEDDING_API_KEY_HEADER, embeddingApiKey);
          }
          if (embeddingBaseURL) {
            headers.set(RUNTIME_EMBEDDING_BASE_URL_HEADER, embeddingBaseURL);
          }
          if (embeddingModel) {
            headers.set(RUNTIME_EMBEDDING_MODEL_HEADER, embeddingModel);
          }
          const response = await fetch(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/vector-index`, { method: "POST", headers });
          const payload = (await response.json().catch(() => ({}))) as Partial<VectorIndexResponse> & { error?: string; queued?: boolean };
          if (!response.ok) {
            throw new Error(payload.error || "向量索引重建任务排队失败。");
          }
          // 重建在后台任务执行器中排队执行，这里轮询状态直到完成或失败。
          setRebuilding(true);
          await refreshStatus().catch(() => undefined);
          stopPolling();
          pollTimerRef.current = setInterval(() => {
            void refreshStatus()
              .then((payload) => {
                if (payload && payload.status && payload.status !== "PENDING") {
                  stopPolling();
                  setRebuilding(false);
                }
              })
              .catch(() => undefined);
          }, 4_000);
        } catch (requestError) {
          setError(requestError instanceof Error ? requestError.message : "向量索引重建失败。");
        }
      })();
    });
  };

  const active = result ?? { indexedCount, dimensions: dimensions ?? 0, model, indexedAt, status: indexStatus, errorText };

  return (
    <section className="workspace-section">
      <div className="workspace-section-heading">
        <div>
          <p className="section-kicker">EMBEDDING</p>
          <h3>语义检索索引</h3>
        </div>
        <span className="workspace-section-note">重建不影响已有索引</span>
      </div>
      <p className="muted-text">FTS5 始终可用。Embedding 配置只保存在浏览器本地或开发期 `.env`，重建请求仅用于当前本机服务，密钥不会写入数据库或审计日志。</p>
      <p className="field-helper">
        {hasEmbeddingKey
          ? `Embedding API 已配置；状态 ${statusLabel(active.status)}；当前索引 ${active.indexedCount} 个切片${active.dimensions ? `，维度 ${active.dimensions}` : ""}，模型 ${active.model}。`
          : "尚未配置 Embedding API；当前问答只使用 FTS5 关键词检索。"}
      </p>
      <div className="inline-actions">
        <button type="button" className="button secondary" onClick={() => openApiKeySettings("embedding")}>
          {hasEmbeddingKey ? "修改 Embedding 设置" : "设置 Embedding API"}
        </button>
        <button type="button" className="button primary" onClick={rebuild} disabled={!hasEmbeddingKey || isPending || rebuilding}>
          {rebuilding ? "重建中（后台排队）..." : isPending ? "提交中..." : "重建向量索引"}
        </button>
        <button type="button" className="button secondary" onClick={() => void refreshStatus().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : "无法刷新向量索引状态。"))} disabled={isPending}>
          刷新状态
        </button>
      </div>
      {!serverConfigured && hasEmbeddingKey ? <p className="field-helper">当前使用浏览器本地 Embedding 配置；打包版无需 `.env`。</p> : null}
      {active.indexedAt ? <p className="field-helper">最近索引时间：{new Date(active.indexedAt).toLocaleString("zh-CN")}。</p> : null}
      {error ? <p className="error-text">{error} 已保留上一次成功构建的索引；可检查本地 Embedding 设置后重试，或点击“刷新状态”查看实际索引。</p> : null}
    </section>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { useApiKeySettings } from "@/components/ApiKeySettingsProvider";
import { RUNTIME_LLM_API_KEY_HEADER, RUNTIME_LLM_BASE_URL_HEADER, RUNTIME_LLM_MODEL_HEADER } from "@/lib/runtime-keys";

export function EvaluationInitPanel({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const { llmApiKey, llmBaseURL, llmModel, hasLlmKey, openApiKeySettings } = useApiKeySettings();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
          // 不带 targetSetId：服务端自动创建当前知识库的第一个评测集。
          const response = await fetch("/api/evaluations/generate-candidates", {
            method: "POST",
            headers,
            body: JSON.stringify({ knowledgeBaseId, maxCases: 10, maxDocuments: 10, replaceExisting: false }),
          });
          const payload = (await response.json()) as { evaluationSetId?: string; createdCases?: number; error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "候选题生成失败。");
          }
          setMessage(`评测集已建立并生成 ${payload.createdCases ?? 0} 道候选题（均为未审核状态），正在刷新评测界面...`);
          setTimeout(() => router.refresh(), 800);
        } catch (generateError) {
          setError(generateError instanceof Error ? generateError.message : "候选题生成失败。");
        }
      })();
    });
  };

  return (
    <section className="banner" id="evaluation-run">
      <div>
        <h2>当前知识库尚未建立评测集</h2>
        <p className="muted-text">首次使用请从当前知识库文档自动生成候选题（需要已配置 LLM API Key）；生成后即可运行检索评测与冒烟回归。默认收件箱的既有候选题不会跨库复制，每个知识库独立生成自己的评测集。</p>
        {message ? <p className="field-helper">{message}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </div>
      <div className="inline-actions">
        <button type="button" className="button secondary" onClick={() => openApiKeySettings("llm")}>
          {hasLlmKey ? "修改 LLM 设置" : "设置 LLM API"}
        </button>
        <button type="button" className="button primary" onClick={generateCandidates} disabled={isPending || !hasLlmKey}>
          {isPending ? "生成中..." : "按文档生成候选题"}
        </button>
      </div>
    </section>
  );
}

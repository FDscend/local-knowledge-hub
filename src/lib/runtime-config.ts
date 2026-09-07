import { getLlmConfig } from "@/lib/llm";
import { normalizeRuntimeKey } from "@/lib/runtime-keys";

declare global {
  var __runtimeConfigWarnings: Set<string> | undefined;
}

export type RuntimeConfigStatus = {
  llmConfigured: boolean;
  mineruPreciseConfigured: boolean;
  llmConfiguredByServer: boolean;
  mineruPreciseConfiguredByServer: boolean;
  llmBaseURLByServer: string;
  llmModelByServer: string;
  embeddingConfigured: boolean;
  embeddingConfiguredByServer: boolean;
  embeddingBaseURLByServer: string;
  embeddingModelByServer: string;
  llmWarning: string | null;
};

type RuntimeConfigOverrides = {
  llmApiKey?: string | null;
  llmBaseURL?: string | null;
  llmModel?: string | null;
  mineruApiKey?: string | null;
};

export function getMineruApiKey(apiKeyOverride?: string | null): string {
  const overrideKey = normalizeRuntimeKey(apiKeyOverride);
  return overrideKey || process.env.MINERU_API_KEY || process.env.MINERU_TOKEN || "";
}

export function getRuntimeConfigStatus(overrides: RuntimeConfigOverrides = {}): RuntimeConfigStatus {
  const llmConfiguredByServer = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
  const mineruPreciseConfiguredByServer = Boolean(process.env.MINERU_API_KEY || process.env.MINERU_TOKEN);
  const embeddingConfiguredByServer = Boolean(process.env.EMBEDDING_API_KEY);

  const llmConfig = getLlmConfig({
    apiKeyOverride: overrides.llmApiKey,
    baseURLOverride: overrides.llmBaseURL,
    modelOverride: overrides.llmModel,
  });

  const llmConfigured = Boolean(llmConfig.apiKey);
  const mineruPreciseConfigured = Boolean(getMineruApiKey(overrides.mineruApiKey));

  return {
    llmConfigured,
    mineruPreciseConfigured,
    llmConfiguredByServer,
    mineruPreciseConfiguredByServer,
    llmBaseURLByServer: process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || "",
    llmModelByServer: process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || "gpt-4.1-mini",
    embeddingConfigured: embeddingConfiguredByServer,
    embeddingConfiguredByServer,
    embeddingBaseURLByServer: process.env.EMBEDDING_BASE_URL || "",
    embeddingModelByServer: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    llmWarning: llmConfigured
      ? null
      : "当前未配置 LLM API Key。问答与元数据生成会退化为回退模式，请先在页面内点击 API 设置补齐。",
  };
}

export function warnMissingRuntimeConfigOnce(): RuntimeConfigStatus {
  const status = getRuntimeConfigStatus();

  if (!status.llmConfigured) {
    globalThis.__runtimeConfigWarnings ??= new Set<string>();
    if (!globalThis.__runtimeConfigWarnings.has("missing-llm")) {
      console.warn(`[runtime-config] ${status.llmWarning}`);
      globalThis.__runtimeConfigWarnings.add("missing-llm");
    }
  }

  return status;
}
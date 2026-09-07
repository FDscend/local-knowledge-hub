export const RUNTIME_KEY_STORAGE_KEY = "ai-kb-runtime-keys-v1";
export const RUNTIME_LLM_API_KEY_HEADER = "x-runtime-llm-api-key";
export const RUNTIME_LLM_BASE_URL_HEADER = "x-runtime-llm-base-url";
export const RUNTIME_LLM_MODEL_HEADER = "x-runtime-llm-model";
export const RUNTIME_EMBEDDING_API_KEY_HEADER = "x-runtime-embedding-api-key";
export const RUNTIME_EMBEDDING_BASE_URL_HEADER = "x-runtime-embedding-base-url";
export const RUNTIME_EMBEDDING_MODEL_HEADER = "x-runtime-embedding-model";

export type RuntimeStoredKeys = {
  llmApiKey: string;
  llmBaseURL: string;
  llmModel: string;
  mineruApiKey: string;
  embeddingApiKey: string;
  embeddingBaseURL: string;
  embeddingModel: string;
};

export type RuntimeLlmOverrides = {
  llmApiKey: string;
  llmBaseURL: string;
  llmModel: string;
};

export type RuntimeEmbeddingOverrides = {
  embeddingApiKey: string;
  embeddingBaseURL: string;
  embeddingModel: string;
};

export function normalizeRuntimeKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function emptyRuntimeStoredKeys(): RuntimeStoredKeys {
  return {
    llmApiKey: "",
    llmBaseURL: "",
    llmModel: "",
    mineruApiKey: "",
    embeddingApiKey: "",
    embeddingBaseURL: "",
    embeddingModel: "",
  };
}

export function parseRuntimeStoredKeys(input: unknown): RuntimeStoredKeys {
  if (!input || typeof input !== "object") {
    return emptyRuntimeStoredKeys();
  }

  return {
    llmApiKey: normalizeRuntimeKey((input as Record<string, unknown>).llmApiKey),
    llmBaseURL: normalizeRuntimeKey((input as Record<string, unknown>).llmBaseURL),
    llmModel: normalizeRuntimeKey((input as Record<string, unknown>).llmModel),
    mineruApiKey: normalizeRuntimeKey((input as Record<string, unknown>).mineruApiKey),
    embeddingApiKey: normalizeRuntimeKey((input as Record<string, unknown>).embeddingApiKey),
    embeddingBaseURL: normalizeRuntimeKey((input as Record<string, unknown>).embeddingBaseURL),
    embeddingModel: normalizeRuntimeKey((input as Record<string, unknown>).embeddingModel),
  };
}

export function readRuntimeLlmApiKeyFromRequest(request: Request): string {
  return normalizeRuntimeKey(request.headers.get(RUNTIME_LLM_API_KEY_HEADER));
}

export function readRuntimeLlmOverridesFromRequest(request: Request): RuntimeLlmOverrides {
  return {
    llmApiKey: normalizeRuntimeKey(request.headers.get(RUNTIME_LLM_API_KEY_HEADER)),
    llmBaseURL: normalizeRuntimeKey(request.headers.get(RUNTIME_LLM_BASE_URL_HEADER)),
    llmModel: normalizeRuntimeKey(request.headers.get(RUNTIME_LLM_MODEL_HEADER)),
  };
}

export function readRuntimeEmbeddingOverridesFromRequest(request: Request): RuntimeEmbeddingOverrides {
  return {
    embeddingApiKey: normalizeRuntimeKey(request.headers.get(RUNTIME_EMBEDDING_API_KEY_HEADER)),
    embeddingBaseURL: normalizeRuntimeKey(request.headers.get(RUNTIME_EMBEDDING_BASE_URL_HEADER)),
    embeddingModel: normalizeRuntimeKey(request.headers.get(RUNTIME_EMBEDDING_MODEL_HEADER)),
  };
}

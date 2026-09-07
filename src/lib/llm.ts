import { normalizeRuntimeKey } from "@/lib/runtime-keys";

export type LlmConfig = {
  apiKey: string;
  baseURL?: string;
  model: string;
};

type LlmConfigOptions = {
  apiKeyOverride?: string | null;
  baseURLOverride?: string | null;
  modelOverride?: string | null;
};

export function getLlmConfig(options: LlmConfigOptions = {}): LlmConfig {
  const overrideApiKey = normalizeRuntimeKey(options.apiKeyOverride);
  const overrideBaseURL = normalizeRuntimeKey(options.baseURLOverride);
  const overrideModel = normalizeRuntimeKey(options.modelOverride);
  const apiKey = overrideApiKey || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || "";
  const baseURL = overrideBaseURL || process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || undefined;
  const model = overrideModel || process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || "gpt-4.1-mini";

  return {
    apiKey,
    baseURL,
    model,
  };
}
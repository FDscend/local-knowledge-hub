"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import type { RuntimeConfigStatus } from "@/lib/runtime-config";
import {
  RUNTIME_KEY_STORAGE_KEY,
  emptyRuntimeStoredKeys,
  normalizeRuntimeKey,
  parseRuntimeStoredKeys,
  type RuntimeStoredKeys,
} from "@/lib/runtime-keys";

type PreferredKeyTarget = "llm" | "mineru" | "embedding";

type ApiKeySettingsContextValue = {
  llmApiKey: string;
  llmBaseURL: string;
  llmModel: string;
  mineruApiKey: string;
  embeddingApiKey: string;
  embeddingBaseURL: string;
  embeddingModel: string;
  hasLlmKey: boolean;
  hasMineruKey: boolean;
  hasEmbeddingKey: boolean;
  openApiKeySettings: (target?: PreferredKeyTarget) => void;
};

const ApiKeySettingsContext = createContext<ApiKeySettingsContextValue | null>(null);

type ApiKeySettingsProviderProps = {
  runtimeConfig: RuntimeConfigStatus;
  children: ReactNode;
};

const RUNTIME_KEYS_EVENT = "runtime-keys-changed";
const EMPTY_RUNTIME_STORED_KEYS: RuntimeStoredKeys = Object.freeze(emptyRuntimeStoredKeys());

let cachedRawKeys: string | null | undefined;
let cachedSnapshot: RuntimeStoredKeys = EMPTY_RUNTIME_STORED_KEYS;

function getServerRuntimeKeysSnapshot(): RuntimeStoredKeys {
  return EMPTY_RUNTIME_STORED_KEYS;
}

function readStoredKeysFromBrowser(): RuntimeStoredKeys {
  if (typeof window === "undefined") {
    return EMPTY_RUNTIME_STORED_KEYS;
  }

  try {
    const raw = window.localStorage.getItem(RUNTIME_KEY_STORAGE_KEY);

    if (raw === cachedRawKeys) {
      return cachedSnapshot;
    }

    if (!raw) {
      cachedRawKeys = null;
      cachedSnapshot = EMPTY_RUNTIME_STORED_KEYS;
      return cachedSnapshot;
    }

    cachedRawKeys = raw;
    cachedSnapshot = parseRuntimeStoredKeys(JSON.parse(raw));
    return cachedSnapshot;
  } catch {
    cachedRawKeys = null;
    cachedSnapshot = EMPTY_RUNTIME_STORED_KEYS;
    return cachedSnapshot;
  }
}

function subscribeRuntimeKeys(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== RUNTIME_KEY_STORAGE_KEY) {
      return;
    }

    onStoreChange();
  };

  const onCustomChange = () => {
    onStoreChange();
  };

  window.addEventListener("storage", onStorage);
  window.addEventListener(RUNTIME_KEYS_EVENT, onCustomChange);

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(RUNTIME_KEYS_EVENT, onCustomChange);
  };
}

function persistStoredKeys(keys: RuntimeStoredKeys): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const serialized = JSON.stringify(keys);
    cachedRawKeys = serialized;
    cachedSnapshot = keys;
    window.localStorage.setItem(RUNTIME_KEY_STORAGE_KEY, serialized);
    window.dispatchEvent(new Event(RUNTIME_KEYS_EVENT));
  } catch {
    // Ignore local storage write failures.
  }
}

export function ApiKeySettingsProvider({ runtimeConfig, children }: ApiKeySettingsProviderProps) {
  const storedKeys = useSyncExternalStore(subscribeRuntimeKeys, readStoredKeysFromBrowser, getServerRuntimeKeysSnapshot);
  const [isManualDialogOpen, setIsManualDialogOpen] = useState(false);
  const [isMissingLlmDialogDismissed, setIsMissingLlmDialogDismissed] = useState(false);
  const [preferredTarget, setPreferredTarget] = useState<PreferredKeyTarget>("llm");
  const [draftLlmApiKey, setDraftLlmApiKey] = useState("");
  const [draftLlmBaseURL, setDraftLlmBaseURL] = useState("");
  const [draftLlmModel, setDraftLlmModel] = useState("");
  const [draftMineruApiKey, setDraftMineruApiKey] = useState("");
  const [draftEmbeddingApiKey, setDraftEmbeddingApiKey] = useState("");
  const [draftEmbeddingBaseURL, setDraftEmbeddingBaseURL] = useState("");
  const [draftEmbeddingModel, setDraftEmbeddingModel] = useState("");

  const hasLlmKey = runtimeConfig.llmConfigured || Boolean(storedKeys.llmApiKey);
  const hasMineruKey = runtimeConfig.mineruPreciseConfigured || Boolean(storedKeys.mineruApiKey);
  const hasEmbeddingKey = runtimeConfig.embeddingConfigured || Boolean(storedKeys.embeddingApiKey);
  const forceOpenMissingLlmDialog = !hasLlmKey && !isMissingLlmDialogDismissed;
  const isDialogOpen = isManualDialogOpen || forceOpenMissingLlmDialog;

  const openApiKeySettings = (target: PreferredKeyTarget = "llm") => {
    setPreferredTarget(target);
    setDraftLlmApiKey(storedKeys.llmApiKey);
    setDraftLlmBaseURL(storedKeys.llmBaseURL);
    setDraftLlmModel(storedKeys.llmModel);
    setDraftMineruApiKey(storedKeys.mineruApiKey);
    setDraftEmbeddingApiKey(storedKeys.embeddingApiKey);
    setDraftEmbeddingBaseURL(storedKeys.embeddingBaseURL);
    setDraftEmbeddingModel(storedKeys.embeddingModel);
    setIsManualDialogOpen(true);
    setIsMissingLlmDialogDismissed(false);
  };

  const closeDialog = () => {
    setIsManualDialogOpen(false);

    if (forceOpenMissingLlmDialog) {
      setIsMissingLlmDialogDismissed(true);
    }
  };

  // 弹窗支持 Esc 关闭
  useEffect(() => {
    if (!isDialogOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsManualDialogOpen(false);
        if (forceOpenMissingLlmDialog) {
          setIsMissingLlmDialogDismissed(true);
        }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isDialogOpen, forceOpenMissingLlmDialog]);

  const saveDraftKeys = () => {
    const nextKeys: RuntimeStoredKeys = {
      llmApiKey: normalizeRuntimeKey(draftLlmApiKey),
      llmBaseURL: normalizeRuntimeKey(draftLlmBaseURL),
      llmModel: normalizeRuntimeKey(draftLlmModel),
      mineruApiKey: normalizeRuntimeKey(draftMineruApiKey),
      embeddingApiKey: normalizeRuntimeKey(draftEmbeddingApiKey),
      embeddingBaseURL: normalizeRuntimeKey(draftEmbeddingBaseURL),
      embeddingModel: normalizeRuntimeKey(draftEmbeddingModel),
    };

    persistStoredKeys(nextKeys);
    setIsManualDialogOpen(false);
    setIsMissingLlmDialogDismissed(false);
  };

  const clearDraftKeys = () => {
    const emptyKeys = emptyRuntimeStoredKeys();
    persistStoredKeys(emptyKeys);
    setDraftLlmApiKey("");
    setDraftLlmBaseURL("");
    setDraftLlmModel("");
    setDraftMineruApiKey("");
    setDraftEmbeddingApiKey("");
    setDraftEmbeddingBaseURL("");
    setDraftEmbeddingModel("");
  };

  const contextValue: ApiKeySettingsContextValue = {
    llmApiKey: storedKeys.llmApiKey,
    llmBaseURL: storedKeys.llmBaseURL,
    llmModel: storedKeys.llmModel,
    mineruApiKey: storedKeys.mineruApiKey,
    embeddingApiKey: storedKeys.embeddingApiKey,
    embeddingBaseURL: storedKeys.embeddingBaseURL,
    embeddingModel: storedKeys.embeddingModel,
    hasLlmKey,
    hasMineruKey,
    hasEmbeddingKey,
    openApiKeySettings,
  };

  const runtimeWarning = !hasLlmKey
    ? "当前尚未配置 LLM API Key。请先在页面内点击 API 设置补充，问答与摘要生成才能启用模型模式。"
    : null;

  return (
    <ApiKeySettingsContext.Provider value={contextValue}>
      {runtimeWarning ? (
        <div className="runtime-alert runtime-alert-warning">
          <span>{runtimeWarning}</span>
          <button type="button" className="runtime-alert-action" onClick={() => openApiKeySettings("llm")}>
            立即设置
          </button>
        </div>
      ) : null}

      {children}

      {isDialogOpen ? (
        <div className="modal-backdrop" onClick={closeDialog}>
          <div
            className="modal-card stack-panel"
            role="dialog"
            aria-modal="true"
            aria-label="API 设置"
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <h2>API 设置</h2>
              <p className="muted-text">这里保存的是浏览器本地配置，不会改动 .env 文件。本地输入优先级高于服务器环境变量，留空时回退到服务器配置。</p>
            </div>

            <div className="runtime-config-summary">
              <p className="field-helper">服务器配置状态</p>
              <ul className="runtime-config-list">
                <li>LLM Key：{runtimeConfig.llmConfiguredByServer ? "已配置" : "未配置"}</li>
                <li>MinerU Key：{runtimeConfig.mineruPreciseConfiguredByServer ? "已配置" : "未配置"}</li>
                <li>LLM Base URL：{runtimeConfig.llmBaseURLByServer || "未配置"}</li>
                <li>LLM Model：{runtimeConfig.llmModelByServer}</li>
                <li>Embedding API：{runtimeConfig.embeddingConfiguredByServer ? "已配置" : "未配置"}</li>
                <li>Embedding Base URL：{runtimeConfig.embeddingBaseURLByServer || "未配置"}</li>
                <li>Embedding Model：{runtimeConfig.embeddingModelByServer}</li>
              </ul>
            </div>

            <form
              className="stack-panel"
              onSubmit={(event) => {
                event.preventDefault();
                saveDraftKeys();
              }}
            >
              <label className="field">
                <span>LLM API Key</span>
                <input
                  className="input"
                  type="password"
                  value={draftLlmApiKey}
                  onChange={(event) => setDraftLlmApiKey(event.target.value)}
                  autoFocus={preferredTarget === "llm"}
                  placeholder="用于问答与摘要生成"
                />
              </label>

              <label className="field">
                <span>LLM Base URL（可选）</span>
                <input
                  className="input"
                  value={draftLlmBaseURL}
                  onChange={(event) => setDraftLlmBaseURL(event.target.value)}
                  placeholder={runtimeConfig.llmBaseURLByServer || "例如：https://api.deepseek.com"}
                />
                <p className="field-helper">留空则回退服务器配置。</p>
              </label>

              <label className="field">
                <span>LLM Model（可选）</span>
                <input
                  className="input"
                  value={draftLlmModel}
                  onChange={(event) => setDraftLlmModel(event.target.value)}
                  placeholder={runtimeConfig.llmModelByServer}
                />
                <p className="field-helper">留空则回退服务器配置。</p>
              </label>

              <label className="field">
                <span>MinerU API Key</span>
                <input
                  className="input"
                  type="password"
                  value={draftMineruApiKey}
                  onChange={(event) => setDraftMineruApiKey(event.target.value)}
                  autoFocus={preferredTarget === "mineru"}
                  placeholder="用于精准 MinerU PDF 解析"
                />
              </label>

              <label className="field">
                <span>Embedding API Key</span>
                <input
                  className="input"
                  type="password"
                  value={draftEmbeddingApiKey}
                  onChange={(event) => setDraftEmbeddingApiKey(event.target.value)}
                  autoFocus={preferredTarget === "embedding"}
                  placeholder="用于语义检索向量化"
                />
              </label>

              <label className="field">
                <span>Embedding Base URL（可选）</span>
                <input
                  className="input"
                  value={draftEmbeddingBaseURL}
                  onChange={(event) => setDraftEmbeddingBaseURL(event.target.value)}
                  placeholder={runtimeConfig.embeddingBaseURLByServer || "例如：https://api.example.com/v1"}
                />
                <p className="field-helper">填写 API 根路径，客户端会自动追加 `/embeddings`。例如 SiliconFlow 填写 `https://api.siliconflow.cn/v1`，不要填写 `/v1/embedding`；留空则回退服务器配置。</p>
              </label>

              <label className="field">
                <span>Embedding Model（可选）</span>
                <input
                  className="input"
                  value={draftEmbeddingModel}
                  onChange={(event) => setDraftEmbeddingModel(event.target.value)}
                  placeholder={runtimeConfig.embeddingModelByServer}
                />
                <p className="field-helper">留空则回退服务器配置。</p>
              </label>

              <div className="inline-actions">
                <button type="button" className="button secondary" onClick={closeDialog}>
                  取消
                </button>
                <button type="button" className="button secondary" onClick={clearDraftKeys}>
                  清空本地 Key
                </button>
                <button type="submit" className="button primary">
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </ApiKeySettingsContext.Provider>
  );
}

export function useApiKeySettings(): ApiKeySettingsContextValue {
  const context = useContext(ApiKeySettingsContext);

  if (!context) {
    throw new Error("useApiKeySettings 必须在 ApiKeySettingsProvider 内使用。");
  }

  return context;
}

export function ApiKeySettingsButton() {
  const { hasLlmKey, hasMineruKey, hasEmbeddingKey, openApiKeySettings } = useApiKeySettings();
  const suffix = hasLlmKey && hasMineruKey && hasEmbeddingKey ? "" : "（待补充）";

  return (
    <button type="button" className="topnav-button" onClick={() => openApiKeySettings("llm")}>
      API 设置{suffix}
    </button>
  );
}

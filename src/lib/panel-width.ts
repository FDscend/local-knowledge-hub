// 辅助面板宽度布局状态：按 key 持久化到 localStorage，
// SSR 使用服务端快照避免水合不一致（与 AppShell 布局状态同一模式）。
export type PanelWidthStore = {
  read: () => number;
  subscribe: (onStoreChange: () => void) => () => void;
  getServer: () => number;
  update: (value: number) => void;
  min: number;
  max: number;
  defaultValue: number;
};

export function createPanelWidthStore(options: {
  key: string;
  defaultValue: number;
  min: number;
  max: number;
}): PanelWidthStore {
  const { key, defaultValue, min, max } = options;
  const eventName = `${key}-changed`;
  let cachedRaw: string | null | undefined;
  let cachedValue = defaultValue;

  function clamp(value: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function read(): number {
    if (typeof window === "undefined") {
      return defaultValue;
    }
    const rawValue = window.localStorage.getItem(key);
    if (rawValue === cachedRaw) {
      return cachedValue;
    }
    cachedRaw = rawValue;
    cachedValue = rawValue ? clamp(Number(rawValue) || defaultValue) : defaultValue;
    return cachedValue;
  }

  function subscribe(onStoreChange: () => void): () => void {
    if (typeof window === "undefined") {
      return () => undefined;
    }
    window.addEventListener(eventName, onStoreChange);
    return () => window.removeEventListener(eventName, onStoreChange);
  }

  function getServer(): number {
    return defaultValue;
  }

  function update(value: number): void {
    if (typeof window === "undefined") {
      return;
    }
    const clamped = clamp(value);
    cachedValue = clamped;
    try {
      window.localStorage.setItem(key, String(clamped));
      cachedRaw = String(clamped);
    } catch {
      cachedRaw = window.localStorage.getItem(key);
    }
    window.dispatchEvent(new Event(eventName));
  }

  return { read, subscribe, getServer, update, min, max, defaultValue };
}

// 问答页引用面板宽度
export const qaPanelWidthStore = createPanelWidthStore({
  key: "ai-knowledge-base:qa-panel-width",
  defaultValue: 320,
  min: 280,
  max: 480,
});

// 文档详情右侧辅助栏宽度
export const documentPanelWidthStore = createPanelWidthStore({
  key: "ai-knowledge-base:aux-panel-width",
  defaultValue: 320,
  min: 280,
  max: 480,
});

// 评测检索调试面板宽度
export const evaluationDebugPanelWidthStore = createPanelWidthStore({
  key: "ai-knowledge-base:evaluation-panel-width",
  defaultValue: 320,
  min: 280,
  max: 480,
});

"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { ApiKeySettingsButton } from "@/components/ApiKeySettingsProvider";
import { KnowledgeBaseSwitcher } from "@/components/KnowledgeBaseSwitcher";
import { CONVERSATIONS_CHANGED_EVENT, SCROLL_TO_MESSAGE_EVENT } from "@/lib/conversation-events";

const LAYOUT_STORAGE_KEY = "ai-knowledge-base:layout:v1";
const LAYOUT_CHANGE_EVENT = "ai-knowledge-base:layout-changed";
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_MODULE_HEIGHT = 320;
const MIN_MODULE_HEIGHT = 180;
const MAX_MODULE_HEIGHT = 620;

type LayoutState = {
  version: 1;
  primarySidebarCollapsed: boolean;
  primarySidebarWidth: number;
  primarySidebarModuleOpen: boolean;
  primarySidebarModuleHeight: number;
  primarySidebarContextOpen: boolean;
  primarySidebarDocumentsOpen: boolean;
  auxiliaryPanelOpen: boolean;
  bottomPanelOpen: boolean;
  lastAuxiliaryPanel: null;
};

type NavigationItem = {
  href: string;
  label: string;
  glyph: string;
  description: string;
};

type KnowledgeBaseSummary = {
  id: string;
  name: string;
  description: string | null;
  defaultLanguage: string;
  kind: "INBOX" | "DEVELOPMENT" | "SYNC" | "SNAPSHOT";
  documentCount: number;
  chunkCount: number;
  embedding: {
    configured: boolean;
    status: "IDLE" | "PENDING" | "READY" | "FAILED";
    indexedCount: number;
    dimensions: number | null;
    model: string;
    indexedAt: string | null;
  };
  sync: {
    syncedCount: number;
    conflictCount: number;
    missingCount: number;
    snapshotCount: number;
    lastSyncedAt: string | null;
  } | null;
};

type SidebarDocument = {
  id: string;
  title: string;
  status: "ACTIVE" | "DRAFT" | "DISABLED";
  updatedAt: string;
};

type SidebarConversation = {
  id: string;
  title: string;
  archived: boolean;
  messageCount: number;
  updatedAt: string;
};

type SidebarOutlineMessage = {
  id: string;
  role: "user" | "assistant";
  title: string | null;
  content: string;
  createdAt: string;
};

// 一级导航只保留全局模块；概览通过顶部品牌图标进入，知识库管理通过二级侧栏头部入口进入。
const activityItems: NavigationItem[] = [
  { href: "/knowledge", label: "文档", glyph: "文", description: "浏览和检索知识文档" },
  { href: "/qa", label: "问答", glyph: "问", description: "进入知识库问答" },
  { href: "/evaluations", label: "评测", glyph: "测", description: "运行检索评测" },
  { href: "/graph", label: "图谱", glyph: "图", description: "查看知识图谱" },
  { href: "/tasks", label: "任务", glyph: "任", description: "查看后台任务" },
];

const createKnowledgeItem: NavigationItem = {
  href: "/knowledge/new",
  label: "新增知识",
  glyph: "＋",
  description: "录入或导入知识文档",
};

// 二级导航仅保留有独立页面内容的模块；文档模块的二级侧栏由文档列表分组承担。
const sidebarItems: NavigationItem[] = [
  { href: "/qa", label: "问答会话", glyph: "01", description: "基于当前知识库多轮提问" },
  { href: "/drafts", label: "知识草稿", glyph: "02", description: "审核并应用受控写入提案" },
  { href: "/graph", label: "知识图谱", glyph: "03", description: "查看文档与标签的关系网络" },
  { href: "/tasks", label: "后台任务", glyph: "04", description: "跟踪导入、评测和索引任务" },
];

// 评测为单页多分区结构，二级子项使用页内锚点定位。
const evaluationSidebarItems: NavigationItem[] = [
  { href: "/evaluations#run", label: "开始评测", glyph: "01", description: "运行检索评测" },
  { href: "/evaluations#history", label: "评测历史", glyph: "02", description: "查看历史运行" },
  { href: "/evaluations#cases", label: "评测题生成", glyph: "03", description: "生成和审核候选题" },
];

const defaultLayoutState: LayoutState = {
  version: 1,
  primarySidebarCollapsed: false,
  primarySidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  primarySidebarModuleOpen: true,
  primarySidebarModuleHeight: DEFAULT_MODULE_HEIGHT,
  primarySidebarContextOpen: true,
  primarySidebarDocumentsOpen: true,
  auxiliaryPanelOpen: false,
  bottomPanelOpen: false,
  lastAuxiliaryPanel: null,
};

let cachedLayoutRaw: string | null | undefined;
let cachedLayoutSnapshot: LayoutState = defaultLayoutState;

function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

function clampModuleHeight(value: number): number {
  return Math.min(MAX_MODULE_HEIGHT, Math.max(MIN_MODULE_HEIGHT, Math.round(value)));
}

function parseLayoutState(rawValue: string | null): LayoutState {
  if (!rawValue) {
    return defaultLayoutState;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<LayoutState>;
    if (parsed.version !== 1) {
      return defaultLayoutState;
    }

    return {
      ...defaultLayoutState,
      primarySidebarCollapsed: parsed.primarySidebarCollapsed === true,
      primarySidebarWidth: typeof parsed.primarySidebarWidth === "number" ? clampSidebarWidth(parsed.primarySidebarWidth) : DEFAULT_SIDEBAR_WIDTH,
      primarySidebarModuleOpen: parsed.primarySidebarModuleOpen !== false,
      primarySidebarModuleHeight: typeof parsed.primarySidebarModuleHeight === "number" ? clampModuleHeight(parsed.primarySidebarModuleHeight) : DEFAULT_MODULE_HEIGHT,
      primarySidebarContextOpen: parsed.primarySidebarContextOpen !== false,
      primarySidebarDocumentsOpen: parsed.primarySidebarDocumentsOpen !== false,
      auxiliaryPanelOpen: parsed.auxiliaryPanelOpen === true,
      bottomPanelOpen: parsed.bottomPanelOpen === true,
      lastAuxiliaryPanel: null,
    };
  } catch {
    return defaultLayoutState;
  }
}

function readLayoutSnapshot(): LayoutState {
  if (typeof window === "undefined") {
    return defaultLayoutState;
  }

  const rawValue = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (rawValue === cachedLayoutRaw) {
    return cachedLayoutSnapshot;
  }

  cachedLayoutRaw = rawValue;
  cachedLayoutSnapshot = parseLayoutState(rawValue);
  return cachedLayoutSnapshot;
}

function subscribeToLayout(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== LAYOUT_STORAGE_KEY) {
      return;
    }

    onStoreChange();
  };

  window.addEventListener("storage", onStorage);
  window.addEventListener(LAYOUT_CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LAYOUT_CHANGE_EVENT, onStoreChange);
  };
}

function getServerLayoutSnapshot(): LayoutState {
  return defaultLayoutState;
}

function updateLayout(updater: (current: LayoutState) => LayoutState): void {
  if (typeof window === "undefined") {
    return;
  }

  const nextLayout = updater(readLayoutSnapshot());
  const serialized = JSON.stringify(nextLayout);
  cachedLayoutSnapshot = nextLayout;

  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, serialized);
    cachedLayoutRaw = serialized;
  } catch {
    cachedLayoutRaw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
  }

  window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT));
}

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

// 二级导航中存在前缀重叠项（如 /knowledge 与 /knowledge/new），只高亮最长匹配，保证单选。
function getActiveSecondaryHref(pathname: string, items: NavigationItem[]): string | null {
  const matches = items.filter((item) => isActivePath(pathname, item.href));
  if (matches.length === 0) {
    return null;
  }
  return matches.reduce((longest, item) => (item.href.length > longest.href.length ? item : longest)).href;
}

function getKnowledgeBaseId(searchParams: { get: (name: string) => string | null }): string | null {
  return searchParams.get("knowledgeBaseId") ?? searchParams.get("knowledgeBase");
}

function getKnowledgeBaseIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/knowledge-bases\/([^/]+)(?:\/|$)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildNavigationHref(href: string, searchParams: { getAll: (name: string) => string[] }, knowledgeBaseId: string): string {
  const [path, hash] = href.split("#");
  const nextParams = new URLSearchParams();
  nextParams.set("knowledgeBaseId", knowledgeBaseId);

  const preservedKeys = path === "/knowledge" ? ["q", "tag", "status", "sort"] : path === "/tasks" ? ["status"] : [];
  for (const key of preservedKeys) {
    for (const value of searchParams.getAll(key)) {
      nextParams.append(key, value);
    }
  }

  const query = nextParams.toString();
  const withQuery = query ? `${path}?${query}` : path;
  return hash ? `${withQuery}#${hash}` : withQuery;
}

function getKnowledgeBaseSwitchPath(pathname: string): string {
  if (pathname === "/knowledge-bases" || pathname.startsWith("/knowledge-bases/")) {
    return "/knowledge";
  }

  if (pathname.startsWith("/knowledge/") && pathname !== "/knowledge/new") {
    return "/knowledge";
  }

  return pathname;
}

function buildKnowledgeBaseSwitchHref(pathname: string, searchParams: { getAll: (name: string) => string[] }, knowledgeBaseId: string): string {
  return buildNavigationHref(getKnowledgeBaseSwitchPath(pathname), searchParams, knowledgeBaseId);
}

function getKnowledgeBaseKindLabel(kind: KnowledgeBaseSummary["kind"]): string {
  switch (kind) {
    case "INBOX":
      return "默认收件箱";
    case "DEVELOPMENT":
      return "开发数据";
    case "SYNC":
      return "同步库";
    default:
      return "快照库";
  }
}

function getEmbeddingStatusLabel(summary: KnowledgeBaseSummary): string {
  if (!summary.embedding.configured) {
    return "仅 FTS5";
  }

  switch (summary.embedding.status) {
    case "READY":
      return `向量 ${summary.embedding.indexedCount}/${summary.chunkCount}`;
    case "PENDING":
      return "向量构建中";
    case "FAILED":
      return "向量失败";
    default:
      return "向量未构建";
  }
}

function getSyncStatusLabel(sync: NonNullable<KnowledgeBaseSummary["sync"]>): string {
  if (sync.conflictCount > 0) {
    return `${sync.conflictCount} 项冲突待处理`;
  }
  if (sync.missingCount > 0) {
    return `${sync.missingCount} 项源文件缺失`;
  }
  if (sync.syncedCount > 0) {
    return `已同步 ${sync.syncedCount} 项`;
  }
  return "尚未同步";
}

// Next.js 对同一路由的 hash 变化不会自动滚动到锚点，这里统一手动定位；
// 跨路由导航（pathname 变化）由下方 effect 在挂载后处理。
// 不使用 smooth：动画会被 Next 导航 / 页面重渲染中断，导致停在错误位置。
// 评测分区使用 evaluation- 前缀 id，链接 hash 为短名（如 #cases），需要兼容。
function scrollToHashAnchor(hash: string): void {
  if (!hash) {
    return;
  }
  requestAnimationFrame(() => {
    const exact = document.getElementById(hash);
    const el = exact ?? document.getElementById(`evaluation-${hash}`);
    el?.scrollIntoView({ block: "start" });
  });
}

// 二级导航严格取当前一级模块路由空间内的入口（方案 A，见 UI 布局重构实施文档 6.1）。
// 概览、知识库管理和文档模块不提供“当前模块”导航分组：概览由品牌图标承担，
// 知识库管理由侧栏头部入口承担，文档模块的二级侧栏由文档列表分组承担。
function getSecondaryItems(pathname: string): NavigationItem[] {
  if (pathname.startsWith("/evaluations")) {
    return evaluationSidebarItems;
  }

  if (pathname.startsWith("/qa")) {
    return sidebarItems.filter((item) => item.href === "/qa");
  }

  if (pathname.startsWith("/drafts")) {
    return sidebarItems.filter((item) => item.href === "/drafts");
  }

  if (pathname.startsWith("/graph")) {
    return sidebarItems.filter((item) => item.href === "/graph");
  }

  if (pathname.startsWith("/tasks")) {
    return sidebarItems.filter((item) => item.href === "/tasks");
  }

  return [];
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const layout = useSyncExternalStore(subscribeToLayout, readLayoutSnapshot, getServerLayoutSnapshot);
  const secondaryItems = useMemo(() => getSecondaryItems(pathname), [pathname]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseSummary[]>([]);
  const [knowledgeBasesLoading, setKnowledgeBasesLoading] = useState(true);
  const [knowledgeBasesError, setKnowledgeBasesError] = useState(false);
  const [sidebarDocuments, setSidebarDocuments] = useState<SidebarDocument[] | null>(null);
  const [sidebarDocumentsForBase, setSidebarDocumentsForBase] = useState<string | null>(null);
  const [sidebarDocumentsError, setSidebarDocumentsError] = useState(false);
  // /qa 侧栏：聊天记录会话列表与当前会话的提问大纲
  const [sidebarConversations, setSidebarConversations] = useState<SidebarConversation[] | null>(null);
  const [sidebarOutline, setSidebarOutline] = useState<SidebarOutlineMessage[] | null>(null);
  const [outlineEditingId, setOutlineEditingId] = useState<string | null>(null);
  const [outlineDraft, setOutlineDraft] = useState("");
  const [outlineError, setOutlineError] = useState(false);
  // 会话项"更多"菜单与内联重命名
  const [conversationMenuId, setConversationMenuId] = useState<string | null>(null);
  const [conversationMenuAnchor, setConversationMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [conversationEditingId, setConversationEditingId] = useState<string | null>(null);
  const [conversationDraft, setConversationDraft] = useState("");
  // 当前 URL hash：评测锚点子项选中态；pushState 不触发 hashchange，点击时手动更新
  const [currentHash, setCurrentHash] = useState("");
  // 窄窗口（<=959px）二级侧栏为抽屉：默认收起，由 narrowSidebarOpen 显式打开
  const [isNarrow, setIsNarrow] = useState(false);
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  const knowledgeBaseId = getKnowledgeBaseId(searchParams) ?? getKnowledgeBaseIdFromPath(pathname) ?? "default";
  const navigationSearchParams = useMemo(() => {
    return new URLSearchParams(searchParams.toString());
  }, [searchParams]);
  const currentKnowledgeBase = knowledgeBases.find((item) => item.id === knowledgeBaseId) ?? null;
  // 文档模块（含录入 / 编辑 / 详情）的二级侧栏由文档列表分组承担。
  const isDocumentsModule = pathname === "/knowledge" || pathname.startsWith("/knowledge/");
  // /qa 模块：侧栏承担聊天记录与会话提问大纲。
  const isQaModule = pathname === "/qa";
  const activeConversationId = searchParams.get("conversationId")?.trim() || null;

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/knowledge-bases", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("知识库列表请求失败");
        }
        return (await response.json()) as { knowledgeBases?: KnowledgeBaseSummary[] };
      })
      .then((payload) => {
        setKnowledgeBases(payload.knowledgeBases ?? []);
        setKnowledgeBasesError(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setKnowledgeBasesError(true);
      })
      .finally(() => {
        setKnowledgeBasesLoading(false);
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      return;
    }
    // 挂载后立即定位，并在 client 水合完成后再定位一次，避免布局变化后偏移
    scrollToHashAnchor(hash);
    const retryTimer = setTimeout(() => scrollToHashAnchor(hash), 350);
    return () => clearTimeout(retryTimer);
  }, [pathname]);

  // 跨路由 Link 导航带 hash 时不触发 hashchange，在 pathname 变化后补一次同步
  useEffect(() => {
    const frame = requestAnimationFrame(() => setCurrentHash(window.location.hash.slice(1)));
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    const syncHash = (): void => setCurrentHash(window.location.hash.slice(1));
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    const narrowQuery = window.matchMedia("(max-width: 959px)");
    const updateNarrow = (): void => {
      setIsNarrow(narrowQuery.matches);
      if (!narrowQuery.matches) {
        // 回到桌面宽度时恢复 localStorage 的折叠语义
        setNarrowSidebarOpen(false);
      }
    };
    updateNarrow();
    narrowQuery.addEventListener("change", updateNarrow);
    return () => narrowQuery.removeEventListener("change", updateNarrow);
  }, []);

  // 窄窗口抽屉打开时支持 Esc 关闭
  useEffect(() => {
    if (!isNarrow || !narrowSidebarOpen) {
      return;
    }
    // 焦点移入抽屉首个可见可聚焦元素（流式渲染可能残留 hidden 旧节点，需过滤）
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(".primary-sidebar a, .primary-sidebar button")).find(
      (el) => el.offsetParent !== null,
    );
    focusable?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setNarrowSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isNarrow, narrowSidebarOpen]);

  useEffect(() => {
    if (!isDocumentsModule) {
      return;
    }

    const controller = new AbortController();

    void fetch(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents?limit=100`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("文档列表请求失败");
        }
        return (await response.json()) as { documents?: SidebarDocument[] };
      })
      .then((payload) => {
        setSidebarDocuments(payload.documents ?? []);
        setSidebarDocumentsForBase(knowledgeBaseId);
        setSidebarDocumentsError(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setSidebarDocumentsError(true);
      });

    return () => controller.abort();
  }, [isDocumentsModule, knowledgeBaseId]);

  // /qa 侧栏：加载会话列表（聊天记录）。
  useEffect(() => {
    if (!isQaModule) {
      return;
    }
    const controller = new AbortController();

    void fetch(`/api/conversations?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("会话列表请求失败");
        }
        return (await response.json()) as { conversations?: SidebarConversation[] };
      })
      .then((payload) => {
        setSidebarConversations(payload.conversations ?? []);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setSidebarConversations([]);
      });

    return () => controller.abort();
  }, [isQaModule, knowledgeBaseId]);

  // /qa 侧栏：加载当前会话的提问大纲（user 消息要点）。
  useEffect(() => {
    if (!isQaModule || !activeConversationId) {
      return;
    }
    const controller = new AbortController();

    void fetch(
      `/api/conversations/${encodeURIComponent(activeConversationId)}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("大纲请求失败");
        }
        return (await response.json()) as { conversation?: { messages?: SidebarOutlineMessage[] } };
      })
      .then((payload) => {
        setSidebarOutline(payload.conversation?.messages ?? []);
        setOutlineError(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setSidebarOutline([]);
        setOutlineError(true);
      });

    return () => controller.abort();
  }, [isQaModule, knowledgeBaseId, activeConversationId]);

  // 问答面板操作（提问 / 重命名 / 归档 / 删除）后刷新侧栏数据。
  useEffect(() => {
    if (!isQaModule) {
      return;
    }
    const refresh = (): void => {
      void fetch(`/api/conversations?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`)
        .then(async (response) => (response.ok ? ((await response.json()) as { conversations?: SidebarConversation[] }) : null))
        .then((payload) => setSidebarConversations(payload?.conversations ?? []))
        .catch(() => setSidebarConversations([]));
      if (activeConversationId) {
        void fetch(
          `/api/conversations/${encodeURIComponent(activeConversationId)}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`,
        )
          .then(async (response) =>
            response.ok ? ((await response.json()) as { conversation?: { messages?: SidebarOutlineMessage[] } }) : null,
          )
          .then((payload) => {
            setSidebarOutline(payload?.conversation?.messages ?? []);
            setOutlineError(false);
          })
          .catch(() => setSidebarOutline([]));
      }
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
  }, [isQaModule, knowledgeBaseId, activeConversationId]);

  async function handleOutlineSave(messageId: string): Promise<void> {
    const title = outlineDraft.trim();
    if (!title || !activeConversationId) {
      return;
    }
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(activeConversationId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ knowledgeBaseId, title }),
        },
      );
      if (!response.ok) {
        throw new Error("要点标题保存失败。");
      }
      setOutlineEditingId(null);
      setOutlineDraft("");
      setSidebarOutline((current) =>
        current ? current.map((item) => (item.id === messageId ? { ...item, title } : item)) : current,
      );
    } catch (error) {
      setOutlineError(true);
    }
  }

  function handleOutlineSelect(messageId: string): void {
    window.dispatchEvent(new CustomEvent<string>(SCROLL_TO_MESSAGE_EVENT, { detail: messageId }));
  }

  function buildQaConversationHref(conversationId: string): string {
    return `/qa?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}&conversationId=${encodeURIComponent(conversationId)}`;
  }

  function openConversationMenu(event: React.MouseEvent<HTMLButtonElement>, conversationId: string): void {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setConversationMenuId(conversationId);
    setConversationMenuAnchor({ top: rect.bottom + 4, left: Math.max(8, rect.right - 168) });
  }

  function closeConversationMenu(): void {
    setConversationMenuId(null);
    setConversationMenuAnchor(null);
  }

  function startConversationRename(conversation: SidebarConversation): void {
    closeConversationMenu();
    setConversationEditingId(conversation.id);
    setConversationDraft(conversation.title);
  }

  async function saveConversationRename(conversationId: string): Promise<void> {
    const title = conversationDraft.trim();
    if (!title) {
      return;
    }
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId, title }),
      });
      if (!response.ok) {
        throw new Error("重命名失败。");
      }
      setConversationEditingId(null);
      setConversationDraft("");
      setSidebarConversations((current) =>
        current ? current.map((item) => (item.id === conversationId ? { ...item, title } : item)) : current,
      );
      window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
    } catch {
      // 失败时保持编辑态，由用户重试。
    }
  }

  async function toggleConversationArchive(conversation: SidebarConversation): Promise<void> {
    closeConversationMenu();
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId, archived: !conversation.archived }),
      });
      if (!response.ok) {
        throw new Error("归档操作失败。");
      }
      window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
    } catch {
      // 失败时由事件刷新兜底；此处静默。
    }
  }

  async function deleteConversationFromSidebar(conversation: SidebarConversation): Promise<void> {
    closeConversationMenu();
    if (!window.confirm(`确认删除会话「${conversation.title}」？会话消息与引用快照将一并删除。`)) {
      return;
    }
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversation.id)}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw new Error("会话删除失败。");
      }
      window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
      // 删除的是当前会话时回到无会话 URL，由问答面板自动打开最近会话。
      if (conversation.id === activeConversationId) {
        router.replace(`/qa?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
      }
    } catch {
      // 失败时保持列表原状，用户可重试。
    }
  }

  // 点击菜单外部或按 Esc 关闭"更多"菜单。
  useEffect(() => {
    if (!conversationMenuId) {
      return;
    }
    const closeOnOutside = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".sidebar-conversation-menu, .sidebar-conversation-more")) {
        return;
      }
      closeConversationMenu();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeConversationMenu();
      }
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [conversationMenuId]);

  async function handleSidebarNewConversation(): Promise<void> {
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId }),
      });
      if (!response.ok) {
        throw new Error("会话创建失败。");
      }
      const payload = (await response.json()) as { conversation: { id: string } };
      setSidebarConversations((current) => [
        { id: payload.conversation.id, title: "新会话", archived: false, messageCount: 0, updatedAt: new Date().toISOString() },
        ...(current ?? []),
      ]);
      router.push(buildQaConversationHref(payload.conversation.id));
    } catch {
      // 侧栏创建失败时由问答面板的新建入口兜底，这里静默即可。
    }
  }

  function handleKnowledgeBaseChange(nextKnowledgeBaseId: string): void {
    router.push(buildKnowledgeBaseSwitchHref(pathname, searchParams, nextKnowledgeBaseId));
  }

  const moduleResizeStartRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [moduleResizing, setModuleResizing] = useState(false);

  function handleModuleResizeStart(event: React.PointerEvent<HTMLDivElement>): void {
    if (!layout.primarySidebarModuleOpen) {
      return;
    }
    moduleResizeStartRef.current = { startY: event.clientY, startHeight: layout.primarySidebarModuleHeight };
    setModuleResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleModuleResizeMove(event: React.PointerEvent<HTMLDivElement>): void {
    const start = moduleResizeStartRef.current;
    if (!start) {
      return;
    }
    const delta = event.clientY - start.startY;
    updateLayout((current) => ({ ...current, primarySidebarModuleHeight: clampModuleHeight(start.startHeight + delta) }));
  }

  function handleModuleResizeEnd(event: React.PointerEvent<HTMLDivElement>): void {
    if (moduleResizeStartRef.current) {
      moduleResizeStartRef.current = null;
      setModuleResizing(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleModuleResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!layout.primarySidebarModuleOpen) {
      return;
    }
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      updateLayout((current) => ({ ...current, primarySidebarModuleHeight: clampModuleHeight(current.primarySidebarModuleHeight + step) }));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      updateLayout((current) => ({ ...current, primarySidebarModuleHeight: clampModuleHeight(current.primarySidebarModuleHeight - step) }));
    } else if (event.key === "Home") {
      event.preventDefault();
      updateLayout((current) => ({ ...current, primarySidebarModuleHeight: MIN_MODULE_HEIGHT }));
    } else if (event.key === "End") {
      event.preventDefault();
      updateLayout((current) => ({ ...current, primarySidebarModuleHeight: MAX_MODULE_HEIGHT }));
    }
  }

  const sidebarResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);

  function handleSidebarResizeStart(event: React.PointerEvent<HTMLDivElement>): void {
    if (layout.primarySidebarCollapsed) {
      return;
    }
    sidebarResizeStartRef.current = { startX: event.clientX, startWidth: layout.primarySidebarWidth };
    setSidebarResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleSidebarResizeMove(event: React.PointerEvent<HTMLDivElement>): void {
    const start = sidebarResizeStartRef.current;
    if (!start) {
      return;
    }
    const delta = event.clientX - start.startX;
    updateLayout((current) => ({ ...current, primarySidebarWidth: clampSidebarWidth(start.startWidth + delta) }));
  }

  function handleSidebarResizeEnd(event: React.PointerEvent<HTMLDivElement>): void {
    if (sidebarResizeStartRef.current) {
      sidebarResizeStartRef.current = null;
      setSidebarResizing(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleSidebarResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (layout.primarySidebarCollapsed) {
      return;
    }
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      updateLayout((current) => ({ ...current, primarySidebarWidth: clampSidebarWidth(current.primarySidebarWidth + step) }));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      updateLayout((current) => ({ ...current, primarySidebarWidth: clampSidebarWidth(current.primarySidebarWidth - step) }));
    } else if (event.key === "Home") {
      event.preventDefault();
      updateLayout((current) => ({ ...current, primarySidebarWidth: MIN_SIDEBAR_WIDTH }));
    } else if (event.key === "End") {
      event.preventDefault();
      updateLayout((current) => ({ ...current, primarySidebarWidth: MAX_SIDEBAR_WIDTH }));
    }
  }

  const sidebarStyle = { "--primary-sidebar-width": `${layout.primarySidebarWidth}px` } as CSSProperties;
  // 窄窗口下抽屉默认收起（narrowSidebarOpen 显式打开），桌面宽度沿用 localStorage 折叠状态
  const sidebarCollapsed = isNarrow ? !narrowSidebarOpen : layout.primarySidebarCollapsed;
  const shellClassName = sidebarCollapsed
    ? "app-shell is-sidebar-collapsed"
    : `app-shell${moduleResizing ? " is-module-resizing" : ""}${sidebarResizing ? " is-sidebar-resizing" : ""}`;

  return (
    <div className={shellClassName} style={sidebarStyle}>
      <div className="workspace-frame">
        <aside className="activity-rail" aria-label="全局导航">
          <Link
            href="/"
            className={`activity-brand${pathname === "/" ? " is-active" : ""}`}
            aria-label="返回 AI 知识库首页"
            title="AI 知识库 · 返回概览"
          >
            <span aria-hidden="true">知</span>
          </Link>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => {
              if (isNarrow) {
                setNarrowSidebarOpen((open) => !open);
              } else {
                updateLayout((current) => ({ ...current, primarySidebarCollapsed: !current.primarySidebarCollapsed }));
              }
            }}
            aria-label={sidebarCollapsed ? "展开二级侧栏" : "收起二级侧栏"}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? "展开二级侧栏" : "收起二级侧栏"}
          >
            <span aria-hidden="true">{sidebarCollapsed ? "›" : "‹"}</span>
          </button>
          <nav className="activity-nav" aria-label="主要模块">
            {activityItems.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={buildNavigationHref(item.href, navigationSearchParams, knowledgeBaseId)}
                  className={`activity-nav-item${active ? " is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  aria-label={item.label}
                  title={item.description}
                >
                  <span className="activity-nav-glyph" aria-hidden="true">{item.glyph}</span>
                  <span className="activity-nav-label">{item.label}</span>
                </Link>
              );
            })}
            <Link
              href={buildNavigationHref(createKnowledgeItem.href, navigationSearchParams, knowledgeBaseId)}
              className={`activity-nav-item is-create${pathname === "/knowledge/new" ? " is-active" : ""}`}
              aria-label={createKnowledgeItem.label}
              title={createKnowledgeItem.description}
            >
              <span className="activity-nav-glyph is-create-glyph" aria-hidden="true">{createKnowledgeItem.glyph}</span>
              <span className="activity-nav-label">{createKnowledgeItem.label}</span>
            </Link>
          </nav>
          <div className="activity-rail-footer">
            <ApiKeySettingsButton />
          </div>
        </aside>

        <aside className="primary-sidebar" aria-label="工作区导航">
          <div className="primary-sidebar-header">
            <div className="knowledge-context">
              <div className="knowledge-context-heading">
                <p className="eyebrow">当前知识库</p>
                <Link className="knowledge-manage-link" href="/knowledge-bases" aria-label="管理知识库" title="知识库列表、新建和批量导入">
                  <span aria-hidden="true">管理知识库</span>
                </Link>
              </div>
              <KnowledgeBaseSwitcher
                knowledgeBases={knowledgeBases}
                currentId={currentKnowledgeBase?.id ?? knowledgeBaseId}
                disabled={knowledgeBasesLoading || knowledgeBases.length === 0}
                onChange={handleKnowledgeBaseChange}
              />
              {currentKnowledgeBase ? (
                <div className="knowledge-context-kind">
                  <span>{getKnowledgeBaseKindLabel(currentKnowledgeBase.kind)}</span>
                  <span>{currentKnowledgeBase.documentCount} 文档 · {currentKnowledgeBase.chunkCount} 切片</span>
                </div>
              ) : knowledgeBasesError ? (
                <span className="knowledge-context-error">知识库状态暂不可用</span>
              ) : (
                <span className="knowledge-context-kind">正在读取库状态…</span>
              )}
            </div>
          </div>

          <div className="primary-sidebar-scroll">
            {secondaryItems.length > 0 ? (
              <>
                <section className="primary-sidebar-section primary-sidebar-module-section" style={{ "--module-section-height": layout.primarySidebarModuleOpen ? `${layout.primarySidebarModuleHeight}px` : "48px" } as CSSProperties}>
                  <button
                    type="button"
                    className="sidebar-section-toggle"
                    onClick={() => updateLayout((current) => ({ ...current, primarySidebarModuleOpen: !current.primarySidebarModuleOpen }))}
                    aria-expanded={layout.primarySidebarModuleOpen}
                  >
                    <span className="sidebar-section-label">{isQaModule ? "聊天记录" : "当前模块"}</span>
                    <span aria-hidden="true">{layout.primarySidebarModuleOpen ? "⌄" : "›"}</span>
                  </button>
                  {layout.primarySidebarModuleOpen ? (
                    isQaModule ? (
                      <nav className="sidebar-conversation-list" aria-label="聊天记录">
                        {sidebarConversations === null ? (
                          <span className="sidebar-conversation-empty">加载会话…</span>
                        ) : sidebarConversations.length === 0 ? (
                          <span className="sidebar-conversation-empty">暂无会话，点击下方新建</span>
                        ) : (
                          sidebarConversations.map((conversation) => {
                            const active = conversation.id === activeConversationId;
                            const editing = conversationEditingId === conversation.id;
                            return (
                              <div key={conversation.id} className={`sidebar-conversation-row${active ? " is-active" : ""}`}>
                                {editing ? (
                                  <div className="sidebar-conversation-edit">
                                    <input
                                      className="input sidebar-conversation-input"
                                      value={conversationDraft}
                                      onChange={(event) => setConversationDraft(event.target.value)}
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                          void saveConversationRename(conversation.id);
                                        } else if (event.key === "Escape") {
                                          setConversationEditingId(null);
                                          setConversationDraft("");
                                        }
                                      }}
                                      autoFocus
                                    />
                                    <button
                                      type="button"
                                      className="sidebar-outline-save"
                                      onClick={() => void saveConversationRename(conversation.id)}
                                    >
                                      保存
                                    </button>
                                    <button
                                      type="button"
                                      className="sidebar-outline-cancel"
                                      onClick={() => {
                                        setConversationEditingId(null);
                                        setConversationDraft("");
                                      }}
                                    >
                                      取消
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className={`sidebar-conversation-item${active ? " is-active" : ""}`}
                                      onClick={() => router.push(buildQaConversationHref(conversation.id))}
                                      title={conversation.title}
                                    >
                                      <span className="sidebar-conversation-title">{conversation.title}</span>
                                      <small className="sidebar-conversation-meta">
                                        {conversation.messageCount} 条{conversation.archived ? " · 已归档" : ""}
                                      </small>
                                    </button>
                                    <button
                                      type="button"
                                      className={`sidebar-conversation-more${conversationMenuId === conversation.id ? " is-open" : ""}`}
                                      aria-label="更多操作"
                                      title="更多操作"
                                      onClick={(event) => openConversationMenu(event, conversation.id)}
                                    >
                                      ⋯
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })
                        )}
                        <button type="button" className="sidebar-conversation-new" onClick={() => void handleSidebarNewConversation()}>
                          ＋ 新建会话
                        </button>
                      </nav>
                    ) : (
                      <nav className="sidebar-nav" aria-label="当前模块导航">
                        {secondaryItems.map((item) => {
                          const [itemPath, itemHash] = item.href.split("#");
                          // 锚点子项按当前 hash 单选；普通子项保持最长匹配单选
                          const active = itemHash
                            ? itemPath === pathname && currentHash === itemHash
                            : getActiveSecondaryHref(pathname, secondaryItems) === item.href;
                          return (
                            <Link
                              key={item.href}
                              href={buildNavigationHref(item.href, navigationSearchParams, knowledgeBaseId)}
                              className={`sidebar-nav-item${active ? " is-active" : ""}`}
                              aria-current={active ? "page" : undefined}
                              onClick={(event) => {
                                // 同一路由内的锚点子项：Next 只改 hash 不滚动，这里接管
                                if (itemPath === pathname && itemHash) {
                                  event.preventDefault();
                                  window.history.pushState(null, "", buildNavigationHref(item.href, navigationSearchParams, knowledgeBaseId));
                                  setCurrentHash(itemHash);
                                  scrollToHashAnchor(itemHash);
                                }
                              }}
                            >
                              <span className="sidebar-nav-index" aria-hidden="true">{item.glyph}</span>
                              <span className="sidebar-nav-copy">
                                <strong>{item.label}</strong>
                                <small>{item.description}</small>
                              </span>
                            </Link>
                          );
                        })}
                      </nav>
                    )
                  ) : null}
                </section>

                {layout.primarySidebarModuleOpen ? (
                  <div
                    className={`sidebar-section-resizer${moduleResizing ? " is-resizing" : ""}`}
                    role="separator"
                    tabIndex={0}
                    aria-orientation="horizontal"
                    aria-label="调整当前模块分组高度"
                    aria-valuemin={MIN_MODULE_HEIGHT}
                    aria-valuemax={MAX_MODULE_HEIGHT}
                    aria-valuenow={layout.primarySidebarModuleHeight}
                    onPointerDown={handleModuleResizeStart}
                    onPointerMove={handleModuleResizeMove}
                    onPointerUp={handleModuleResizeEnd}
                    onPointerCancel={handleModuleResizeEnd}
                    onKeyDown={handleModuleResizeKeyDown}
                  />
                ) : null}
              </>
            ) : null}

            {isDocumentsModule ? (
              <section className="primary-sidebar-section primary-sidebar-documents-section">
                <button
                  type="button"
                  className="sidebar-section-toggle"
                  onClick={() => updateLayout((current) => ({ ...current, primarySidebarDocumentsOpen: !current.primarySidebarDocumentsOpen }))}
                  aria-expanded={layout.primarySidebarDocumentsOpen}
                >
                  <span className="sidebar-section-label">文档列表</span>
                  <span aria-hidden="true">{layout.primarySidebarDocumentsOpen ? "⌄" : "›"}</span>
                </button>
                {layout.primarySidebarDocumentsOpen ? (
                  <nav className="sidebar-document-list" aria-label="当前知识库文档列表">
                    {sidebarDocumentsError ? (
                      <span className="sidebar-document-empty">文档列表暂不可用</span>
                    ) : sidebarDocuments === null || sidebarDocumentsForBase !== knowledgeBaseId ? (
                      <span className="sidebar-document-empty">加载文档…</span>
                    ) : sidebarDocuments.length === 0 ? (
                      <span className="sidebar-document-empty">当前库暂无文档</span>
                    ) : (
                      sidebarDocuments.map((document) => {
                        const active = pathname === `/knowledge/${document.id}`;
                        return (
                          <Link
                            key={document.id}
                            className={`sidebar-document-item${active ? " is-active" : ""}`}
                            href={`/knowledge/${document.id}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`}
                            aria-current={active ? "page" : undefined}
                            title={document.title}
                          >
                            <span className="sidebar-document-status" data-status={document.status} aria-hidden="true" />
                            <span className="sidebar-document-title">{document.title}</span>
                          </Link>
                        );
                      })
                    )}
                  </nav>
                ) : null}
              </section>
            ) : null}

            {currentKnowledgeBase ? (
              <section className="primary-sidebar-section primary-sidebar-context-section">
                <button
                  type="button"
                  className="sidebar-section-toggle"
                  onClick={() => updateLayout((current) => ({ ...current, primarySidebarContextOpen: !current.primarySidebarContextOpen }))}
                  aria-expanded={layout.primarySidebarContextOpen}
                >
                  <span className="sidebar-section-label">{isQaModule ? "提问大纲" : "知识库工具"}</span>
                  <span aria-hidden="true">{layout.primarySidebarContextOpen ? "⌄" : "›"}</span>
                </button>
                {layout.primarySidebarContextOpen ? (
                  isQaModule ? (
                    <nav className="sidebar-outline-list" aria-label="提问大纲">
                      {!activeConversationId ? (
                        <span className="sidebar-outline-empty">打开会话后显示每次提问的要点</span>
                      ) : outlineError ? (
                        <span className="sidebar-outline-empty">大纲暂不可用</span>
                      ) : sidebarOutline === null ? (
                        <span className="sidebar-outline-empty">加载大纲…</span>
                      ) : sidebarOutline.filter((message) => message.role === "user").length === 0 ? (
                        <span className="sidebar-outline-empty">这个会话还没有提问</span>
                      ) : (
                        sidebarOutline
                          .filter((message) => message.role === "user")
                          .map((message, index) =>
                            outlineEditingId === message.id ? (
                              <div key={message.id} className="sidebar-outline-item is-editing">
                                <input
                                  className="input sidebar-outline-input"
                                  value={outlineDraft}
                                  onChange={(event) => setOutlineDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      void handleOutlineSave(message.id);
                                    } else if (event.key === "Escape") {
                                      setOutlineEditingId(null);
                                      setOutlineDraft("");
                                    }
                                  }}
                                  autoFocus
                                />
                                <button type="button" className="sidebar-outline-save" onClick={() => void handleOutlineSave(message.id)}>
                                  保存
                                </button>
                                <button
                                  type="button"
                                  className="sidebar-outline-cancel"
                                  onClick={() => {
                                    setOutlineEditingId(null);
                                    setOutlineDraft("");
                                  }}
                                >
                                  取消
                                </button>
                              </div>
                            ) : (
                              <div key={message.id} className="sidebar-outline-item">
                                <button
                                  type="button"
                                  className="sidebar-outline-main"
                                  onClick={() => handleOutlineSelect(message.id)}
                                  title={message.content}
                                >
                                  <span className="sidebar-outline-index">{index + 1}</span>
                                  <span className="sidebar-outline-title">{message.title ?? "（未命名）"}</span>
                                </button>
                                <button
                                  type="button"
                                  className="sidebar-outline-edit"
                                  aria-label="编辑要点"
                                  title="编辑要点"
                                  onClick={() => {
                                    setOutlineEditingId(message.id);
                                    setOutlineDraft(message.title ?? "");
                                  }}
                                >
                                  ✎
                                </button>
                              </div>
                            ),
                          )
                      )}
                    </nav>
                  ) : (
                    <nav className="sidebar-context-links" aria-label="当前知识库工具">
                      <Link
                        className="sidebar-context-link"
                        href={`/knowledge-bases/${encodeURIComponent(currentKnowledgeBase.id)}/vector-index?knowledgeBaseId=${encodeURIComponent(currentKnowledgeBase.id)}`}
                      >
                        <span>语义索引</span>
                        <small>{getEmbeddingStatusLabel(currentKnowledgeBase)}</small>
                      </Link>
                      {/* 同步源入口与同步状态按真实同步根判定（与知识库卡片、新增知识页口径一致），
                          kind 标签仍保留库类型语义（如开发数据）。 */}
                      {currentKnowledgeBase.sync ? (
                        <Link
                          className="sidebar-context-link"
                          href={`/knowledge-bases/${encodeURIComponent(currentKnowledgeBase.id)}/sync?knowledgeBaseId=${encodeURIComponent(currentKnowledgeBase.id)}`}
                        >
                          <span>同步源</span>
                          <small>{getSyncStatusLabel(currentKnowledgeBase.sync)}</small>
                        </Link>
                      ) : null}
                    </nav>
                  )
                ) : null}
              </section>
            ) : null}
          </div>

          <div className="primary-sidebar-footer">
            {currentKnowledgeBase ? (
              <div className="knowledge-context-footer">
                <span className="knowledge-context-index-dot" data-status={currentKnowledgeBase.embedding.status} aria-hidden="true" />
                <span>{getEmbeddingStatusLabel(currentKnowledgeBase)}</span>
              </div>
            ) : null}
            <div className="primary-sidebar-note">
              <span className="status-dot" aria-hidden="true" />
              <div>
                <strong>本机模式</strong>
                <span>数据和索引仅在本机运行</span>
              </div>
            </div>
          </div>
        </aside>

        {conversationMenuId && conversationMenuAnchor ? (
          <div className="sidebar-conversation-menu" role="menu" style={{ top: conversationMenuAnchor.top, left: conversationMenuAnchor.left }}>
            {(() => {
              const menuConversation = sidebarConversations?.find((item) => item.id === conversationMenuId);
              if (!menuConversation) {
                return null;
              }
              return (
                <>
                  <button type="button" role="menuitem" onClick={() => startConversationRename(menuConversation)}>
                    <span aria-hidden="true">✎</span>
                    重命名
                  </button>
                  <button type="button" role="menuitem" onClick={() => void toggleConversationArchive(menuConversation)}>
                    <span aria-hidden="true">{menuConversation.archived ? "↩" : "▤"}</span>
                    {menuConversation.archived ? "恢复" : "归档"}
                  </button>
                  <button type="button" role="menuitem" className="is-danger" onClick={() => void deleteConversationFromSidebar(menuConversation)}>
                    <span aria-hidden="true">✕</span>
                    删除
                  </button>
                </>
              );
            })()}
          </div>
        ) : null}

        <div
          className={`sidebar-width-resizer${sidebarResizing ? " is-resizing" : ""}`}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="调整二级侧栏宽度"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={layout.primarySidebarWidth}
          onPointerDown={handleSidebarResizeStart}
          onPointerMove={handleSidebarResizeMove}
          onPointerUp={handleSidebarResizeEnd}
          onPointerCancel={handleSidebarResizeEnd}
          onKeyDown={handleSidebarResizeKeyDown}
        />

        <div className="workspace-column">
          <header className="workspace-topbar">
            <div className="workspace-topbar-heading">
              <div>
                <p className="workspace-kicker">LOCAL KNOWLEDGE WORKSPACE</p>
                <h1>AI 知识库管理平台</h1>
              </div>
            </div>
            <div className="workspace-topbar-meta">
              <span className="workspace-mode-badge">离线优先</span>
              <span className="workspace-path-label">{pathname === "/" ? "概览" : pathname.replace(/^\//, "").split("/")[0]}</span>
            </div>
          </header>
          <main className="page-shell workspace-content">{children}</main>
        </div>
      </div>
      {/* 窄窗口抽屉遮罩：点击关闭；不遮住左侧一级导航 */}
      {isNarrow && narrowSidebarOpen ? (
        <div
          className="sidebar-drawer-scrim"
          aria-hidden="true"
          onClick={() => setNarrowSidebarOpen(false)}
        />
      ) : null}
    </div>
  );
}

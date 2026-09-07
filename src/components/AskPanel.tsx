"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import { useRouter, useSearchParams } from "next/navigation";

import { AppAuxiliaryPanel } from "@/components/AppAuxiliaryPanel";
import { useApiKeySettings } from "@/components/ApiKeySettingsProvider";
import { MarkdownArticle } from "@/components/MarkdownArticle";
import { notifyConversationsChanged, SCROLL_TO_MESSAGE_EVENT } from "@/lib/conversation-events";
import { qaPanelWidthStore } from "@/lib/panel-width";
import {
  RUNTIME_EMBEDDING_API_KEY_HEADER,
  RUNTIME_EMBEDDING_BASE_URL_HEADER,
  RUNTIME_EMBEDDING_MODEL_HEADER,
  RUNTIME_LLM_API_KEY_HEADER,
  RUNTIME_LLM_BASE_URL_HEADER,
  RUNTIME_LLM_MODEL_HEADER,
} from "@/lib/runtime-keys";

type ConversationCitation = {
  documentId: string;
  title: string;
  sourcePath: string;
};

type ConversationSummary = {
  id: string;
  knowledgeBaseId: string;
  title: string;
  archived: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: ConversationCitation[];
  retrievalMode: "llm" | "extractive" | "empty" | null;
  createdAt: string;
  title: string | null;
};

type ConversationDetail = ConversationSummary & {
  messages: ConversationMessage[];
};

type DocumentPreview = {
  id: string;
  title: string;
  content: string;
  frontmatter: string | null;
};

export function AskPanel({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlConversationId = searchParams.get("conversationId")?.trim() || null;
  const { llmApiKey, llmBaseURL, llmModel, embeddingApiKey, embeddingBaseURL, embeddingModel } = useApiKeySettings();
  // 当前会话由 URL conversationId 驱动：侧栏聊天记录、浏览器前进后退与面板内切换共用同一来源。
  const activeId = urlConversationId;
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [question, setQuestion] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  // 当前选中消息中预览的来源文档（null 表示第一条）
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [previewErrorFor, setPreviewErrorFor] = useState<string | null>(null);
  const [previewErrorText, setPreviewErrorText] = useState<string | null>(null);
  // 会话总结为知识草稿的状态
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const qaPanelWidth = useSyncExternalStore(qaPanelWidthStore.subscribe, qaPanelWidthStore.read, qaPanelWidthStore.getServer);
  const [qaResizing, setQaResizing] = useState(false);
  const qaResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const currentDetail = activeId && detail?.id === activeId ? detail : null;
  const selectedMessage = useMemo(
    () => currentDetail?.messages.find((message) => message.id === selectedMessageId) ?? null,
    [currentDetail, selectedMessageId],
  );
  const selectedSources = useMemo(
    () => (selectedMessage?.role === "assistant" ? selectedMessage.citations : []),
    [selectedMessage],
  );
  // 当前预览的来源：点击来源项切换；未指定时取第一条。useMemo 保证引用稳定，避免预览 effect 每次渲染重跑。
  const activePreviewSource = useMemo(
    () => selectedSources.find((source) => source.documentId === previewSourceId) ?? selectedSources[0] ?? null,
    [selectedSources, previewSourceId],
  );
  const previewLoading = activePreviewSource !== null && preview?.id !== activePreviewSource.documentId;
  const previewError =
    previewErrorFor !== null && activePreviewSource !== null && previewErrorFor === activePreviewSource.documentId
      ? previewErrorText
      : null;

  const loadConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    const result = await fetch(`/api/conversations?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
    if (!result.ok) {
      throw new Error("会话列表读取失败。");
    }
    const payload = (await result.json()) as { conversations: ConversationSummary[] };
    return payload.conversations;
  }, [knowledgeBaseId]);

  const loadDetail = useCallback(async (conversationId: string): Promise<ConversationDetail> => {
    const result = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`,
    );
    if (!result.ok) {
      throw new Error("会话读取失败。");
    }
    const payload = (await result.json()) as { conversation: ConversationDetail };
    return payload.conversation;
  }, [knowledgeBaseId]);

  // 切换会话同时同步 URL（侧栏聊天记录通过 conversationId 联动）。
  const selectConversation = useCallback(
    (conversationId: string | null): void => {
      const params = new URLSearchParams();
      params.set("knowledgeBaseId", knowledgeBaseId);
      if (conversationId) {
        params.set("conversationId", conversationId);
      }
      router.replace(`/qa?${params.toString()}`);
    },
    [knowledgeBaseId, router],
  );

  // 初始加载：打开最近一个未归档会话；没有会话时显示空状态。
  useEffect(() => {
    let cancelled = false;
    void loadConversations()
      .then((items) => {
        if (cancelled) {
          return;
        }
        const first = items.find((item) => !item.archived) ?? items[0];
        if (first && !urlConversationId) {
          selectConversation(first.id);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "会话加载失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadConversations, selectConversation, urlConversationId]);

  // 切换会话时加载消息。
  useEffect(() => {
    if (!activeId) {
      return;
    }
    let cancelled = false;
    void loadDetail(activeId)
      .then((conversation) => {
        if (!cancelled) {
          setDetail(conversation);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "会话加载失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, loadDetail]);

  // 新消息或发送中自动滚动到底部。
  useEffect(() => {
    const list = messageListRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [detail?.messages.length, isSending]);

  // 侧栏提问大纲点击后定位到对应消息。
  useEffect(() => {
    const scrollToMessage = (event: Event): void => {
      const messageId = (event as CustomEvent<string>).detail;
      if (!messageId || !messageListRef.current) {
        return;
      }
      const target = messageListRef.current.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(SCROLL_TO_MESSAGE_EVENT, scrollToMessage);
    return () => window.removeEventListener(SCROLL_TO_MESSAGE_EVENT, scrollToMessage);
  }, []);

  // 点击引用后加载文档内容用于面板内渲染；点击新来源只替换当前预览。
  useEffect(() => {
    const source = activePreviewSource;
    if (!source) {
      return;
    }
    const controller = new AbortController();
    const sourceDocumentId = source.documentId;

    void fetch(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(sourceDocumentId)}`, {
      signal: controller.signal,
    })
      .then(async (result) => {
        if (!result.ok) {
          throw new Error("文档读取失败");
        }
        return (await result.json()) as DocumentPreview;
      })
      .then((payload) => {
        setPreview(payload);
        setPreviewErrorFor(null);
        setPreviewErrorText(null);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        setPreviewErrorFor(sourceDocumentId);
        setPreviewErrorText(loadError instanceof Error ? loadError.message : "文档读取失败。");
      });

    return () => controller.abort();
  }, [knowledgeBaseId, selectedSources, activePreviewSource]);

  async function refreshAfterChange(nextActiveId: string | null = activeId): Promise<void> {
    if (nextActiveId && activeId === nextActiveId) {
      setDetail(await loadDetail(nextActiveId));
    }
  }

  async function handleCreate(): Promise<void> {
    setError(null);
    try {
      const result = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId }),
      });
      if (!result.ok) {
        const payload = (await result.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "会话创建失败。");
      }
      const payload = (await result.json()) as { conversation: ConversationDetail };
      selectConversation(payload.conversation.id);
      notifyConversationsChanged();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "会话创建失败。");
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextQuestion = question.trim();
    if (!nextQuestion || !activeId || isSending) {
      return;
    }
    setError(null);

    const optimisticUserMessage: ConversationMessage = {
      id: `pending-${Date.now()}`,
      role: "user",
      title: null,
      content: nextQuestion,
      citations: [],
      retrievalMode: null,
      createdAt: new Date().toISOString(),
    };
    setDetail((current) => (current ? { ...current, messages: [...current.messages, optimisticUserMessage] } : current));
    setQuestion("");
    setIsSending(true);

    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (llmApiKey) {
        headers[RUNTIME_LLM_API_KEY_HEADER] = llmApiKey;
      }
      if (llmBaseURL) {
        headers[RUNTIME_LLM_BASE_URL_HEADER] = llmBaseURL;
      }
      if (llmModel) {
        headers[RUNTIME_LLM_MODEL_HEADER] = llmModel;
      }
      if (embeddingApiKey) {
        headers[RUNTIME_EMBEDDING_API_KEY_HEADER] = embeddingApiKey;
      }
      if (embeddingBaseURL) {
        headers[RUNTIME_EMBEDDING_BASE_URL_HEADER] = embeddingBaseURL;
      }
      if (embeddingModel) {
        headers[RUNTIME_EMBEDDING_MODEL_HEADER] = embeddingModel;
      }

      const result = await fetch(`/api/conversations/${encodeURIComponent(activeId)}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ question: nextQuestion, knowledgeBaseId }),
      });

      if (!result.ok) {
        const payload = (await result.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "问答请求失败。");
      }

      const payload = (await result.json()) as {
        message: ConversationMessage;
        answer: string;
        retrievalMode: "llm" | "extractive" | "empty";
        sources: ConversationCitation[];
      };
      const assistantMessage: ConversationMessage = {
        id: payload.message.id,
        role: "assistant",
        title: payload.message.title,
        content: payload.answer,
        citations: payload.sources,
        retrievalMode: payload.retrievalMode,
        createdAt: payload.message.createdAt,
      };
      setDetail((current) => (current ? { ...current, messages: [...current.messages, assistantMessage] } : current));
      setSelectedMessageId(assistantMessage.id);
      void refreshAfterChange(activeId);
      notifyConversationsChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "问答请求失败。");
      setDetail((current) =>
        current ? { ...current, messages: current.messages.filter((message) => message.id !== optimisticUserMessage.id) } : current,
      );
      setQuestion(nextQuestion);
    } finally {
      setIsSending(false);
    }
  }

  function handleQaResizeStart(event: React.PointerEvent<HTMLDivElement>): void {
    qaResizeStartRef.current = { startX: event.clientX, startWidth: qaPanelWidth };
    setQaResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleQaResizeMove(event: React.PointerEvent<HTMLDivElement>): void {
    const start = qaResizeStartRef.current;
    if (!start) {
      return;
    }
    // resizer 位于面板左边缘：向右拖表示面板变窄
    qaPanelWidthStore.update(start.startWidth - (event.clientX - start.startX));
  }

  function handleQaResizeEnd(event: React.PointerEvent<HTMLDivElement>): void {
    if (qaResizeStartRef.current) {
      qaResizeStartRef.current = null;
      setQaResizing(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleQaResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      qaPanelWidthStore.update(qaPanelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      qaPanelWidthStore.update(qaPanelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      qaPanelWidthStore.update(qaPanelWidthStore.max);
    } else if (event.key === "End") {
      event.preventDefault();
      qaPanelWidthStore.update(qaPanelWidthStore.min);
    }
  }

  // 将当前会话总结为待审核知识草稿（CREATE，PENDING）；不直接写入知识库。
  async function handleSummarizeDraft(): Promise<void> {
    if (!activeId) {
      return;
    }
    setDraftBusy(true);
    setDraftNotice(null);
    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (llmApiKey) {
        headers[RUNTIME_LLM_API_KEY_HEADER] = llmApiKey;
      }
      if (llmBaseURL) {
        headers[RUNTIME_LLM_BASE_URL_HEADER] = llmBaseURL;
      }
      if (llmModel) {
        headers[RUNTIME_LLM_MODEL_HEADER] = llmModel;
      }
      const result = await fetch(`/api/conversations/${encodeURIComponent(activeId)}/summarize-draft`, {
        method: "POST",
        headers,
        body: JSON.stringify({ knowledgeBaseId }),
      });
      if (!result.ok) {
        const payload = (await result.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "会话总结失败。");
      }
      setDraftNotice("会话已总结为草稿，请到「草稿中心」审核后应用。");
      notifyConversationsChanged();
    } catch (summarizeError) {
      setError(summarizeError instanceof Error ? summarizeError.message : "会话总结失败。");
    } finally {
      setDraftBusy(false);
    }
  }

  return (
    <div
      className={`qa-layout${qaResizing ? " is-qa-resizing" : ""}`}
      style={{ "--qa-panel-width": `${qaPanelWidth}px` } as CSSProperties}
    >
      <div className="qa-main-column">
        <section className="qa-question-panel conv-panel">
          {error ? (
            <p className="error-text qa-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="conv-message-list" ref={messageListRef}>
            {!currentDetail ? (
              <div className="conv-empty">
                <p className="section-kicker">START</p>
                <p>还没有打开的会话。</p>
                <button type="button" className="button primary" onClick={() => void handleCreate()}>
                  新建会话并开始提问
                </button>
              </div>
            ) : currentDetail.messages.length === 0 ? (
              <div className="conv-empty">
                <p className="section-kicker">START</p>
                <p>这是会话「{currentDetail.title}」的第一条消息。描述具体对象、条件和希望比较的范围，便于检索命中准确证据。</p>
              </div>
            ) : (
              currentDetail.messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="conv-message conv-message-user" data-message-id={message.id}>
                    <div className="conv-message-body">{message.content}</div>
                  </div>
                ) : (
                  <div key={message.id} className="conv-message conv-message-assistant" data-message-id={message.id}>
                    <div className="conv-message-meta">
                      <span className="conv-message-mode">
                        {message.retrievalMode === "llm"
                          ? "大模型归纳"
                          : message.retrievalMode === "extractive"
                            ? "检索摘录"
                            : message.retrievalMode === "empty"
                              ? "未命中"
                              : "回答"}
                      </span>
                      {message.citations.length > 0 ? (
                        <button
                          type="button"
                          className={`conv-citation-toggle${selectedMessageId === message.id ? " is-active" : ""}`}
                          onClick={() => {
                            setSelectedMessageId(message.id);
                            setPreviewSourceId(null);
                          }}
                        >
                          {message.citations.length} 条引用
                        </button>
                      ) : null}
                    </div>
                    <div className="conv-message-content markdown-body">
                      <MarkdownArticle content={message.content} frontmatter={null} />
                    </div>
                  </div>
                ),
              )
            )}
            {isSending ? (
              <div className="conv-message conv-message-assistant">
                <div className="conv-message-body conv-message-pending">正在检索并组织回答…</div>
              </div>
            ) : null}
          </div>

          <form className="qa-question-field" onSubmit={(event) => void handleSubmit(event)}>
            <label className="field">
              <span>继续提问</span>
              <textarea
                className="textarea qa-question-input conv-question-input"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={currentDetail ? "追问细节、比较或要求总结…" : "先新建会话，再开始提问…"}
                disabled={!currentDetail || isSending}
              />
            </label>
            <div className="qa-question-actions">
              <span className="field-helper">多轮回答只基于当前知识库检索到的证据；未配置模型时会退化为检索摘录回答。</span>
              <span className="qa-draft-actions">
                {currentDetail && currentDetail.messages.length > 0 ? (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={draftBusy}
                    title="将本会话内容总结为待审核知识草稿（需要 LLM Key）"
                    onClick={() => void handleSummarizeDraft()}
                  >
                    {draftBusy ? "总结中…" : "总结为草稿"}
                  </button>
                ) : null}
                <button type="submit" className="button primary" disabled={!detail || isSending || !question.trim()}>
                  {isSending ? "回答中…" : "发送"}
                </button>
              </span>
            </div>
            {draftNotice ? (
              <p className="qa-draft-notice">
                {draftNotice}
                <a href={`/drafts?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`}>前往草稿中心</a>
              </p>
            ) : null}
          </form>
        </section>
      </div>

      {selectedMessage ? (
        <>
          <div
            className={`qa-panel-resizer${qaResizing ? " is-resizing" : ""}`}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="调整引用面板宽度"
            aria-valuemin={qaPanelWidthStore.min}
            aria-valuemax={qaPanelWidthStore.max}
            aria-valuenow={qaPanelWidth}
            onPointerDown={handleQaResizeStart}
            onPointerMove={handleQaResizeMove}
            onPointerUp={handleQaResizeEnd}
            onPointerCancel={handleQaResizeEnd}
            onKeyDown={handleQaResizeKeyDown}
          />
          <AppAuxiliaryPanel kicker="SOURCES" title="引用来源" note={`${selectedSources.length} 条来源`}>
            {selectedSources.length === 0 ? (
              <p className="muted-text">当前没有可展示的来源。</p>
            ) : (
              <>
                <ul className="source-list qa-source-list">
                  {selectedSources.map((source) => (
                    <li key={source.documentId}>
                      <button
                        type="button"
                        className={`qa-source-item${activePreviewSource?.documentId === source.documentId ? " is-active" : ""}`}
                        onClick={() => setPreviewSourceId(source.documentId)}
                        title={`在面板内预览：${source.title}`}
                      >
                        <strong>{source.title}</strong>
                        <span>{source.sourcePath}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="qa-source-preview">
                  <div className="qa-source-preview-heading">
                    <p className="section-kicker">PREVIEW</p>
                    <h3>{activePreviewSource?.title ?? "文档预览"}</h3>
                  </div>
                  {previewError ? (
                    <p className="error-text">{previewError}</p>
                  ) : previewLoading ? (
                    <p className="muted-text">加载文档…</p>
                  ) : preview ? (
                    <MarkdownArticle content={preview.content} frontmatter={preview.frontmatter} knowledgeBaseId={knowledgeBaseId} />
                  ) : (
                    <p className="muted-text">点击上方来源查看文档预览。</p>
                  )}
                </div>
              </>
            )}
          </AppAuxiliaryPanel>
        </>
      ) : null}
    </div>
  );
}

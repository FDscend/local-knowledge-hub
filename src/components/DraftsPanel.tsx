"use client";

import { useCallback, useMemo, useState } from "react";

import { MarkdownArticle } from "@/components/MarkdownArticle";

export type DraftListItem = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName?: string;
  kind: "CREATE" | "PATCH" | "DISABLE";
  documentTitle: string;
  status: "PENDING" | "APPLIED" | "REJECTED";
  sourceTool: string;
  createdAt: string;
};

type DraftCitation = {
  documentId: string;
  title: string;
  sourcePath: string;
};

type PatchPayload = {
  before: string;
  after: string;
};

type DraftDetail = DraftListItem & {
  contentMarkdown: string;
  patch: PatchPayload | null;
  changeReason: string | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  modelInfo: string | null;
  citations: DraftCitation[];
  appliedDocumentId: string | null;
  appliedVersionId: string | null;
  appliedAt: string | null;
  rejectedAt: string | null;
};

const KIND_LABELS: Record<DraftListItem["kind"], string> = {
  CREATE: "新建",
  PATCH: "修改",
  DISABLE: "停用",
};

const STATUS_LABELS: Record<DraftListItem["status"], string> = {
  PENDING: "待审核",
  APPLIED: "已应用",
  REJECTED: "已拒绝",
};

const TOOL_LABELS: Record<string, string> = {
  create_document_draft: "创建文档提案",
  propose_document_patch: "修改文档提案",
  disable_document: "停用文档提案",
  summarize_conversation_to_draft: "会话总结",
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 简易行级 diff（LCS）：返回带 +/-/空格 前缀的行，用于审核变更差异。
type DiffLine = { prefix: "+" | "-" | " "; text: string };

function lineDiff(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ prefix: " ", text: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ prefix: "-", text: left[i] });
      i += 1;
    } else {
      result.push({ prefix: "+", text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    result.push({ prefix: "-", text: left[i] });
    i += 1;
  }
  while (j < right.length) {
    result.push({ prefix: "+", text: right[j] });
    j += 1;
  }
  return result;
}

export function DraftsPanel({ drafts }: { drafts: DraftListItem[] }) {
  const [statusFilter, setStatusFilter] = useState<"ALL" | DraftListItem["status"]>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null);

  const filtered = useMemo(
    () => (statusFilter === "ALL" ? drafts : drafts.filter((draft) => draft.status === statusFilter)),
    [drafts, statusFilter],
  );

  const selected = useMemo(
    () => (selectedId && detail?.id === selectedId ? detail : null),
    [selectedId, detail],
  );

  const loadDetail = useCallback(async (draftId: string, baseId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await fetch(
        `/api/drafts/${encodeURIComponent(draftId)}?knowledgeBaseId=${encodeURIComponent(baseId)}`,
      );
      if (!result.ok) {
        const payload = (await result.json()) as { error?: string };
        throw new Error(payload.error ?? "草稿读取失败。");
      }
      const payload = (await result.json()) as { draft: DraftDetail };
      setDetail(payload.draft);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "草稿读取失败。");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleApply = useCallback(async () => {
    if (!selected) {
      return;
    }
    const kindLabel = KIND_LABELS[selected.kind];
    const confirmed = window.confirm(
      `确认应用该${kindLabel}草稿《${selected.documentTitle}》？\n\n应用后：\n${
        selected.kind === "CREATE" ? "· 创建正式文档并写入切片与版本\n· 立即参与检索与问答" : selected.kind === "PATCH" ? "· 覆盖文档正文并保留历史版本\n· 重建切片与全文索引" : "· 文档状态改为已停用，不再进入检索\n· 历史版本保留，可随时重新启用"
      }`,
    );
    if (!confirmed) {
      return;
    }
    setActionBusy(true);
    setAppliedNotice(null);
    try {
      const result = await fetch(`/api/drafts/${encodeURIComponent(selected.id)}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: selected.knowledgeBaseId }),
      });
      if (!result.ok) {
        const payload = (await result.json()) as { error?: string };
        throw new Error(payload.error ?? "草稿应用失败。");
      }
      const payload = (await result.json()) as { draft: DraftDetail };
      setDetail(payload.draft);
      setAppliedNotice("草稿已应用。");
      window.location.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "草稿应用失败。");
    } finally {
      setActionBusy(false);
    }
  }, [selected]);

  const handleReject = useCallback(async () => {
    if (!selected) {
      return;
    }
    const confirmed = window.confirm(`确认拒绝草稿《${selected.documentTitle}》？拒绝后不会修改任何知识。`);
    if (!confirmed) {
      return;
    }
    setActionBusy(true);
    setAppliedNotice(null);
    try {
      const result = await fetch(`/api/drafts/${encodeURIComponent(selected.id)}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: selected.knowledgeBaseId }),
      });
      if (!result.ok) {
        const payload = (await result.json()) as { error?: string };
        throw new Error(payload.error ?? "草稿拒绝失败。");
      }
      const payload = (await result.json()) as { draft: DraftDetail };
      setDetail(payload.draft);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "草稿拒绝失败。");
    } finally {
      setActionBusy(false);
    }
  }, [selected]);

  const handleDelete = useCallback(async () => {
    if (!selected) {
      return;
    }
    const confirmed = window.confirm(`确认删除草稿《${selected.documentTitle}》？`);
    if (!confirmed) {
      return;
    }
    setActionBusy(true);
    setAppliedNotice(null);
    try {
      const result = await fetch(
        `/api/drafts/${encodeURIComponent(selected.id)}?knowledgeBaseId=${encodeURIComponent(selected.knowledgeBaseId)}`,
        { method: "DELETE" },
      );
      if (!result.ok) {
        const payload = (await result.json()) as { error?: string };
        throw new Error(payload.error ?? "草稿删除失败。");
      }
      setSelectedId(null);
      setDetail(null);
      window.location.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "草稿删除失败。");
    } finally {
      setActionBusy(false);
    }
  }, [selected]);

  const diffLines = useMemo(
    () => (selected?.patch ? lineDiff(selected.patch.before, selected.patch.after) : null),
    [selected],
  );

  return (
    <section className="drafts-layout">
      <aside className="drafts-list-column">
        <div className="drafts-list-toolbar">
          <span className="drafts-count">{filtered.length} 条草稿</span>
          <select
            className="input drafts-status-filter"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "ALL" | DraftListItem["status"])}
            aria-label="按状态筛选草稿"
          >
            <option value="ALL">全部状态</option>
            <option value="PENDING">待审核</option>
            <option value="APPLIED">已应用</option>
            <option value="REJECTED">已拒绝</option>
          </select>
        </div>
        {filtered.length === 0 ? (
          <div className="drafts-empty">当前没有草稿。助手在问答中提出创建 / 修改 / 停用知识时，提案会出现在这里等待审核。</div>
        ) : (
          <ul className="drafts-list">
            {filtered.map((draft) => (
              <li key={draft.id}>
                <button
                  type="button"
                  className={`drafts-list-item ${draft.id === selectedId ? "is-active" : ""}`}
                  onClick={() => {
                    setSelectedId(draft.id);
                    void loadDetail(draft.id, draft.knowledgeBaseId);
                  }}
                >
                  <span className={`drafts-kind-badge kind-${draft.kind.toLowerCase()}`}>{KIND_LABELS[draft.kind]}</span>
                  <span className="drafts-list-copy">
                    <strong>{draft.documentTitle}</strong>
                    <small>
                      {TOOL_LABELS[draft.sourceTool] ?? draft.sourceTool}
                      {draft.knowledgeBaseName ? ` · ${draft.knowledgeBaseName}` : ""} · {formatTime(draft.createdAt)}
                    </small>
                  </span>
                  <span className={`drafts-status-badge status-${draft.status.toLowerCase()}`}>{STATUS_LABELS[draft.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="drafts-detail-column">
        {detailLoading ? (
          <div className="drafts-detail-placeholder">正在读取草稿…</div>
        ) : detailError ? (
          <div className="drafts-detail-placeholder drafts-detail-error">{detailError}</div>
        ) : !selected ? (
          <div className="drafts-detail-placeholder">选择左侧草稿，审阅完整内容与变更差异后再应用。</div>
        ) : (
          <article className="drafts-detail">
            <header className="drafts-detail-header">
              <div className="drafts-detail-title-row">
                <span className={`drafts-kind-badge kind-${selected.kind.toLowerCase()}`}>{KIND_LABELS[selected.kind]}</span>
                <h3>{selected.documentTitle}</h3>
                <span className={`drafts-status-badge status-${selected.status.toLowerCase()}`}>{STATUS_LABELS[selected.status]}</span>
              </div>
              <dl className="drafts-detail-meta">
                <div>
                  <dt>提案工具</dt>
                  <dd>{TOOL_LABELS[selected.sourceTool] ?? selected.sourceTool}</dd>
                </div>
                {selected.changeReason ? (
                  <div>
                    <dt>变更理由</dt>
                    <dd>{selected.changeReason}</dd>
                  </div>
                ) : null}
                {selected.sourceConversationId ? (
                  <div>
                    <dt>来源会话</dt>
                    <dd>{selected.sourceConversationId}</dd>
                  </div>
                ) : null}
                {selected.modelInfo ? (
                  <div>
                    <dt>生成模型</dt>
                    <dd>{selected.modelInfo}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>创建时间</dt>
                  <dd>{formatTime(selected.createdAt)}</dd>
                </div>
                {selected.appliedAt ? (
                  <div>
                    <dt>应用时间</dt>
                    <dd>{formatTime(selected.appliedAt)}</dd>
                  </div>
                ) : null}
              </dl>
              {selected.citations.length > 0 ? (
                <div className="drafts-detail-citations">
                  <strong>提案依据来源</strong>
                  <ul>
                    {selected.citations.map((citation) => (
                      <li key={citation.documentId}>
                        <a href={`/knowledge/${citation.documentId}?knowledgeBaseId=${encodeURIComponent(selected.knowledgeBaseId)}`}>
                          {citation.title}
                        </a>
                        <small>{citation.sourcePath}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {actionError ? <p className="drafts-action-error">{actionError}</p> : null}
              {appliedNotice ? <p className="drafts-action-notice">{appliedNotice}</p> : null}
            </header>

            {diffLines ? (
              <section className="drafts-diff-section">
                <h4>变更差异（{selected.patch ? "原文 vs 提案" : ""}）</h4>
                <div className="drafts-diff-view">
                  {diffLines.map((line, index) => (
                    <div key={index} className={`drafts-diff-line ${line.prefix === "+" ? "is-added" : line.prefix === "-" ? "is-removed" : ""}`}>
                      <span className="drafts-diff-prefix">{line.prefix}</span>
                      <code>{line.text || " "}</code>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="drafts-preview-section">
              <h4>完整 Markdown（应用后内容）</h4>
              <div className="drafts-preview-body">
                <MarkdownArticle content={selected.contentMarkdown} knowledgeBaseId={selected.knowledgeBaseId} />
              </div>
            </section>

            {selected.status === "PENDING" ? (
              <footer className="drafts-detail-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={actionBusy}
                  onClick={() => void handleApply()}
                >
                  应用草稿
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={actionBusy}
                  onClick={() => void handleReject()}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={actionBusy}
                  onClick={() => void handleDelete()}
                >
                  删除
                </button>
              </footer>
            ) : (
              <footer className="drafts-detail-actions">
                {selected.status === "REJECTED" ? (
                  <button
                    type="button"
                    className="button danger"
                    disabled={actionBusy}
                    onClick={() => void handleDelete()}
                  >
                    删除记录
                  </button>
                ) : null}
              </footer>
            )}
          </article>
        )}
      </div>
    </section>
  );
}

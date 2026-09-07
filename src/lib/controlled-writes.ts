import { DocumentStatus, ImportSourceMode, IngestMode, KnowledgeSourceKind, SourceType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import matter from "gray-matter";
import OpenAI from "openai";
import { z } from "zod";

import { getConversationDetail } from "@/lib/conversations";
import { rebuildKnowledgeBaseFtsIndex } from "@/lib/fts";
import { chunkMarkdown } from "@/lib/ingest";
import { hashContent, requireKnowledgeBase } from "@/lib/knowledge-base";
import { getLlmConfig } from "@/lib/llm";
import { prisma } from "@/lib/prisma";
import { createManualSlug } from "@/lib/slug";

// 单机本地管理员标识（与会话服务一致）。
const LOCAL_USER_ID = "local-user";

// 助手工具白名单：只允许这几种"提案型"工具；它们只创建 PENDING 草稿，
// 不直接修改任何知识。真正写入（apply）必须由本机用户在 UI 中确认。
export const DRAFT_TOOL_WHITELIST = ["create_document_draft", "propose_document_patch", "disable_document"] as const;

export type DraftToolName = (typeof DRAFT_TOOL_WHITELIST)[number];

export type DraftKind = "CREATE" | "PATCH" | "DISABLE";
export type DraftStatus = "PENDING" | "APPLIED" | "REJECTED";

export type DraftCitation = {
  documentId: string;
  title: string;
  sourcePath: string;
};

export type DocumentDraftSummary = {
  id: string;
  knowledgeBaseId: string;
  kind: DraftKind;
  documentId: string | null;
  documentTitle: string;
  status: DraftStatus;
  sourceTool: string;
  createdAt: string;
  updatedAt: string;
};

export type PatchPayload = {
  before: string;
  after: string;
};

export type DocumentDraftDetail = DocumentDraftSummary & {
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

// LLM 工具提案：模型只能输出此受控结构；服务层按白名单校验后落为 PENDING 草稿。
export type ToolProposal = {
  tool: DraftToolName;
  documentId?: string;
  documentTitle: string;
  markdown?: string;
  changeReason?: string;
};

const toolProposalSchema = z.object({
  tool: z.enum(DRAFT_TOOL_WHITELIST),
  documentId: z.string().min(1).max(200).optional(),
  documentTitle: z.string().min(1).max(200).optional(),
  markdown: z.string().min(1).optional(),
  changeReason: z.string().min(1).max(2000).optional(),
});

// 回答中模型以 <proposals>...</proposals> 输出受控 JSON；解析失败的部分被忽略，不影响回答本身。
const PROPOSAL_BLOCK_PATTERN = /<proposals>([\s\S]*?)<\/proposals>/g;

export function parseToolProposals(text: string): ToolProposal[] {
  const proposals: ToolProposal[] = [];
  for (const match of text.matchAll(PROPOSAL_BLOCK_PATTERN)) {
    try {
      const parsed = JSON.parse(match[1]?.trim() ?? "[]") as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const result = toolProposalSchema.safeParse(item);
        if (result.success) {
          // 模型可能省略 documentTitle（例如只给出 documentId）；缺省回退为 documentId。
          proposals.push({
            ...result.data,
            documentTitle: result.data.documentTitle ?? result.data.documentId ?? "未命名文档",
          });
        }
      }
    } catch {
      // 忽略无法解析的提案块。
    }
  }
  return proposals;
}

function toSummary(draft: Prisma.DocumentDraftGetPayload<Record<string, never>>): DocumentDraftSummary {
  const kind: DraftKind =
    draft.kind === "PATCH" || draft.kind === "DISABLE" || draft.kind === "CREATE" ? draft.kind : "CREATE";
  const status: DraftStatus =
    draft.status === "PENDING" || draft.status === "APPLIED" || draft.status === "REJECTED" ? draft.status : "PENDING";
  return {
    id: draft.id,
    knowledgeBaseId: draft.knowledgeBaseId,
    kind,
    documentId: draft.documentId,
    documentTitle: draft.documentTitle,
    status,
    sourceTool: draft.sourceTool,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function toDetail(draft: Prisma.DocumentDraftGetPayload<Record<string, never>>): DocumentDraftDetail {
  let patch: PatchPayload | null = null;
  if (draft.patchJson) {
    try {
      const parsed = JSON.parse(draft.patchJson) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as PatchPayload).before === "string" &&
        typeof (parsed as PatchPayload).after === "string"
      ) {
        patch = parsed as PatchPayload;
      }
    } catch {
      patch = null;
    }
  }
  let citations: DraftCitation[] = [];
  if (draft.citationsJson) {
    try {
      const parsed = JSON.parse(draft.citationsJson) as unknown;
      if (Array.isArray(parsed)) {
        citations = parsed.filter(
          (item): item is DraftCitation =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as DraftCitation).documentId === "string" &&
            typeof (item as DraftCitation).title === "string",
        );
      }
    } catch {
      citations = [];
    }
  }
  return {
    ...toSummary(draft),
    contentMarkdown: draft.contentMarkdown,
    patch,
    changeReason: draft.changeReason,
    sourceConversationId: draft.sourceConversationId,
    sourceMessageId: draft.sourceMessageId,
    modelInfo: draft.modelInfo,
    citations,
    appliedDocumentId: draft.appliedDocumentId,
    appliedVersionId: draft.appliedVersionId,
    appliedAt: draft.appliedAt?.toISOString() ?? null,
    rejectedAt: draft.rejectedAt?.toISOString() ?? null,
  };
}

async function requireOwnedDraft(draftId: string, knowledgeBaseId: string): Promise<
  Prisma.DocumentDraftGetPayload<Record<string, never>>
> {
  const draft = await prisma.documentDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.knowledgeBaseId !== knowledgeBaseId) {
    throw new Error("草稿不存在或不属于当前知识库。");
  }
  return draft;
}

type CreateDraftProposalInput = {
  knowledgeBaseId: string;
  kind: DraftKind;
  documentId?: string | null;
  documentTitle: string;
  markdown?: string | null;
  changeReason?: string | null;
  sourceTool: string;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  modelInfo?: string | null;
  citations?: DraftCitation[];
};

function tagsFromMarkdown(markdown: string): string {
  const parsed = matter(markdown);
  const tags = Array.isArray(parsed.data.tags)
    ? parsed.data.tags.map((tag) => String(tag).trim())
    : typeof parsed.data.tags === "string"
      ? parsed.data.tags.split(/[\n,]/).map((tag) => tag.trim())
      : [];
  return Array.from(new Set(tags.filter(Boolean))).join(", ");
}

function summarize(markdown: string): string {
  const content = matter(markdown).content.replace(/\s+/g, " ").trim();
  return content.length > 180 ? `${content.slice(0, 180).trim()}...` : content;
}

// 校验并创建 PENDING 草稿（受控写入的唯一入口；所有修改必须先经此处）。
export async function createDraftProposal(input: CreateDraftProposalInput): Promise<DocumentDraftDetail> {
  await requireKnowledgeBase(input.knowledgeBaseId);
  const normalizedTitle = input.documentTitle.trim();
  if (!normalizedTitle) {
    throw new Error("草稿标题不能为空。");
  }
  const normalizedMarkdown = input.markdown?.trim() ?? "";
  if (input.kind !== "DISABLE" && !normalizedMarkdown) {
    throw new Error("创建或修改文档的草稿必须包含完整 Markdown 内容。");
  }
  if (input.kind === "DISABLE" && !input.documentId) {
    throw new Error("停用草稿必须指定目标文档。");
  }

  let patchJson: string | null = null;
  if (input.kind === "PATCH" || input.kind === "DISABLE") {
    // 模型可能把标题当 documentId 传出：先按 ID 查找，失败后按标题在当前知识库内回退。
    let document = await prisma.knowledgeDocument.findFirst({
      where: { id: input.documentId ?? "", knowledgeBaseId: input.knowledgeBaseId },
    });
    if (!document && input.documentId && input.documentId !== input.documentTitle) {
      document = await prisma.knowledgeDocument.findFirst({
        where: { knowledgeBaseId: input.knowledgeBaseId, title: input.documentId },
      });
    }
    if (!document) {
      throw new Error("目标文档不存在或不属于当前知识库。");
    }
    const pending = await prisma.documentDraft.findFirst({
      where: { knowledgeBaseId: input.knowledgeBaseId, documentId: document.id, status: "PENDING" },
    });
    if (pending) {
      throw new Error(`该文档已有待审核草稿（${pending.documentTitle}），请先处理后再发起新提案。`);
    }
    if (input.kind === "PATCH") {
      patchJson = JSON.stringify({ before: document.content, after: normalizedMarkdown });
    } else {
      // 停用草稿也保存当前正文，便于审核时预览原文。
      patchJson = JSON.stringify({ before: document.content, after: document.content });
      return await persistDraft({
        ...input,
        documentId: document.id,
        documentTitle: document.title,
        markdown: document.content,
        changeReason: input.changeReason ?? "停用过时或无效文档",
        patchJson,
      });
    }
    return await persistDraft({
      ...input,
      documentId: document.id,
      documentTitle: normalizedTitle,
      markdown: normalizedMarkdown,
      patchJson,
    });
  }

  return await persistDraft({ ...input, documentTitle: normalizedTitle, markdown: normalizedMarkdown, patchJson });
}

async function persistDraft(input: CreateDraftProposalInput & { patchJson?: string | null }): Promise<DocumentDraftDetail> {
  const draft = await prisma.$transaction(async (transaction) => {
    const created = await transaction.documentDraft.create({
      data: {
        knowledgeBaseId: input.knowledgeBaseId,
        kind: input.kind,
        documentId: input.documentId ?? null,
        documentTitle: input.documentTitle,
        contentMarkdown: input.markdown ?? "",
        patchJson: input.patchJson ?? null,
        changeReason: input.changeReason ?? null,
        status: "PENDING",
        sourceTool: input.sourceTool,
        sourceConversationId: input.sourceConversationId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        modelInfo: input.modelInfo ?? null,
        citationsJson: input.citations?.length ? JSON.stringify(input.citations) : null,
      },
    });
    await transaction.auditLog.create({
      data: {
        knowledgeBaseId: input.knowledgeBaseId,
        actor: LOCAL_USER_ID,
        action: "draft-created",
        targetType: "DocumentDraft",
        targetId: created.id,
        beforeData: JSON.stringify({ kind: input.kind, tool: input.sourceTool }),
        afterData: JSON.stringify({
          documentId: input.documentId ?? null,
          title: input.documentTitle,
          changeReason: input.changeReason ?? null,
        }),
      },
    });
    return created;
  });
  return toDetail(draft);
}

export async function listDrafts(knowledgeBaseId: string): Promise<DocumentDraftSummary[]> {
  await requireKnowledgeBase(knowledgeBaseId);
  const drafts = await prisma.documentDraft.findMany({
    where: { knowledgeBaseId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return drafts.map(toSummary);
}

export async function getDraft(draftId: string, knowledgeBaseId: string): Promise<DocumentDraftDetail> {
  await requireKnowledgeBase(knowledgeBaseId);
  const draft = await requireOwnedDraft(draftId, knowledgeBaseId);
  return toDetail(draft);
}

async function rewriteChunks(
  transaction: Prisma.TransactionClient,
  documentId: string,
  content: string,
  ingestMode: IngestMode,
  title: string,
): Promise<void> {
  const chunks = chunkMarkdown(content, ingestMode, title);
  await transaction.knowledgeChunk.deleteMany({ where: { documentId } });
  if (chunks.length === 0) {
    return;
  }
  await transaction.knowledgeChunk.createMany({
    data: chunks.map((chunk, index) => ({
      documentId,
      chunkIndex: index,
      heading: chunk.heading,
      sectionPath: chunk.sectionPath,
      content: chunk.content,
      tokenEstimate: chunk.tokenEstimate,
    })),
  });
}

async function applyCreate(draft: Prisma.DocumentDraftGetPayload<Record<string, never>>): Promise<{
  documentId: string;
  versionId: string;
}> {
  const parsed = matter(draft.contentMarkdown);
  const frontmatter = Object.keys(parsed.data).length > 0 ? JSON.stringify(parsed.data) : null;
  const body = parsed.content.trim() || draft.contentMarkdown;
  const contentHash = hashContent(body);

  return await prisma.$transaction(async (transaction) => {
    const source = await transaction.knowledgeSource.create({
      data: {
        knowledgeBaseId: draft.knowledgeBaseId,
        kind: KnowledgeSourceKind.MANUAL,
        importMode: ImportSourceMode.SNAPSHOT,
        canonicalPathOrUrl: `manual://draft-${draft.id}`,
        contentHash,
        lastSeenAt: new Date(),
        syncStatus: "SNAPSHOT",
      },
    });
    const document = await transaction.knowledgeDocument.create({
      data: {
        knowledgeBaseId: draft.knowledgeBaseId,
        sourceId: source.id,
        slug: createManualSlug(draft.documentTitle),
        title: draft.documentTitle,
        summary: summarize(body),
        tagsText: tagsFromMarkdown(draft.contentMarkdown),
        domain: "",
        sourceType: SourceType.MANUAL,
        sourcePath: `草稿导入（${draft.sourceTool}）`,
        sourceUrl: null,
        status: DocumentStatus.ACTIVE,
        ingestMode: IngestMode.HEADING_CHUNKS,
        content: body,
        frontmatter,
      },
    });
    const version = await transaction.documentVersion.create({
      data: {
        documentId: document.id,
        contentMarkdown: body,
        contentHash,
        createdBy: LOCAL_USER_ID,
        changeReason: `draft-apply:${draft.sourceTool}`,
      },
    });
    await transaction.knowledgeDocument.update({
      where: { id: document.id },
      data: { currentVersionId: version.id },
    });
    await rewriteChunks(transaction, document.id, body, IngestMode.HEADING_CHUNKS, draft.documentTitle);
    return { documentId: document.id, versionId: version.id };
  });
}

async function applyPatch(draft: Prisma.DocumentDraftGetPayload<Record<string, never>>): Promise<{
  documentId: string;
  versionId: string;
}> {
  if (!draft.documentId) {
    throw new Error("修改草稿缺少目标文档。");
  }
  const document = await prisma.knowledgeDocument.findFirst({
    where: { id: draft.documentId, knowledgeBaseId: draft.knowledgeBaseId },
  });
  if (!document) {
    throw new Error("目标文档不存在或不属于当前知识库。");
  }
  const parsed = matter(draft.contentMarkdown);
  const frontmatter = Object.keys(parsed.data).length > 0 ? JSON.stringify(parsed.data) : null;
  const body = parsed.content.trim() || draft.contentMarkdown;
  const contentHash = hashContent(body);

  return await prisma.$transaction(async (transaction) => {
    const updated = await transaction.knowledgeDocument.update({
      where: { id: document.id },
      data: {
        title: draft.documentTitle,
        summary: summarize(body),
        tagsText: tagsFromMarkdown(draft.contentMarkdown),
        content: body,
        frontmatter,
      },
    });
    const version = await transaction.documentVersion.create({
      data: {
        documentId: document.id,
        contentMarkdown: body,
        contentHash,
        createdBy: LOCAL_USER_ID,
        changeReason: `draft-apply:${draft.sourceTool}`,
      },
    });
    await transaction.knowledgeDocument.update({
      where: { id: document.id },
      data: { currentVersionId: version.id },
    });
    await rewriteChunks(transaction, document.id, body, document.ingestMode ?? IngestMode.HEADING_CHUNKS, updated.title);
    return { documentId: document.id, versionId: version.id };
  });
}

// 本机用户审核后应用草稿：CREATE / PATCH 写入版本与切片，DISABLE 停用文档。
export async function applyDraft(draftId: string, knowledgeBaseId: string): Promise<DocumentDraftDetail> {
  const draft = await requireOwnedDraft(draftId, knowledgeBaseId);
  if (draft.status !== "PENDING") {
    throw new Error("只有待审核草稿可以应用。");
  }

  let appliedDocumentId: string;
  let appliedVersionId: string | null;
  if (draft.kind === "CREATE") {
    const result = await applyCreate(draft);
    appliedDocumentId = result.documentId;
    appliedVersionId = result.versionId;
  } else if (draft.kind === "PATCH") {
    const result = await applyPatch(draft);
    appliedDocumentId = result.documentId;
    appliedVersionId = result.versionId;
  } else {
    if (!draft.documentId) {
      throw new Error("停用草稿缺少目标文档。");
    }
    const document = await prisma.knowledgeDocument.findFirst({
      where: { id: draft.documentId, knowledgeBaseId },
    });
    if (!document) {
      throw new Error("目标文档不存在或不属于当前知识库。");
    }
    await prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: { status: DocumentStatus.DISABLED },
    });
    appliedDocumentId = document.id;
    appliedVersionId = null;
  }

  await rebuildKnowledgeBaseFtsIndex(knowledgeBaseId);

  const updated = await prisma.$transaction(async (transaction) => {
    const changed = await transaction.documentDraft.update({
      where: { id: draft.id },
      data: {
        status: "APPLIED",
        appliedDocumentId,
        appliedVersionId,
        appliedAt: new Date(),
      },
    });
    await transaction.auditLog.create({
      data: {
        knowledgeBaseId,
        actor: LOCAL_USER_ID,
        action: "draft-applied",
        targetType: "DocumentDraft",
        targetId: draft.id,
        beforeData: JSON.stringify({ kind: draft.kind, tool: draft.sourceTool }),
        afterData: JSON.stringify({ documentId: appliedDocumentId, versionId: appliedVersionId }),
      },
    });
    return changed;
  });
  return toDetail(updated);
}

export async function rejectDraft(draftId: string, knowledgeBaseId: string, reason?: string | null): Promise<DocumentDraftDetail> {
  const draft = await requireOwnedDraft(draftId, knowledgeBaseId);
  if (draft.status !== "PENDING") {
    throw new Error("只有待审核草稿可以拒绝。");
  }
  const updated = await prisma.$transaction(async (transaction) => {
    const changed = await transaction.documentDraft.update({
      where: { id: draft.id },
      data: { status: "REJECTED", rejectedAt: new Date(), changeReason: reason?.trim() || draft.changeReason },
    });
    await transaction.auditLog.create({
      data: {
        knowledgeBaseId,
        actor: LOCAL_USER_ID,
        action: "draft-rejected",
        targetType: "DocumentDraft",
        targetId: draft.id,
        afterData: JSON.stringify({ reason: reason?.trim() ?? null }),
      },
    });
    return changed;
  });
  return toDetail(updated);
}

export async function deleteDraft(draftId: string, knowledgeBaseId: string): Promise<void> {
  const draft = await requireOwnedDraft(draftId, knowledgeBaseId);
  if (draft.status === "APPLIED") {
    throw new Error("已应用的草稿保留审计记录，不能删除。");
  }
  await prisma.$transaction(async (transaction) => {
    await transaction.auditLog.create({
      data: {
        knowledgeBaseId,
        actor: LOCAL_USER_ID,
        action: "draft-deleted",
        targetType: "DocumentDraft",
        targetId: draft.id,
        afterData: JSON.stringify({ status: draft.status }),
      },
    });
    await transaction.documentDraft.delete({ where: { id: draft.id } });
  });
}

// 将选定会话总结为新知识草稿（CREATE，PENDING）。需要 LLM Key；来源与引用随草稿保存。
export async function summarizeConversationToDraft(
  conversationId: string,
  knowledgeBaseId: string,
  llmOverrides: { llmApiKey?: string | null; llmBaseURL?: string | null; llmModel?: string | null } = {},
): Promise<DocumentDraftDetail> {
  const detail = await getConversationDetail(conversationId, knowledgeBaseId);
  const llmConfig = getLlmConfig({
    apiKeyOverride: llmOverrides.llmApiKey,
    baseURLOverride: llmOverrides.llmBaseURL,
    modelOverride: llmOverrides.llmModel,
  });
  if (!llmConfig.apiKey) {
    throw new Error("未配置 LLM API Key，无法总结会话。");
  }

  const transcript = detail.messages
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
    .join("\n\n");
  if (!transcript.trim()) {
    throw new Error("会话还没有消息，无法总结。");
  }

  const client = new OpenAI({
    apiKey: llmConfig.apiKey,
    baseURL: llmConfig.baseURL,
  });
  const completion = await client.chat.completions.create({
    model: llmConfig.model,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "你是知识库整理助手。请把对话整理为结构清晰的 Markdown 知识笔记，包含：一级标题、概述、要点列表、结论与注意事项。只能整理对话中出现过的事实，不要编造或外推。直接输出 Markdown 正文，不要输出额外说明。",
      },
      {
        role: "user",
        content: `会话标题：${detail.title}\n\n对话记录：\n${transcript}`,
      },
    ],
  });
  const markdown = completion.choices[0]?.message?.content?.trim();
  if (!markdown) {
    throw new Error("模型未能生成总结内容。");
  }

  const title =
    detail.title === "新会话"
      ? (markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "会话总结")
      : detail.title;
  const citations = Array.from(
    new Map(
      detail.messages
        .flatMap((message) => message.citations)
        .map((citation) => [citation.documentId, citation]),
    ).values(),
  );

  return createDraftProposal({
    knowledgeBaseId,
    kind: "CREATE",
    documentTitle: title,
    markdown,
    changeReason: `由会话「${detail.title}」总结生成`,
    sourceTool: "summarize_conversation_to_draft",
    sourceConversationId: conversationId,
    modelInfo: llmConfig.model,
    citations,
  });
}

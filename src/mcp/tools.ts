import { DocumentStatus, type Prisma } from "@prisma/client";

import { answerQuestion, searchRelevantChunksDetailed } from "@/lib/rag";
import { prisma } from "@/lib/prisma";
import { getLlmConfig } from "@/lib/llm";
import { understandQuery } from "@/lib/query-understanding";
import { MCP_LIMITS, requireAllowedKnowledgeBase, requireQueryWithinLimit, resolveAllowedKnowledgeBaseIds } from "@/mcp/config";

const MCP_ACTOR = "mcp-client";

type AuditData = {
  knowledgeBaseId: string;
  action: string;
  targetType: string;
  targetId: string;
  afterData: Record<string, unknown>;
};

async function writeAudit(entry: AuditData): Promise<void> {
  await prisma.auditLog.create({
    data: {
      knowledgeBaseId: entry.knowledgeBaseId,
      actor: MCP_ACTOR,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      afterData: JSON.stringify(entry.afterData),
    },
  });
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}…（内容已截断）`, truncated: true };
}

/** 按总字符预算截断结果数组中的切片正文，超出部分标记 truncated。 */
function truncateChunkContents(chunks: Array<{ content: string }>): { content: string; truncated: boolean }[] {
  let budget: number = MCP_LIMITS.maxResultChars;
  return chunks.map((chunk) => {
    const { text, truncated } = truncateText(chunk.content, Math.min(MCP_LIMITS.maxChunkChars, budget));
    budget = Math.max(0, budget - text.length);
    return { content: text, truncated };
  });
}

export type ListKnowledgeBasesResult = Array<{
  id: string;
  name: string;
  description: string | null;
  defaultLanguage: string;
  documentCount: number;
  chunkCount: number;
}>;

export async function listKnowledgeBases(nameFilter?: string): Promise<ListKnowledgeBasesResult> {
  const { ids, warnings } = await resolveAllowedKnowledgeBaseIds();
  const normalizedFilter = nameFilter?.trim().toLowerCase();

  const knowledgeBases = await prisma.knowledgeBase.findMany({
    where: { id: { in: Array.from(ids) } },
    include: {
      _count: { select: { documents: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const filtered = normalizedFilter
    ? knowledgeBases.filter((kb) => kb.name.toLowerCase().includes(normalizedFilter) || kb.id.toLowerCase().includes(normalizedFilter))
    : knowledgeBases;

  const chunkCounts = await Promise.all(
    filtered.map((kb) => prisma.knowledgeChunk.count({ where: { document: { knowledgeBaseId: kb.id } } })),
  );

  const result: ListKnowledgeBasesResult = filtered.map((kb, index) => ({
    id: kb.id,
    name: kb.name,
    description: kb.description,
    defaultLanguage: kb.defaultLanguage,
    documentCount: kb._count.documents,
    chunkCount: chunkCounts[index],
  }));

  await writeAudit({
    knowledgeBaseId: filtered[0]?.id ?? "default",
    action: "mcp-list-knowledge-bases",
    targetType: "KnowledgeBase",
    targetId: filtered.map((kb) => kb.id).join(",") || "none",
    afterData: { nameFilter: normalizedFilter ?? null, resultCount: result.length, warnings },
  });
  return result;
}

export type SearchKnowledgeItem = {
  chunkId: string;
  documentId: string;
  title: string;
  sectionPath: string;
  sourcePath: string;
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  content: string;
  contentTruncated: boolean;
};

export type SearchKnowledgeResult = {
  knowledgeBaseId: string;
  query: string;
  queryMode: "llm" | "fallback";
  resultCount: number;
  results: SearchKnowledgeItem[];
};

export async function searchKnowledge(
  knowledgeBaseId: string,
  query: string,
  limit = 5,
): Promise<SearchKnowledgeResult> {
  const { ids, warnings } = await resolveAllowedKnowledgeBaseIds();
  requireAllowedKnowledgeBase(knowledgeBaseId, ids);

  const normalizedQuery = requireQueryWithinLimit(query);
  const normalizedLimit = Math.min(Math.max(1, Math.floor(limit)), MCP_LIMITS.maxSearchLimit);

  const llmConfig = getLlmConfig({});
  const queryUnderstanding = llmConfig.apiKey ? await understandQuery(normalizedQuery, {}) : undefined;
  const { chunks, debug } = await searchRelevantChunksDetailed(normalizedQuery, knowledgeBaseId, normalizedLimit, {}, {}, queryUnderstanding);

  const contents = truncateChunkContents(chunks);
  const results: SearchKnowledgeItem[] = chunks.map((chunk, index) => ({
    chunkId: chunk.id,
    documentId: chunk.document.id,
    title: chunk.document.title,
    sectionPath: chunk.sectionPath,
    sourcePath: chunk.document.sourcePath,
    score: chunk.score,
    lexicalRank: chunk.lexicalRank,
    vectorRank: chunk.vectorRank,
    content: contents[index].content,
    contentTruncated: contents[index].truncated,
  }));

  await writeAudit({
    knowledgeBaseId,
    action: "mcp-search-knowledge",
    targetType: "KnowledgeBase",
    targetId: knowledgeBaseId,
    afterData: {
      query: normalizedQuery.slice(0, MCP_LIMITS.maxAuditQueryLength),
      queryMode: debug.queryMode,
      resultCount: results.length,
      limit: normalizedLimit,
      warnings,
    },
  });
  return { knowledgeBaseId, query: normalizedQuery, queryMode: debug.queryMode, resultCount: results.length, results };
}

export type Citation = {
  chunkId: string;
  documentId: string;
  title: string;
  sectionPath: string;
  sourcePath: string;
};

export type AskKnowledgeBaseResult = {
  knowledgeBaseId: string;
  question: string;
  answer: string;
  answerTruncated: boolean;
  citations: Citation[];
  insufficientEvidence: boolean;
  retrievalMode: "llm" | "extractive" | "empty";
};

export async function askKnowledgeBase(knowledgeBaseId: string, question: string): Promise<AskKnowledgeBaseResult> {
  const { ids, warnings } = await resolveAllowedKnowledgeBaseIds();
  requireAllowedKnowledgeBase(knowledgeBaseId, ids);

  const normalizedQuestion = requireQueryWithinLimit(question);
  // 无状态问答：不保存会话。检索使用 LLM 查询理解（若配置了环境变量 Key）。
  const result = await answerQuestion(normalizedQuestion, { knowledgeBaseId });

  // 引用需要切片级证据：以确定性检索（fallback，不额外消耗 LLM）补齐引用列表。
  const evidence = await searchRelevantChunksDetailed(normalizedQuestion, knowledgeBaseId, 5, {}, {}, undefined).catch(() => null);
  const citations: Citation[] = evidence
    ? Array.from(
        new Map(
          evidence.chunks.map((chunk) => [
            chunk.id,
            {
              chunkId: chunk.id,
              documentId: chunk.document.id,
              title: chunk.document.title,
              sectionPath: chunk.sectionPath,
              sourcePath: chunk.document.sourcePath,
            },
          ]),
        ).values(),
      )
    : [];

  const { text, truncated } = truncateText(result.answer, MCP_LIMITS.maxResultChars);
  const insufficientEvidence = result.retrievalMode === "empty" || citations.length === 0;

  await writeAudit({
    knowledgeBaseId,
    action: "mcp-ask-knowledge-base",
    targetType: "KnowledgeBase",
    targetId: knowledgeBaseId,
    afterData: {
      question: normalizedQuestion.slice(0, MCP_LIMITS.maxAuditQueryLength),
      retrievalMode: result.retrievalMode,
      citationCount: citations.length,
      insufficientEvidence,
      answerLength: text.length,
      warnings,
    },
  });
  return {
    knowledgeBaseId,
    question: normalizedQuestion,
    answer: text,
    answerTruncated: truncated,
    citations,
    insufficientEvidence,
    retrievalMode: result.retrievalMode,
  };
}

export type DocumentExcerptResult = {
  knowledgeBaseId: string;
  documentId: string;
  title: string;
  sourcePath: string;
  sourceUrl: string | null;
  updatedAt: string;
  tags: string[];
  excerpt: string;
  excerptTruncated: boolean;
  /** 按 chunkId 查询时返回对应切片；按 documentId 查询时为 null。 */
  chunk: { chunkId: string; sectionPath: string } | null;
};

export async function getDocumentExcerpt(
  knowledgeBaseId: string,
  target: { documentId?: string; chunkId?: string },
): Promise<DocumentExcerptResult> {
  const { ids, warnings } = await resolveAllowedKnowledgeBaseIds();
  requireAllowedKnowledgeBase(knowledgeBaseId, ids);

  const baseWhere: Prisma.KnowledgeChunkWhereInput = {
    document: { knowledgeBaseId, status: DocumentStatus.ACTIVE },
  };

  let chunk: Prisma.KnowledgeChunkGetPayload<{ include: { document: true } }> | null = null;
  if (target.chunkId) {
    chunk = await prisma.knowledgeChunk.findFirst({
      where: { ...baseWhere, id: target.chunkId },
      include: { document: true },
    });
  } else if (target.documentId) {
    chunk = await prisma.knowledgeChunk.findFirst({
      where: { ...baseWhere, documentId: target.documentId },
      include: { document: true },
      orderBy: { chunkIndex: "asc" },
    });
  } else {
    throw new Error("必须提供 documentId 或 chunkId。");
  }

  if (!chunk) {
    throw new Error("未找到可访问的文档或切片（可能不存在、已停用或不属于该知识库）。");
  }

  const { text, truncated } = truncateText(chunk.content, MCP_LIMITS.maxExcerptChars);

  await writeAudit({
    knowledgeBaseId,
    action: "mcp-get-document-excerpt",
    targetType: target.chunkId ? "KnowledgeChunk" : "KnowledgeDocument",
    targetId: target.chunkId ?? target.documentId ?? "",
    afterData: {
      documentId: chunk.document.id,
      excerptLength: text.length,
      warnings,
    },
  });
  return {
    knowledgeBaseId,
    documentId: chunk.document.id,
    title: chunk.document.title,
    sourcePath: chunk.document.sourcePath,
    sourceUrl: chunk.document.sourceUrl,
    updatedAt: chunk.document.updatedAt.toISOString(),
    tags: chunk.document.tagsText
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    excerpt: text,
    excerptTruncated: truncated,
    chunk: target.chunkId ? { chunkId: chunk.id, sectionPath: chunk.sectionPath } : null,
  };
}

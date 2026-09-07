import { DocumentStatus, type Prisma } from "@prisma/client";
import OpenAI from "openai";

import { getLlmConfig } from "@/lib/llm";
import { parseToolProposals, type ToolProposal } from "@/lib/controlled-writes";
import { understandQuery } from "@/lib/query-understanding";
import { searchVectorChunkIds } from "@/lib/embedding";
import { searchFtsChunkIds } from "@/lib/fts";
import { prisma } from "@/lib/prisma";
import { initializeKnowledgeBaseState, requireKnowledgeBase } from "@/lib/knowledge-base";
import { getProductionRetrievalConfig } from "@/lib/retrieval-config";

type SearchChunk = Prisma.KnowledgeChunkGetPayload<{
  include: {
    document: true;
  };
}>;

type ScoredChunk = SearchChunk & {
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  rrfScore: number;
};

export const RETRIEVAL_CONFIG = {
  channelTopK: 30,
  rrfK: 60,
  mmrLambda: 0.7,
  rrfScoreWeight: 1,
} as const;

export type RetrievalConfigOverrides = {
  channelTopK?: number;
  rrfK?: number;
  mmrLambda?: number;
  rrfScoreWeight?: number;
};

export function resolveRetrievalConfig(overrides: RetrievalConfigOverrides = {}): Required<RetrievalConfigOverrides> {
  return {
    channelTopK: overrides.channelTopK ?? RETRIEVAL_CONFIG.channelTopK,
    rrfK: overrides.rrfK ?? RETRIEVAL_CONFIG.rrfK,
    mmrLambda: overrides.mmrLambda ?? RETRIEVAL_CONFIG.mmrLambda,
    rrfScoreWeight: overrides.rrfScoreWeight ?? RETRIEVAL_CONFIG.rrfScoreWeight,
  };
}

export type RetrievalDebugCandidate = {
  chunkId: string;
  documentId: string;
  title: string;
  sectionPath: string;
  score: number;
  rrfScore: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  initialRank: number;
  selectedRank: number | null;
  selectionReason: string | null;
};

export type RetrievalDebugSnapshot = {
  query: string;
  terms: string[];
  queryMode: "llm" | "fallback";
  llmKeywords: string[] | null;
  semanticQuery: string | null;
  queryUnderstandingWarning: string | null;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  mergedCandidateCount: number;
  finalLimit: number;
  candidates: RetrievalDebugCandidate[];
};

export type DetailedSearchResult = {
  chunks: ScoredChunk[];
  debug: RetrievalDebugSnapshot;
};

export type AnswerQuestionOptions = {
  llmApiKey?: string | null;
  llmBaseURL?: string | null;
  llmModel?: string | null;
  embeddingApiKey?: string | null;
  embeddingBaseURL?: string | null;
  embeddingModel?: string | null;
  /** 同一会话内的近期对话轮次；仅作为生成背景，不参与检索。 */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 允许模型输出受控知识管理提案（<proposals> 块）；提案只落为待审核草稿。 */
  toolProposals?: boolean;
};

export type AnswerQuestionResult = {
  answer: string;
  sources: Array<{ documentId: string; title: string; sourcePath: string }>;
  retrievalMode: "llm" | "extractive" | "empty";
  /** 模型提出的受控写入提案；仅当 toolProposals 开启且模型按格式输出时才可能非空。 */
  toolProposals: ToolProposal[];
};

function stripMarkdown(input: string): string {
  return input
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`>*_-]/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForCompare(input: string | null | undefined): string {
  return (input ?? "").toLowerCase();
}

function expandCjkTerms(segment: string): string[] {
  const terms = [segment];
  const maxSize = Math.min(4, segment.length);

  for (let size = 2; size <= maxSize; size += 1) {
    for (let start = 0; start <= segment.length - size; start += 1) {
      terms.push(segment.slice(start, start + size));
    }
  }

  return terms;
}

function extractSearchTerms(question: string): string[] {
  const stopTerms = new Set([
    "什么",
    "什么是",
    "为什么",
    "如何",
    "怎么",
    "区别",
    "关系",
    "时候",
    "应该",
    "各自",
    "以及",
    "一个",
    "一种",
    "哪些",
    "哪个",
    "哪篇",
    "哪些笔记",
    "哪些笔记包含",
    "笔记",
    "包含",
    "或者",
  ]);
  const asciiTerms = question.match(/[A-Za-z0-9][A-Za-z0-9.-]*/g) ?? [];
  const cjkSegments = question.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkTerms = cjkSegments.flatMap(expandCjkTerms);

  return Array.from(new Set([...asciiTerms, ...cjkTerms]))
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !stopTerms.has(term))
    .slice(0, 24);
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.toLowerCase().split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.toLowerCase().split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function selectTopChunksWithReasons(
  scored: ScoredChunk[],
  limit: number,
  lambda: number = RETRIEVAL_CONFIG.mmrLambda,
): { chunks: ScoredChunk[]; reasons: Map<string, string> } {
  const reasons = new Map<string, string>();
  if (scored.length <= limit) {
    for (const candidate of scored) {
      reasons.set(candidate.id, "候选数量未超过最终上限，保留全部候选。");
    }
    return { chunks: scored, reasons };
  }

  const remaining = [...scored];
  const selected: ScoredChunk[] = [];
  const selectedDocuments = new Set<string>();

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const relevance = candidate.score;
      const redundancy =
        selected.length === 0
          ? 0
          : Math.max(
              ...selected.map((item) => {
                const contentOverlap = jaccardSimilarity(item.content, candidate.content);
                const sameDocumentPenalty = item.document.id === candidate.document.id ? 0.35 : 0;
                return Math.max(contentOverlap, sameDocumentPenalty);
              }),
            );
      const mmrScore = lambda * relevance - (1 - lambda) * redundancy * Math.max(relevance, 1);
      const diversityBoost = selectedDocuments.has(candidate.document.id) ? 0 : 0.15 * relevance;
      const total = mmrScore + diversityBoost;
      if (total > bestScore) {
        bestScore = total;
        bestIndex = index;
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    const hadDocument = selectedDocuments.has(chosen.document.id);
    selected.push(chosen);
    selectedDocuments.add(chosen.document.id);
    const channelReason = chosen.lexicalRank !== null && chosen.vectorRank !== null
      ? "同时命中词法与向量召回"
      : chosen.lexicalRank !== null
        ? "命中词法召回"
        : chosen.vectorRank !== null
          ? "命中向量召回"
          : "命中受限关键词回退";
    const diversityReason = selected.length === 1
      ? "首个高相关候选"
      : hadDocument
        ? "相关性优先"
        : "兼顾文档多样性与内容去重";
    reasons.set(chosen.id, `${channelReason}；${diversityReason}`);
  }

  return { chunks: selected, reasons };
}

// 词法命中加分：固定小分且有界（scoreChunk 重构，2026-08-13）。
// 旧公式按 term × 字段无界累加（几十到上百），与 RRF 分数（0.01~0.06）量级失衡，
// 只能靠 rrfScoreWeight 上限 10000 补偿；现改为每切片封顶，两个通道可直接相加。
// 封顶只抑制极端堆叠，普通切片不触顶，保证与旧公式相对排序近似。
const LEXICAL_SCORE_CAP = 6;
const TERM_SCORE_CAP = 4;

function scoreChunk(chunk: SearchChunk, question: string, terms: string[], retrievalBoost = 0): number {
  const fullQuestion = normalizeForCompare(question);
  const title = normalizeForCompare(chunk.document.title);
  const summary = normalizeForCompare(chunk.document.summary);
  const tags = normalizeForCompare(chunk.document.tagsText);
  const heading = normalizeForCompare(chunk.heading);
  const sectionPath = normalizeForCompare(chunk.sectionPath);
  const content = normalizeForCompare(chunk.content);
  let baseScore = 0;

  if (content.includes(fullQuestion)) {
    baseScore += 1.2;
  }

  let termScore = 0;
  for (const term of terms) {
    const normalized = normalizeForCompare(term);
    if (title.includes(normalized)) {
      termScore += 0.8;
    }
    if (tags.includes(normalized)) {
      termScore += 0.6;
    }
    if (heading.includes(normalized)) {
      termScore += 0.5;
    }
    if (sectionPath.includes(normalized)) {
      termScore += 0.4;
    }
    if (summary.includes(normalized)) {
      termScore += 0.3;
    }
    if (content.includes(normalized)) {
      termScore += 0.2;
    }
  }

  return Math.min(baseScore + Math.min(termScore, TERM_SCORE_CAP), LEXICAL_SCORE_CAP) + retrievalBoost;
}

export async function searchRelevantChunksDetailed(
  question: string,
  knowledgeBaseId?: string,
  limit = 5,
  embeddingOverrides: Pick<AnswerQuestionOptions, "embeddingApiKey" | "embeddingBaseURL" | "embeddingModel"> = {},
  configOverrides: RetrievalConfigOverrides = {},
  queryUnderstanding?: import("@/lib/query-understanding").QueryUnderstandingResult,
): Promise<DetailedSearchResult> {
  await initializeKnowledgeBaseState();
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  // 默认基准是当前知识库的生产检索配置，显式覆盖参数只叠加在基准之上（沙盒复跑）。
  const productionConfig = await getProductionRetrievalConfig(knowledgeBase.id);
  const retrievalConfig = resolveRetrievalConfig({ ...productionConfig, ...configOverrides });
  const queryMode = queryUnderstanding?.mode === "llm" ? "llm" : "fallback";
  const llmTerms = queryMode === "llm" && queryUnderstanding && queryUnderstanding.keywords.length > 0
    ? queryUnderstanding.keywords
    : [];
  // 词法通道 = LLM 关键词 ∪ 原问题精确术语（ASCII 词、文件名、引号内容），防止改写遗漏专有名词。
  const originalTerms = extractSearchTerms(question);
  const queryTerms = Array.from(new Set([...llmTerms, ...originalTerms]));
  const effectiveTerms = queryTerms.length > 0 ? queryTerms : [question.trim()];
  const semanticQuery = queryMode === "llm" ? queryUnderstanding?.semanticQuery ?? question.trim() : question.trim();
  // 向量通道 = semanticQuery 向量 ∪ 原问题向量（文档 6.2：原问题向量必须同时参与召回）。
  const [indexedChunkIds, semanticVectorChunkIds, originalVectorChunkIds] = await Promise.all([
    searchFtsChunkIds(knowledgeBase.id, effectiveTerms, retrievalConfig.channelTopK).catch((): string[] => []),
    searchVectorChunkIds(knowledgeBase.id, semanticQuery, retrievalConfig.channelTopK, {
      apiKey: embeddingOverrides.embeddingApiKey,
      baseURL: embeddingOverrides.embeddingBaseURL,
      model: embeddingOverrides.embeddingModel,
    }).catch((): string[] => []),
    queryMode === "llm" && semanticQuery !== question.trim()
      ? searchVectorChunkIds(knowledgeBase.id, question.trim(), retrievalConfig.channelTopK, {
          apiKey: embeddingOverrides.embeddingApiKey,
          baseURL: embeddingOverrides.embeddingBaseURL,
          model: embeddingOverrides.embeddingModel,
        }).catch((): string[] => [])
      : Promise.resolve([]),
  ]);
  const vectorChunkIds = Array.from(new Set([...semanticVectorChunkIds, ...originalVectorChunkIds]));
  const candidateIds = Array.from(new Set([...indexedChunkIds, ...vectorChunkIds]));
  const candidates = await prisma.knowledgeChunk.findMany({
    where: {
      document: {
        knowledgeBaseId: knowledgeBase.id,
        status: DocumentStatus.ACTIVE,
      },
      ...(candidateIds.length > 0
        ? { id: { in: candidateIds } }
        : {
            OR: effectiveTerms.flatMap((term) => [
              { content: { contains: term } },
              { heading: { contains: term } },
              { sectionPath: { contains: term } },
              { document: { title: { contains: term } } },
              { document: { summary: { contains: term } } },
              { document: { tagsText: { contains: term } } },
            ]),
          }),
    },
    include: {
      document: true,
    },
    take: 200,
  });

  const scored: ScoredChunk[] = candidates
    .map((chunk) => {
      const lexicalIndex = indexedChunkIds.indexOf(chunk.id);
      const vectorIndex = vectorChunkIds.indexOf(chunk.id);
      const lexicalRank = lexicalIndex >= 0 ? lexicalIndex + 1 : null;
      const vectorRank = vectorIndex >= 0 ? vectorIndex + 1 : null;
      const rrfScore =
        (lexicalRank !== null ? 1 / (retrievalConfig.rrfK + lexicalRank) : 0) +
        (vectorRank !== null ? 1 / (retrievalConfig.rrfK + vectorRank) : 0);

      return {
        ...chunk,
        score: scoreChunk(chunk, question, effectiveTerms, rrfScore * retrievalConfig.rrfScoreWeight),
        lexicalRank,
        vectorRank,
        rrfScore,
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score || left.tokenEstimate - right.tokenEstimate);

  const selection = selectTopChunksWithReasons(scored, limit, retrievalConfig.mmrLambda);
  const selectedRanks = new Map(selection.chunks.map((chunk, index) => [chunk.id, index + 1]));
  const debug: RetrievalDebugSnapshot = {
    query: question,
    terms: effectiveTerms,
    queryMode,
    llmKeywords: queryMode === "llm" && queryUnderstanding ? queryUnderstanding.keywords : null,
    semanticQuery: queryMode === "llm" && queryUnderstanding ? queryUnderstanding.semanticQuery : null,
    queryUnderstandingWarning: queryMode === "fallback" && queryUnderstanding?.warning ? queryUnderstanding.warning : null,
    lexicalCandidateCount: indexedChunkIds.length,
    vectorCandidateCount: vectorChunkIds.length,
    mergedCandidateCount: scored.length,
    finalLimit: limit,
    candidates: scored.slice(0, 50).map((chunk, index) => ({
      chunkId: chunk.id,
      documentId: chunk.document.id,
      title: chunk.document.title,
      sectionPath: chunk.sectionPath,
      score: chunk.score,
      rrfScore: chunk.rrfScore,
      lexicalRank: chunk.lexicalRank,
      vectorRank: chunk.vectorRank,
      initialRank: index + 1,
      selectedRank: selectedRanks.get(chunk.id) ?? null,
      selectionReason: selection.reasons.get(chunk.id) ?? null,
    })),
  };

  return { chunks: selection.chunks, debug };
}

export async function searchRelevantChunks(
  question: string,
  knowledgeBaseId?: string,
  limit = 5,
  embeddingOverrides: Pick<AnswerQuestionOptions, "embeddingApiKey" | "embeddingBaseURL" | "embeddingModel"> = {},
  queryUnderstanding?: import("@/lib/query-understanding").QueryUnderstandingResult,
): Promise<ScoredChunk[]> {
  const result = await searchRelevantChunksDetailed(question, knowledgeBaseId, limit, embeddingOverrides, {}, queryUnderstanding);
  return result.chunks;
}

function buildFallbackAnswer(question: string, chunks: SearchChunk[]): string {
  const excerpts = chunks.slice(0, 3).map((chunk, index) => {
    const snippet = stripMarkdown(chunk.content).slice(0, 220);
    return `${index + 1}. ${chunk.document.title}：${snippet}`;
  });

  return [
    `当前未配置大模型接口，以下是基于本地检索结果整理的回答草案。`,
    `问题：${question.trim()}`,
    ...excerpts,
    "如需模型生成归纳答案，请先在页面右上角 API 设置中补充 LLM API Key。",
  ].join("\n\n");
}

export async function answerQuestion(question: string, options: AnswerQuestionOptions & { knowledgeBaseId?: string } = {}) {
  const normalizedQuestion = question.trim();
  const llmConfig = getLlmConfig({
    apiKeyOverride: options.llmApiKey,
    baseURLOverride: options.llmBaseURL,
    modelOverride: options.llmModel,
  });

  if (!normalizedQuestion) {
    throw new Error("问题不能为空。");
  }

  const queryUnderstanding = llmConfig.apiKey ? await understandQuery(normalizedQuestion, options) : undefined;
  const chunks = await searchRelevantChunks(normalizedQuestion, options.knowledgeBaseId, 5, options, queryUnderstanding);

  if (chunks.length === 0) {
    return {
      answer: "知识库中没有找到足够相关的内容，请先导入首批 Markdown 或调整提问方式。",
      sources: [] as Array<{ documentId: string; title: string; sourcePath: string }>,
      retrievalMode: "empty" as const,
      toolProposals: [] as ToolProposal[],
    };
  }

  const sources = Array.from(
    new Map(
      chunks.map((chunk) => [
        chunk.document.id,
        {
          documentId: chunk.document.id,
          title: chunk.document.title,
          sourcePath: chunk.document.sourcePath,
        },
      ]),
    ).values(),
  );

  if (!llmConfig.apiKey) {
    return {
      answer: buildFallbackAnswer(normalizedQuestion, chunks),
      sources,
      retrievalMode: "extractive" as const,
      toolProposals: [] as ToolProposal[],
    };
  }

  const promptContext = chunks
    .map(
      (chunk, index) =>
        `来源 ${index + 1}\n标题: ${chunk.document.title}\n路径: ${chunk.document.sourcePath}\n章节: ${chunk.sectionPath}\n片段:\n${chunk.content}`,
    )
    .join("\n\n");

  try {
    const client = new OpenAI({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
    });

    const historyContext = options.history?.length
      ? `\n\n以下是本次会话的近期对话（仅作背景，回答仍以当前问题为准，不要重复已回答过的内容）：\n${options.history
          .map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.content}`)
          .join("\n")}`
      : "";

    const toolProposalInstruction = options.toolProposals
      ? `

你可以在回答末尾附带受控的知识管理提案（可选）。仅当用户明确要求创建知识、修改文档或停用文档时输出，否则不要输出。格式如下：

<proposals>
[{"tool":"create_document_draft","documentTitle":"新文档标题","markdown":"完整Markdown正文","changeReason":"创建理由"}]
</proposals>

可选工具：
- create_document_draft：创建新知识文档，必须提供 documentTitle 与完整 markdown。
- propose_document_patch：修改现有文档，documentId 必须是来源中的真实文档 ID（不是标题），documentTitle 为文档标题，markdown 为修改后的完整正文（未修改部分原样保留）。
- disable_document：停用过时文档，仅需 documentId（真实 ID）与 changeReason。

每个提案都必须包含 documentTitle；提案只是待审核草稿，不会直接修改知识库；回答正文照常给出，正文末尾不要重复提案内容。`
      : "";

    const completion = await client.chat.completions.create({
      model: llmConfig.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `你是本地知识库的问答助手。只能基于给定上下文回答；如果上下文不足，要明确说明，并尽量引用最相关来源。回答使用中文，先给结论，再给依据。${toolProposalInstruction}`,
        },
        {
          role: "user",
          content: `问题：${normalizedQuestion}\n\n请仅基于以下知识片段回答，并在回答末尾补一句“引用来源：标题（路径）”。${historyContext}\n\n${promptContext}`,
        },
      ],
    });

    const answer = completion.choices[0]?.message?.content?.trim();
    const resolvedAnswer = answer || buildFallbackAnswer(normalizedQuestion, chunks);
    const toolProposals = options.toolProposals ? parseToolProposals(resolvedAnswer) : ([] as ToolProposal[]);
    // 提案块是给服务层的受控指令，不应展示在回答正文中；移除后保留正常回答。
    const cleanAnswer =
      toolProposals.length > 0 ? resolvedAnswer.replace(/<proposals>[\s\S]*?<\/proposals>/g, "").trim() : resolvedAnswer;

    return {
      answer: cleanAnswer,
      sources,
      retrievalMode: "llm" as const,
      toolProposals,
    };
  } catch {
    return {
      answer: buildFallbackAnswer(normalizedQuestion, chunks),
      sources,
      retrievalMode: "extractive" as const,
      toolProposals: [] as ToolProposal[],
    };
  }
}

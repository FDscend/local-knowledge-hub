import { EvaluationSetKind } from "@prisma/client";
import OpenAI from "openai";
import { z } from "zod";

import { getLlmConfig } from "@/lib/llm";
import { prisma } from "@/lib/prisma";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

export type LlmEvaluationOptions = {
  llmApiKey?: string | null;
  llmBaseURL?: string | null;
  llmModel?: string | null;
};

export type AnswerScorePayload = {
  answer: string;
  scores: {
    faithfulness: number;
    citationCoverage: number;
    completion: number;
    answerPointCoverage: number;
    total: number;
  };
  notes: string | null;
};

export const ANSWER_SCORE_STATUS = {
  NOT_ATTEMPTED: "NOT_ATTEMPTED",
  SCORED: "SCORED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
} as const;

function createClient(options: LlmEvaluationOptions): OpenAI {
  const config = getLlmConfig({
    apiKeyOverride: options.llmApiKey,
    baseURLOverride: options.llmBaseURL,
    modelOverride: options.llmModel,
  });
  if (!config.apiKey) {
    throw new Error("未配置 LLM API Key，无法进行答案要点评分或候选题生成。请在页面内 API 设置中补齐。");
  }
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
}

function modelName(options: LlmEvaluationOptions): string {
  return getLlmConfig({
    apiKeyOverride: options.llmApiKey,
    baseURLOverride: options.llmBaseURL,
    modelOverride: options.llmModel,
  }).model;
}

const answerScoreSchema = z.object({
  answer: z.string(),
  faithfulness: z.number().min(0).max(5),
  citationCoverage: z.number().min(0).max(5),
  completion: z.number().min(0).max(5),
  answerPointCoverage: z.number().min(0).max(5),
  notes: z.string().nullable(),
});

function buildEvidenceContext(chunks: Array<{ title: string; sectionPath: string; content: string }>): string {
  return chunks
    .map(
      (chunk, index) =>
        `来源 ${index + 1}\n标题: ${chunk.title}\n章节: ${chunk.sectionPath}\n片段:\n${chunk.content}`,
    )
    .join("\n\n");
}

async function requestAnswerScore(
  question: string,
  answerPoints: string[],
  evidence: string,
  options: LlmEvaluationOptions,
): Promise<AnswerScorePayload> {
  const client = createClient(options);
  const completion = await client.chat.completions.create({
    model: modelName(options),
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "你是评测评分助手。基于给定证据片段，回答用户问题，并按固定 rubric 打分。\n" +
          "rubric（每项 0-5 分）：\n" +
          "1. faithfulness 忠实性：答案是否只使用证据中的信息，没有编造。\n" +
          "2. citationCoverage 引用覆盖率：关键结论是否都对应到具体来源片段。\n" +
          "3. completion 问题完成度：是否完整回答问题的所有部分。\n" +
          "4. answerPointCoverage 答案要点覆盖：是否覆盖给定答案要点的内容。\n" +
          "total 为四项平均分。证据不足时必须明确说明，不能编造。只输出 JSON。",
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          answerPoints,
          evidence,
          output: {
            answer: "基于证据的中文回答，结论附引用来源编号",
            faithfulness: 0,
            citationCoverage: 0,
            completion: 0,
            answerPointCoverage: 0,
            notes: "打分说明",
          },
        }),
      },
    ],
    response_format: { type: "json_object" },
  });
  const content = completion.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("评分模型未返回内容。");
  }
  const parsed = answerScoreSchema.parse(JSON.parse(content));
  return {
    answer: parsed.answer,
    scores: {
      faithfulness: parsed.faithfulness,
      citationCoverage: parsed.citationCoverage,
      completion: parsed.completion,
      answerPointCoverage: parsed.answerPointCoverage,
      total: (parsed.faithfulness + parsed.citationCoverage + parsed.completion + parsed.answerPointCoverage) / 4,
    },
    notes: parsed.notes,
  };
}

export type EvaluationScoringSummary = {
  runId: string;
  attempted: number;
  scored: number;
  skipped: number;
  failed: number;
  skippedReason: string | null;
};

export async function scoreEvaluationRunAnswers(
  knowledgeBaseId: string,
  runId: string,
  options: LlmEvaluationOptions = {},
): Promise<EvaluationScoringSummary> {
  await requireKnowledgeBase(knowledgeBaseId);
  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, knowledgeBaseId },
    include: {
      results: {
        where: { status: "SUCCEEDED" },
        include: { evaluationCase: { select: { reviewed: true, answerPoints: true } } },
      },
    },
  });
  if (!run) {
    throw new Error("评测运行记录不存在。");
  }

  const llmConfig = getLlmConfig({
    apiKeyOverride: options.llmApiKey,
    baseURLOverride: options.llmBaseURL,
    modelOverride: options.llmModel,
  });
  const skippedReason = llmConfig.apiKey
    ? null
    : "未配置 LLM API Key，答案要点评分已跳过。请在页面内 API 设置中补齐后重试。";

  let attempted = 0;
  let scored = 0;
  let skipped = 0;
  let failed = 0;

  for (const result of run.results) {
    const answerPoints = parseAnswerPoints(result.evaluationCase.answerPoints);
    const eligible = result.evaluationCase.reviewed && answerPoints.length > 0;

    if (!eligible || skippedReason) {
      if (eligible && skippedReason) {
        skipped += 1;
      }
      await prisma.evaluationResult.update({
        where: { id: result.id },
        data: {
          generatedAnswer: null,
          answerScoreJson: null,
          answerScoreStatus: skippedReason ? ANSWER_SCORE_STATUS.SKIPPED : ANSWER_SCORE_STATUS.NOT_ATTEMPTED,
        },
      });
      continue;
    }

    attempted += 1;
    try {
      const chunkIds = parseStringArray(result.actualChunkIds);
      const chunks = chunkIds.length > 0
        ? await prisma.knowledgeChunk.findMany({
            where: { id: { in: chunkIds.slice(0, 5) } },
            select: { content: true, sectionPath: true, document: { select: { title: true } } },
          })
        : [];
      const evidence = chunks.map((chunk) => ({
        title: chunk.document.title,
        sectionPath: chunk.sectionPath,
        content: chunk.content,
      }));
      const payload = await requestAnswerScore(result.question, answerPoints, buildEvidenceContext(evidence), options);
      await prisma.evaluationResult.update({
        where: { id: result.id },
        data: {
          generatedAnswer: payload.answer,
          answerScoreJson: JSON.stringify(payload.scores),
          answerScoreStatus: ANSWER_SCORE_STATUS.SCORED,
        },
      });
      scored += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[evaluation-llm] 题目 ${result.externalId} 答案要点评分失败：`, error instanceof Error ? error.message : error);
      await prisma.evaluationResult.update({
        where: { id: result.id },
        data: {
          generatedAnswer: null,
          answerScoreJson: null,
          answerScoreStatus: ANSWER_SCORE_STATUS.FAILED,
        },
      });
    }
  }

  return { runId, attempted, scored, skipped, failed, skippedReason };
}

const candidateCaseSchema = z.object({
  cases: z.array(
    z.object({
      question: z.string(),
      answerPoints: z.array(z.string()).min(1),
      evidenceChunkIndexes: z.array(z.number().int().min(1)).min(1),
    }),
  ),
});

export type GeneratedCandidate = {
  question: string;
  answerPoints: string[];
};

export async function generateCandidateCases(
  knowledgeBaseId: string,
  options: LlmEvaluationOptions & { targetSetId?: string; maxCases?: number; maxDocuments?: number; replaceExisting?: boolean } = {},
): Promise<{ evaluationSetId: string; createdCases: number; replacedCases: number }> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const maxCases = options.maxCases ?? 10;
  const maxDocuments = options.maxDocuments ?? 10;
  const replaceExisting = options.replaceExisting ?? true;

  let targetSetId = options.targetSetId;
  if (targetSetId) {
    const targetSet = await prisma.evaluationSet.findFirst({
      where: { id: targetSetId, knowledgeBaseId: knowledgeBase.id },
      select: { id: true, kind: true },
    });
    if (!targetSet) {
      throw new Error("评测集不存在或不属于当前知识库。");
    }
    if (targetSet.kind === EvaluationSetKind.REVIEWED_REGRESSION) {
      throw new Error("人工审核回归集不能追加或替换候选题，请先新建一个自动候选评测集。");
    }
  }

  const documents = await prisma.knowledgeDocument.findMany({
    where: { knowledgeBaseId: knowledgeBase.id, status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
    take: maxDocuments,
    select: {
      id: true,
      title: true,
      chunks: {
        orderBy: { chunkIndex: "asc" },
        take: 20,
        select: { id: true, content: true, sectionPath: true },
      },
    },
  });
  if (documents.length === 0) {
    throw new Error("当前知识库没有可生成候选题的文档。");
  }

  const client = createClient(options);
  const model = modelName(options);
  const generated: Array<GeneratedCandidate & { expectedTitles: string[]; expectedChunkIds: string[] }> = [];

  for (const document of documents) {
    const usableChunks = document.chunks.filter((chunk) => chunk.content.trim().length >= 80).slice(0, 8);
    if (usableChunks.length === 0) {
      continue;
    }
    const remaining = maxCases - generated.length;
    if (remaining <= 0) {
      break;
    }

    const chunkContext = usableChunks
      .map(
        (chunk, index) =>
          `切片 ${index + 1}（章节 ${chunk.sectionPath || "-"}）：\n${chunk.content.slice(0, 900)}`,
      )
      .join("\n\n");

    try {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "你是知识库评测题生成助手。基于给定文档切片，生成可直接用于检索评测的候选问答题。\n" +
              "要求：问题必须能从给定切片内容回答；answerPoints 为 2-4 条可验证的答案要点；evidenceChunkIndexes 必须列出问题答案依据的切片编号（1 到 N，1-3 个），确保答案确实存在于这些切片中；数量最多 2 个。只输出 JSON。",
          },
          {
            role: "user",
            content: JSON.stringify({
              documentTitle: document.title,
              chunks: chunkContext,
              output: { cases: [{ question: "问题文本", answerPoints: ["要点1", "要点2"], evidenceChunkIndexes: [1, 2] }] },
            }),
          },
        ],
        response_format: { type: "json_object" },
      });
      const content = completion.choices[0]?.message?.content?.trim();
      if (!content) {
        continue;
      }
      const parsed = candidateCaseSchema.parse(JSON.parse(content));
      for (const candidate of parsed.cases.slice(0, Math.min(2, remaining))) {
        const evidenceIndexes = candidate.evidenceChunkIndexes
          .filter((index) => index >= 1 && index <= usableChunks.length)
          .slice(0, 3);
        if (evidenceIndexes.length === 0) {
          continue;
        }
        generated.push({
          question: candidate.question,
          answerPoints: candidate.answerPoints,
          expectedTitles: [document.title],
          expectedChunkIds: evidenceIndexes.map((index) => usableChunks[index - 1].id),
        });
      }
    } catch (error) {
      console.warn(`[evaluation-llm] 文档 ${document.title} 候选题生成失败：`, error instanceof Error ? error.message : error);
    }
  }

  if (generated.length === 0) {
    throw new Error("未能生成任何候选题，请检查 LLM 配置后重试。");
  }

  const evaluationSetId = targetSetId ?? (await createCandidateSet(knowledgeBase.id)).id;
  let replacedCases = 0;
  if (replaceExisting) {
    const removed = await prisma.evaluationCase.deleteMany({
      where: { evaluationSetId, reviewed: false },
    });
    replacedCases = removed.count;
  }
  const now = new Date();
  await prisma.$transaction(
    generated.map((candidate, index) =>
      prisma.evaluationCase.create({
        data: {
          evaluationSetId,
          externalId: `auto-${now.getTime()}-${index + 1}`,
          question: candidate.question,
          expectedTitles: JSON.stringify(candidate.expectedTitles),
          expectedDocumentIds: "[]",
          expectedChunkIds: JSON.stringify(candidate.expectedChunkIds),
          answerPoints: JSON.stringify(candidate.answerPoints),
          reviewed: false,
        },
      }),
    ),
  );

  return { evaluationSetId, createdCases: generated.length, replacedCases };
}

async function createCandidateSet(knowledgeBaseId: string): Promise<{ id: string }> {
  const name = `自动生成候选 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  return prisma.evaluationSet.create({
    data: {
      knowledgeBaseId,
      name,
      description: "由 LLM 按文档章节自动生成的候选题，尚未人工审核，仅用于冒烟测试。",
      kind: EvaluationSetKind.AUTO_CANDIDATE,
    },
    select: { id: true },
  });
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseAnswerPoints(value: string | null): string[] {
  return parseStringArray(value);
}

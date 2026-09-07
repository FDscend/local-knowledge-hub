import OpenAI from "openai";
import { z } from "zod";

import { getLlmConfig } from "@/lib/llm";

export type QueryUnderstandingOptions = {
  llmApiKey?: string | null;
  llmBaseURL?: string | null;
  llmModel?: string | null;
};

export type QueryUnderstandingResult = {
  mode: "llm" | "fallback";
  keywords: string[];
  semanticQuery: string;
  subQueries: string[];
  answerIntent: string | null;
  warning: string | null;
};

const queryUnderstandingSchema = z.object({
  keywords: z.array(z.string()).min(1).max(10),
  semanticQuery: z.string().min(1),
  subQueries: z.array(z.string()).max(3).optional(),
  answerIntent: z.enum(["fact", "comparison", "steps", "summary", "decision"]).optional(),
});

const ANSWER_INTENT_LABELS: Record<string, string> = {
  fact: "事实",
  comparison: "比较",
  steps: "步骤",
  summary: "总结",
  decision: "决策建议",
};

function extractFallbackTerms(question: string): string[] {
  const asciiTerms = question.match(/[A-Za-z0-9][A-Za-z0-9.-]*/g) ?? [];
  const cjkSegments = question.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkTerms = cjkSegments.flatMap((segment) => {
    const terms = [segment];
    const maxSize = Math.min(4, segment.length);
    for (let size = 2; size <= maxSize; size += 1) {
      for (let start = 0; start <= segment.length - size; start += 1) {
        terms.push(segment.slice(start, start + size));
      }
    }
    return terms;
  });
  return Array.from(new Set([...asciiTerms, ...cjkTerms]));
}

async function requestQueryUnderstanding(
  client: OpenAI,
  model: string,
  question: string,
): Promise<{ keywords: string[]; semanticQuery: string; subQueries: string[]; answerIntent: string | null }> {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "你是检索查询理解助手。把用户问题改写为用于知识库检索的受约束结构，只输出 JSON。\n" +
          "keywords：3-8 个适合全文检索的精确术语、缩写、实体名和同义词，必须是文档中可能出现的词；" +
          "用户原问题中的专有名词、文件名、代码符号必须原样保留，不能改写或省略；" +
          "答案相关的关键动词和名词（如 建模、分解、区别、原理）也应保留为关键词。\n" +
          "semanticQuery：消除口语、省略和歧义后的完整检索描述，保留用户意图、条件、对象，供语义向量检索使用。\n" +
          "subQueries：最多 3 个可独立检索的子问题；简单事实问题只保留 1 个。\n" +
          "answerIntent：fact（事实）、comparison（比较）、steps（步骤）、summary（总结）、decision（决策建议）之一。\n" +
          "必须完整输出 keywords 和 semanticQuery 两个字段，不能省略。",
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          output: {
            keywords: ["精确术语1", "精确术语2"],
            semanticQuery: "消除口语后的完整检索描述",
            subQueries: ["子问题1"],
            answerIntent: "fact",
          },
        }),
      },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("查询理解模型未返回内容。");
  }
  const parsed = queryUnderstandingSchema.parse(JSON.parse(content));
  return {
    keywords: parsed.keywords,
    semanticQuery: parsed.semanticQuery,
    subQueries: parsed.subQueries ?? [],
    answerIntent: parsed.answerIntent ? ANSWER_INTENT_LABELS[parsed.answerIntent] : null,
  };
}

/**
 * 用 LLM 把用户问题改写为受约束的检索描述（文档 6.1 查询理解）。
 * 未配置 LLM Key、调用失败或输出不合法时回退到确定性术语抽取，
 * 保证检索链路始终可用；LLM 调用失败会重试一次。
 */
export async function understandQuery(
  question: string,
  options: QueryUnderstandingOptions = {},
): Promise<QueryUnderstandingResult> {
  const llmConfig = getLlmConfig({
    apiKeyOverride: options.llmApiKey,
    baseURLOverride: options.llmBaseURL,
    modelOverride: options.llmModel,
  });

  if (!llmConfig.apiKey) {
    return {
      mode: "fallback",
      keywords: extractFallbackTerms(question),
      semanticQuery: question.trim(),
      subQueries: [],
      answerIntent: null,
      warning: "未配置 LLM API Key，查询理解回退为确定性术语抽取。",
    };
  }

  const client = new OpenAI({ apiKey: llmConfig.apiKey, baseURL: llmConfig.baseURL });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const parsed = await requestQueryUnderstanding(client, llmConfig.model, question);
      return {
        mode: "llm",
        keywords: parsed.keywords,
        semanticQuery: parsed.semanticQuery,
        subQueries: parsed.subQueries,
        answerIntent: parsed.answerIntent,
        warning: null,
      };
    } catch (error) {
      if (attempt === 1) {
        continue;
      }
      return {
        mode: "fallback",
        keywords: extractFallbackTerms(question),
        semanticQuery: question.trim(),
        subQueries: [],
        answerIntent: null,
        warning: error instanceof Error ? `查询理解失败（已重试一次），回退为确定性术语抽取：${error.message}` : "查询理解失败（已重试一次），回退为确定性术语抽取。",
      };
    }
  }

  return {
    mode: "fallback",
    keywords: extractFallbackTerms(question),
    semanticQuery: question.trim(),
    subQueries: [],
    answerIntent: null,
    warning: "查询理解失败，回退为确定性术语抽取。",
  };
}

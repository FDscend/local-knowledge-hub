import matter from "gray-matter";
import OpenAI from "openai";
import { z } from "zod";

import { getAvailableTags } from "@/lib/knowledge";
import { getLlmConfig } from "@/lib/llm";

const suggestionSchema = z.object({
  summary: z.string().trim().min(1).max(220),
  candidateTags: z.array(z.string().trim().min(1).max(32)).max(8),
});

type MetadataSuggestionInput = {
  title: string;
  content: string;
  domain?: string;
};

type MetadataSuggestionOptions = {
  llmApiKey?: string | null;
  llmBaseURL?: string | null;
  llmModel?: string | null;
};

export type MetadataSuggestionResult = {
  summary: string;
  frontmatterTags: string[];
  candidateTags: string[];
  existingTags: string[];
  mode: "llm" | "fallback";
};

function normalizeTagList(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function extractJsonObject(input: string): string {
  const fencedMatch = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = input.indexOf("{");
  const lastBrace = input.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return input.slice(firstBrace, lastBrace + 1);
  }

  return input.trim();
}

function extractFrontmatterTags(content: string): string[] {
  const parsed = matter(content);
  const rawTags = parsed.data.tags;

  if (Array.isArray(rawTags)) {
    return normalizeTagList(rawTags.map((tag) => String(tag)));
  }

  if (typeof rawTags === "string") {
    return normalizeTagList(rawTags.split(/[\n,]/));
  }

  return [];
}

function extractBody(content: string): string {
  const parsed = matter(content);
  return parsed.content.trim() || content.trim();
}

function buildFallbackSummary(content: string): string {
  const compact = extractBody(content).replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 160).trim()}...` : compact;
}

function buildFallbackTags(frontmatterTags: string[], existingTags: string[]): string[] {
  const existingSet = new Set(existingTags);
  const existingMatches = frontmatterTags.filter((tag) => existingSet.has(tag));
  const newTags = frontmatterTags.filter((tag) => !existingSet.has(tag));
  return normalizeTagList([...existingMatches, ...newTags]).slice(0, 8);
}

export async function generateMetadataSuggestions(
  input: MetadataSuggestionInput,
  options: MetadataSuggestionOptions = {},
): Promise<MetadataSuggestionResult> {
  const existingTags = await getAvailableTags();
  const frontmatterTags = extractFrontmatterTags(input.content);
  const body = extractBody(input.content);
  const llmConfig = getLlmConfig({
    apiKeyOverride: options.llmApiKey,
    baseURLOverride: options.llmBaseURL,
    modelOverride: options.llmModel,
  });

  if (!llmConfig.apiKey) {
    return {
      summary: buildFallbackSummary(input.content),
      frontmatterTags,
      candidateTags: buildFallbackTags(frontmatterTags, existingTags),
      existingTags,
      mode: "fallback",
    };
  }

  const client = new OpenAI({
    apiKey: llmConfig.apiKey,
    baseURL: llmConfig.baseURL,
  });

  const vocabulary = existingTags.slice(0, 80).join(", ");
  const frontmatterPrompt = frontmatterTags.length > 0 ? frontmatterTags.join(", ") : "无";
  const contentPreview = body.slice(0, 6000);

  const completion = await client.chat.completions.create({
    model: llmConfig.model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "你是知识库录入助手。请输出严格 JSON，字段只能是 summary 和 candidateTags。summary 用中文写 70 到 120 字的摘要，不要包含 YAML、代码块或引号。candidateTags 输出 4 到 8 个标签，优先复用 existingTags 中的标签；只有在现有标签明显不足时，才允许补充最多 2 个新标签。",
      },
      {
        role: "user",
        content: [
          `标题: ${input.title || "未命名文档"}`,
          `主题域: ${input.domain || "未指定"}`,
          `frontmatter tags: ${frontmatterPrompt}`,
          `existingTags: ${vocabulary || "无"}`,
          "请基于正文生成摘要和候选标签。",
          contentPreview,
        ].join("\n\n"),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim();
  if (!raw) {
    return {
      summary: buildFallbackSummary(input.content),
      frontmatterTags,
      candidateTags: buildFallbackTags(frontmatterTags, existingTags),
      existingTags,
      mode: "fallback",
    };
  }

  try {
    const parsed = suggestionSchema.parse(JSON.parse(extractJsonObject(raw)));
    const candidateTags = normalizeTagList([...frontmatterTags, ...parsed.candidateTags]).slice(0, 8);

    return {
      summary: parsed.summary,
      frontmatterTags,
      candidateTags,
      existingTags,
      mode: "llm",
    };
  } catch {
    return {
      summary: buildFallbackSummary(input.content),
      frontmatterTags,
      candidateTags: buildFallbackTags(frontmatterTags, existingTags),
      existingTags,
      mode: "fallback",
    };
  }
}
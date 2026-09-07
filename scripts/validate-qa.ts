import "dotenv/config";

import { defaultEvaluationCases } from "../src/lib/evaluation-cases";
import { answerQuestion } from "../src/lib/rag";

type ValidationCase = (typeof defaultEvaluationCases)[number] & { id: string };

type Verdict = "通过" | "基本通过" | "未通过";

type ValidationResult = ValidationCase & {
  retrievalMode: "llm" | "extractive" | "empty";
  actualTitles: string[];
  matchedExpectedTitles: string[];
  verdict: Verdict;
  note: string;
};

const validationCases: ValidationCase[] = defaultEvaluationCases.map((evaluationCase) => ({
  ...evaluationCase,
  id: evaluationCase.externalId,
}));

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function formatTitles(titles: string[]): string {
  return titles.length > 0 ? titles.join(" / ") : "无";
}

function escapeTableCell(input: string): string {
  return input.replace(/\|/g, "\\|").replace(/\n/g, "<br />");
}

function resolveModelLabel(): string {
  return process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || "gpt-4.1-mini";
}

function evaluateCase(
  validationCase: ValidationCase,
  retrievalMode: ValidationResult["retrievalMode"],
  actualTitles: string[],
): Pick<ValidationResult, "matchedExpectedTitles" | "verdict" | "note"> {
  const matchedExpectedTitles = validationCase.expectedTitles.filter((title) => actualTitles.includes(title));
  const topThreeTitles = actualTitles.slice(0, 3);
  const topThreeMatches = validationCase.expectedTitles.filter((title) => topThreeTitles.includes(title));

  if (retrievalMode !== "llm") {
    return {
      matchedExpectedTitles,
      verdict: "未通过",
      note: "接口未返回 llm 模式。",
    };
  }

  if (topThreeMatches.length > 0) {
    return {
      matchedExpectedTitles,
      verdict: "通过",
      note: topThreeMatches.length === validationCase.expectedTitles.length ? "预期主来源全部进入前 3。" : "至少一个预期主来源进入前 3。",
    };
  }

  if (matchedExpectedTitles.length > 0) {
    return {
      matchedExpectedTitles,
      verdict: "基本通过",
      note: "预期主来源出现在返回来源中，但未进入前 3。",
    };
  }

  return {
    matchedExpectedTitles,
    verdict: "未通过",
    note: "返回来源未命中预期主来源。",
  };
}

const results: ValidationResult[] = [];

for (const validationCase of validationCases) {
  const result = await answerQuestion(validationCase.question);
  const actualTitles = uniqueStrings(result.sources.map((source) => source.title));
  const evaluation = evaluateCase(validationCase, result.retrievalMode, actualTitles);

  results.push({
    ...validationCase,
    retrievalMode: result.retrievalMode,
    actualTitles,
    matchedExpectedTitles: evaluation.matchedExpectedTitles,
    verdict: evaluation.verdict,
    note: evaluation.note,
  });
}

const llmCount = results.filter((result) => result.retrievalMode === "llm").length;
const passedCount = results.filter((result) => result.verdict !== "未通过").length;
const topThreeHitCount = results.filter((result) => result.verdict === "通过").length;
const validationDate = new Date().toISOString().slice(0, 10);
const lines = [
  "# 问答验证报告（自动生成）",
  "",
  `- 验证日期：${validationDate}`,
  `- 模型：${resolveModelLabel()}`,
  `- llm 模式题数：${llmCount}/${results.length}`,
  `- 命中预期主来源前 3 的题数：${topThreeHitCount}/${results.length}`,
  `- 总通过题数：${passedCount}/${results.length}`,
  "",
  "| 问题 ID | 问题 | 预期主来源 | 实际返回来源 | 检索模式 | 结果 | 备注 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...results.map((result) =>
    [
      result.id,
      escapeTableCell(result.question),
      escapeTableCell(formatTitles(result.expectedTitles)),
      escapeTableCell(formatTitles(result.actualTitles.slice(0, 3))),
      result.retrievalMode,
      result.verdict,
      escapeTableCell(result.note),
    ].join(" | "),
  ),
  "",
  "## 说明",
  "",
  "- 本脚本直接调用项目内的问答链路，与 `/api/qa` 使用同一套检索与回答实现。",
  "- 如果任一题未返回 `llm`，或未命中预期主来源，脚本会保留失败结果供人工复核。",
];

console.log(lines.join("\n"));

if (results.some((result) => result.verdict === "未通过")) {
  process.exitCode = 1;
}
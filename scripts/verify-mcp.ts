import "dotenv/config";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

import { prisma } from "@/lib/prisma";

const TSX_CLI = path.resolve("node_modules/tsx/dist/cli.mjs");
const SERVER_ENTRY = path.resolve("src/mcp/server.ts");

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

function isToolError(result: ToolResult): boolean {
  return result.isError === true;
}

function errorText(result: ToolResult): string {
  const item = result.content?.find((entry) => entry.type === "text");
  return item?.text ?? "无文本内容";
}

function parseText(result: ToolResult): unknown {
  return JSON.parse(errorText(result));
}

function fail(message: string): never {
  throw new Error(`MCP 验证失败：${message}`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

async function main(): Promise<void> {
  const startTime = new Date();
  const auditBefore = await prisma.auditLog.count({ where: { actor: "mcp-client" } });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER_ENTRY],
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: "inherit",
  });
  const client = new Client({ name: "mcp-verify", version: "1.0.0" });
  await client.connect(transport);

  try {
    // 1. 只暴露 4 个只读工具，无任何写工具。
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name).sort();
    expect(
      JSON.stringify(toolNames) ===
        JSON.stringify(["ask_knowledge_base", "get_document_excerpt", "list_knowledge_bases", "search_knowledge"].sort()),
      `工具清单不符：${toolNames.join(", ")}`,
    );
    console.log(`[1] 工具清单正确（${toolNames.join(", ")}），无写工具。`);

    // 2. list_knowledge_bases：默认白名单至少包含 default 收件箱。
    const listResult = parseText(await client.callTool({ name: "list_knowledge_bases", arguments: {} })) as Array<{
      id: string;
      name: string;
    }>;
    expect(Array.isArray(listResult) && listResult.length > 0, "list_knowledge_bases 返回空。");
    expect(listResult.some((kb) => kb.id === "default"), "默认白名单应包含 default 收件箱。");
    console.log(`[2] list_knowledge_bases 返回 ${listResult.length} 个知识库：${listResult.map((kb) => kb.id).join(", ")}。`);

    // 3. search_knowledge：返回切片级证据。
    const searchResult = await client.callTool({
      name: "search_knowledge",
      arguments: { knowledgeBaseId: "default", query: "RAG", limit: 3 },
    });
    expect(!isToolError(searchResult), `search_knowledge 调用失败：${errorText(searchResult)}`);
    const search = parseText(searchResult) as {
      knowledgeBaseId: string;
      query: string;
      queryMode: "llm" | "fallback";
      resultCount: number;
      results: Array<{ chunkId: string; documentId: string; title: string; sectionPath: string; content: string }>;
    };
    expect(search.knowledgeBaseId === "default" && search.results.length > 0, "search_knowledge 未返回任何证据片段。");
    const first = search.results[0];
    expect(first.chunkId && first.documentId && first.title && first.content, "证据片段缺少 chunkId/documentId/title/content。");
    console.log(`[3] search_knowledge 返回 ${search.results.length} 条证据（模式 ${search.queryMode}），首条：${first.title}#${first.sectionPath}。`);

    // 4. get_document_excerpt：按 chunkId 与 documentId 均可用。
    const excerptByChunk = await client.callTool({
      name: "get_document_excerpt",
      arguments: { knowledgeBaseId: "default", chunkId: first.chunkId },
    });
    expect(!isToolError(excerptByChunk) && errorText(excerptByChunk).includes(first.documentId), "按 chunkId 获取摘录失败。");
    const excerptByDocument = await client.callTool({
      name: "get_document_excerpt",
      arguments: { knowledgeBaseId: "default", documentId: first.documentId },
    });
    expect(!isToolError(excerptByDocument), "按 documentId 获取摘录失败。");
    console.log(`[4] get_document_excerpt 按 chunkId / documentId 均成功。`);

    // 5. ask_knowledge_base：无状态问答结构完整。
    const askResult = await client.callTool({
      name: "ask_knowledge_base",
      arguments: { knowledgeBaseId: "default", question: "检索增强生成是什么？" },
    });
    expect(!isToolError(askResult), `ask_knowledge_base 调用失败：${errorText(askResult)}`);
    const ask = parseText(askResult) as {
      answer: string;
      answerTruncated: boolean;
      citations: Array<{ chunkId: string; documentId: string; title: string }>;
      insufficientEvidence: boolean;
      retrievalMode: "llm" | "extractive" | "empty";
    };
    expect(typeof ask.answer === "string" && ask.answer.length > 0, "ask_knowledge_base 未返回回答。");
    expect(Array.isArray(ask.citations), "ask_knowledge_base 缺少 citations。");
    expect(typeof ask.insufficientEvidence === "boolean", "ask_knowledge_base 缺少 insufficientEvidence。");
    console.log(
      `[5] ask_knowledge_base 回答 ${ask.answer.length} 字（模式 ${ask.retrievalMode}，${ask.citations.length} 条引用，证据不足=${ask.insufficientEvidence}）。`,
    );

    // 6. 白名单拒绝：名单外的知识库一律拒绝。
    const denied = await client.callTool({
      name: "search_knowledge",
      arguments: { knowledgeBaseId: "not-in-allow-list", query: "x" },
    });
    expect(isToolError(denied), "白名单外知识库未被拒绝。");
    console.log(`[6] 白名单外知识库被拒绝：${errorText(denied)}`);

    // 7. 查询长度与空查询限制。
    const tooLong = await client.callTool({
      name: "search_knowledge",
      arguments: { knowledgeBaseId: "default", query: "x".repeat(2001) },
    });
    expect(isToolError(tooLong), "超长查询未被拒绝。");
    const emptyQuery = await client.callTool({
      name: "search_knowledge",
      arguments: { knowledgeBaseId: "default", query: "   " },
    });
    expect(isToolError(emptyQuery), "空查询未被拒绝。");
    console.log(`[7] 超长查询与空查询均被拒绝。`);

    // 8. 审计日志：5 次成功调用各写一条 mcp-* 记录。
    const auditAfter = await prisma.auditLog.count({ where: { actor: "mcp-client" } });
    expect(auditAfter - auditBefore >= 5, `审计记录不足（新增 ${auditAfter - auditBefore} 条，期望 >= 5）。`);
    const actions = await prisma.auditLog.findMany({
      where: { actor: "mcp-client", createdAt: { gte: startTime } },
      select: { action: true, afterData: true },
      orderBy: { createdAt: "asc" },
    });
    const actionNames = actions.map((entry) => entry.action).sort();
    expect(
      actionNames.includes("mcp-list-knowledge-bases") &&
        actionNames.includes("mcp-search-knowledge") &&
        actionNames.includes("mcp-get-document-excerpt") &&
        actionNames.includes("mcp-ask-knowledge-base"),
      `审计 action 缺失：${actionNames.join(", ")}`,
    );
    expect(actions.every((entry) => !JSON.stringify(entry.afterData).includes("apiKey")), "审计记录泄露密钥字段。");
    console.log(`[8] 审计日志写入 ${actionNames.length} 条：${actionNames.join(", ")}，无密钥字段。`);

    console.log("MCP 只读服务全部验证通过。");
  } finally {
    await client.close();
    // 清理本次验证产生的审计记录，保证脚本可重复执行。
    await prisma.auditLog.deleteMany({ where: { actor: "mcp-client", createdAt: { gte: startTime } } });
  }
}

void main().finally(async () => prisma.$disconnect());

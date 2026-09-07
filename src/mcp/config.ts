import { prisma } from "@/lib/prisma";

/**
 * MCP 只读服务的访问边界与资源限制。
 *
 * 允许访问的知识库必须由本机配置显式列出（MCP_KNOWLEDGE_BASE_IDS，
 * 逗号分隔的知识库 ID 或名称）；未配置时默认只允许内置 default 收件箱。
 * 工具调用始终注入该白名单范围，客户端传入的 knowledgeBaseId 不能超出它。
 */
export const MCP_LIMITS = {
  /** 查询文本最大长度（字符），同时限制请求体实际攻击面。 */
  maxQueryLength: 2000,
  /** search_knowledge 的 limit 上限。 */
  maxSearchLimit: 20,
  /** 单个文档摘录最大字符数。 */
  maxExcerptChars: 8000,
  /** 单次工具返回的正文总字符上限（近似 token 上限）。 */
  maxResultChars: 16000,
  /** 写入审计日志的查询文本截断长度。 */
  maxAuditQueryLength: 200,
  /** 单个切片返回的最大字符数。 */
  maxChunkChars: 2000,
} as const;

export type AllowedKnowledgeBases = {
  /** 白名单解析出的知识库 ID 集合。 */
  ids: Set<string>;
  /** 配置解析时的警告（无效条目、未配置默认等）。 */
  warnings: string[];
};

function normalizeList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 解析 MCP_KNOWLEDGE_BASE_IDS：条目支持知识库 ID 或名称，均解析为 ID。 */
export async function resolveAllowedKnowledgeBaseIds(): Promise<AllowedKnowledgeBases> {
  const entries = normalizeList(process.env.MCP_KNOWLEDGE_BASE_IDS);
  const warnings: string[] = [];

  if (entries.length === 0) {
    warnings.push("未配置 MCP_KNOWLEDGE_BASE_IDS，默认仅允许内置 default 收件箱。");
    return { ids: new Set(["default"]), warnings };
  }

  const ids = new Set<string>();
  for (const entry of entries) {
    const byId = await prisma.knowledgeBase.findUnique({ where: { id: entry }, select: { id: true } });
    if (byId) {
      ids.add(byId.id);
      continue;
    }
    const byName = await prisma.knowledgeBase.findUnique({ where: { name: entry }, select: { id: true } });
    if (byName) {
      ids.add(byName.id);
      continue;
    }
    warnings.push(`MCP_KNOWLEDGE_BASE_IDS 中的 "${entry}" 不是有效的知识库 ID 或名称，已忽略。`);
  }

  if (ids.size === 0) {
    warnings.push("MCP_KNOWLEDGE_BASE_IDS 未解析出任何有效知识库，MCP 工具将全部拒绝调用。");
  }
  return { ids, warnings };
}

/** 校验客户端传入的知识库 ID 是否在白名单内；不在则抛错。 */
export function requireAllowedKnowledgeBase(knowledgeBaseId: string, allowedIds: Set<string>): void {
  if (!allowedIds.has(knowledgeBaseId)) {
    throw new Error(`知识库 "${knowledgeBaseId}" 不在 MCP 允许访问的范围内。`);
  }
}

/** 截断超长查询，超限抛错（而非静默截断）。 */
export function requireQueryWithinLimit(query: string): string {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error("查询文本不能为空。");
  }
  if (normalized.length > MCP_LIMITS.maxQueryLength) {
    throw new Error(`查询文本超过 ${MCP_LIMITS.maxQueryLength} 字符上限。`);
  }
  return normalized;
}

import "dotenv/config";

import { prisma } from "../src/lib/prisma";

async function ensureTable(table: string, definition: string): Promise<"created" | "already-present"> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
  );
  if (rows.length > 0) {
    return "already-present";
  }
  await prisma.$executeRawUnsafe(`CREATE TABLE "${table}" (${definition})`);
  return "created";
}

async function main(): Promise<void> {
  // 阶段 D3：知识图谱 —— 节点（文档 / 标签）与可追溯边（显式链接 / 规则 / 语义建议）。
  const graphNode = await ensureTable(
    "GraphNode",
    `"id" TEXT NOT NULL PRIMARY KEY,
     "knowledgeBaseId" TEXT NOT NULL,
     "nodeType" TEXT NOT NULL,
     "documentId" TEXT,
     "label" TEXT NOT NULL,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL,
     CONSTRAINT "GraphNode_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "GraphNode_knowledgeBaseId_nodeType_label_key" ON "GraphNode" ("knowledgeBaseId", "nodeType", "label")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "GraphNode_knowledgeBaseId_nodeType_idx" ON "GraphNode" ("knowledgeBaseId", "nodeType")',
  );

  const graphEdge = await ensureTable(
    "GraphEdge",
    `"id" TEXT NOT NULL PRIMARY KEY,
     "knowledgeBaseId" TEXT NOT NULL,
     "edgeType" TEXT NOT NULL,
     "sourceNodeId" TEXT NOT NULL,
     "targetNodeId" TEXT NOT NULL,
     "confidence" REAL NOT NULL DEFAULT 1,
     "provenance" TEXT NOT NULL,
     "evidenceJson" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL,
     CONSTRAINT "GraphEdge_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
     CONSTRAINT "GraphEdge_sourceNodeId_fkey" FOREIGN KEY ("sourceNodeId") REFERENCES "GraphNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
     CONSTRAINT "GraphEdge_targetNodeId_fkey" FOREIGN KEY ("targetNodeId") REFERENCES "GraphNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "GraphEdge_sourceNodeId_targetNodeId_edgeType_key" ON "GraphEdge" ("sourceNodeId", "targetNodeId", "edgeType")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "GraphEdge_knowledgeBaseId_edgeType_idx" ON "GraphEdge" ("knowledgeBaseId", "edgeType")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "GraphEdge_knowledgeBaseId_sourceNodeId_idx" ON "GraphEdge" ("knowledgeBaseId", "sourceNodeId")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "GraphEdge_knowledgeBaseId_targetNodeId_idx" ON "GraphEdge" ("knowledgeBaseId", "targetNodeId")',
  );

  console.log(JSON.stringify({ status: "ok", graphNode, graphEdge }));
}

void main().finally(async () => prisma.$disconnect());

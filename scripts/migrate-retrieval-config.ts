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
  // 阶段 C 收尾：生产检索配置表（每个知识库一行）与配置变更历史（回滚点）。
  const config = await ensureTable(
    "RetrievalConfig",
    `"id" TEXT NOT NULL PRIMARY KEY,
     "knowledgeBaseId" TEXT NOT NULL,
     "channelTopK" INTEGER NOT NULL DEFAULT 30,
     "rrfK" INTEGER NOT NULL DEFAULT 60,
     "mmrLambda" REAL NOT NULL DEFAULT 0.7,
     "rrfScoreWeight" REAL NOT NULL DEFAULT 1,
     "appliedFromRunId" TEXT,
     "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL,
     CONSTRAINT "RetrievalConfig_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "RetrievalConfig_knowledgeBaseId_key" ON "RetrievalConfig" ("knowledgeBaseId")',
  );

  const change = await ensureTable(
    "RetrievalConfigChange",
    `"id" TEXT NOT NULL PRIMARY KEY,
     "knowledgeBaseId" TEXT NOT NULL,
     "kind" TEXT NOT NULL,
     "sourceRunId" TEXT,
     "beforeJson" TEXT NOT NULL,
     "afterJson" TEXT NOT NULL,
     "reason" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "RetrievalConfigChange_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "RetrievalConfigChange_knowledgeBaseId_createdAt_idx" ON "RetrievalConfigChange" ("knowledgeBaseId", "createdAt")',
  );

  console.log(JSON.stringify({ status: "ok", retrievalConfig: config, retrievalConfigChange: change }));
}

void main().finally(async () => prisma.$disconnect());

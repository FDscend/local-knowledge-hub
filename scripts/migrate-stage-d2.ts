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
  // 阶段 D2：受控写入 —— 知识草稿表（助手只能创建 PENDING 提案，用户审核后应用）。
  const drafts = await ensureTable(
    "DocumentDraft",
    `"id" TEXT NOT NULL PRIMARY KEY,
     "knowledgeBaseId" TEXT NOT NULL,
     "kind" TEXT NOT NULL,
     "documentId" TEXT,
     "documentTitle" TEXT NOT NULL,
     "contentMarkdown" TEXT NOT NULL,
     "patchJson" TEXT,
     "changeReason" TEXT,
     "status" TEXT NOT NULL DEFAULT 'PENDING',
     "sourceTool" TEXT NOT NULL,
     "sourceConversationId" TEXT,
     "sourceMessageId" TEXT,
     "modelInfo" TEXT,
     "citationsJson" TEXT,
     "appliedDocumentId" TEXT,
     "appliedVersionId" TEXT,
     "appliedAt" DATETIME,
     "rejectedAt" DATETIME,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL,
     CONSTRAINT "DocumentDraft_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "DocumentDraft_knowledgeBaseId_status_createdAt_idx" ON "DocumentDraft" ("knowledgeBaseId", "status", "createdAt")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "DocumentDraft_knowledgeBaseId_documentId_idx" ON "DocumentDraft" ("knowledgeBaseId", "documentId")',
  );

  console.log(JSON.stringify({ status: "ok", documentDraft: drafts }));
}

void main().finally(async () => prisma.$disconnect());

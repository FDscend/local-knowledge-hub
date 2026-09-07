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
  // 阶段 C 收尾：统一后台任务表（评测 / 候选题 / 向量索引 / 自动评测 / 导入记录）。
  const task = await ensureTable(
    "Task",
    `"id" TEXT NOT NULL PRIMARY KEY,
     "knowledgeBaseId" TEXT NOT NULL,
     "kind" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'QUEUED',
     "attempts" INTEGER NOT NULL DEFAULT 0,
     "maxAttempts" INTEGER NOT NULL DEFAULT 2,
     "autoTriggered" BOOLEAN NOT NULL DEFAULT 0,
     "payloadJson" TEXT,
     "resultJson" TEXT,
     "errorText" TEXT,
     "progressCurrent" INTEGER NOT NULL DEFAULT 0,
     "progressTotal" INTEGER NOT NULL DEFAULT 0,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "startedAt" DATETIME,
     "finishedAt" DATETIME,
     CONSTRAINT "Task_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Task_status_createdAt_idx" ON "Task" ("status", "createdAt")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Task_knowledgeBaseId_createdAt_idx" ON "Task" ("knowledgeBaseId", "createdAt")');

  console.log(JSON.stringify({ status: "ok", task }));
}

void main().finally(async () => prisma.$disconnect());

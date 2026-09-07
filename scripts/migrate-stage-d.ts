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
  // 阶段 D：对话式 UI —— 会话与消息表（引用快照按消息保存）。
  const conversation = await ensureTable(
    "Conversation",
    `"id" TEXT NOT NULL PRIMARY KEY,
     "knowledgeBaseId" TEXT NOT NULL,
     "title" TEXT NOT NULL DEFAULT '新会话',
     "archived" INTEGER NOT NULL DEFAULT 0,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL,
     CONSTRAINT "Conversation_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "Conversation_knowledgeBaseId_archived_updatedAt_idx" ON "Conversation" ("knowledgeBaseId", "archived", "updatedAt")',
  );

  const message = await ensureTable(
    "Message",
    `"id" TEXT NOT NULL PRIMARY KEY,
     "conversationId" TEXT NOT NULL,
     "role" TEXT NOT NULL,
     "title" TEXT,
     "content" TEXT NOT NULL,
     "citationsJson" TEXT NOT NULL DEFAULT '[]',
     "retrievalMode" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message" ("conversationId", "createdAt")',
  );
  // 提问要点大纲（阶段 D1 补充）：user 消息自动生成、可手动编辑的短标题。
  const titleColumn = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM pragma_table_info('Message') WHERE name = 'title'",
  );
  const titleAdded = titleColumn.length === 0 ? "added" : "already-present";
  if (titleColumn.length === 0) {
    await prisma.$executeRawUnsafe('ALTER TABLE "Message" ADD COLUMN "title" TEXT');
  }

  console.log(JSON.stringify({ status: "ok", conversation, message, messageTitle: titleAdded }));
}

void main().finally(async () => prisma.$disconnect());

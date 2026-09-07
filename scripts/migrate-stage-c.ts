import "dotenv/config";

import { ensureDefaultEvaluationSet } from "../src/lib/evaluation";
import { prisma } from "../src/lib/prisma";

type SQLiteColumn = {
  name: string;
};

async function ensureColumn(table: string, column: string, definition: string): Promise<"added" | "already-present"> {
  const columns = await prisma.$queryRawUnsafe<SQLiteColumn[]>(`PRAGMA table_info("${table}")`);
  if (columns.some((item) => item.name === column)) {
    return "already-present";
  }
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  return "added";
}

async function ensureEvaluationSchema(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EvaluationSet" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "knowledgeBaseId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "kind" TEXT NOT NULL DEFAULT 'AUTO_CANDIDATE',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "EvaluationSet_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EvaluationCase" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "evaluationSetId" TEXT NOT NULL,
      "externalId" TEXT NOT NULL,
      "question" TEXT NOT NULL,
      "expectedTitles" TEXT NOT NULL DEFAULT '[]',
      "expectedDocumentIds" TEXT NOT NULL DEFAULT '[]',
      "expectedChunkIds" TEXT NOT NULL DEFAULT '[]',
      "referenceAnswer" TEXT,
      "answerPoints" TEXT,
      "reviewed" BOOLEAN NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "EvaluationCase_evaluationSetId_fkey" FOREIGN KEY ("evaluationSetId") REFERENCES "EvaluationSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EvaluationRun" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "knowledgeBaseId" TEXT NOT NULL,
      "evaluationSetId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'RUNNING',
      "retrievalConfigSnapshot" TEXT NOT NULL,
      "indexSnapshot" TEXT,
      "dataSnapshot" TEXT,
      "metricsJson" TEXT,
      "caseCount" INTEGER NOT NULL DEFAULT 0,
      "completedCount" INTEGER NOT NULL DEFAULT 0,
      "hitAt1Count" INTEGER NOT NULL DEFAULT 0,
      "hitAt3Count" INTEGER NOT NULL DEFAULT 0,
      "hitAt5Count" INTEGER NOT NULL DEFAULT 0,
      "meanRecallAt5" REAL NOT NULL DEFAULT 0,
      "meanReciprocalRank" REAL NOT NULL DEFAULT 0,
      "errorText" TEXT,
      "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finishedAt" DATETIME,
      CONSTRAINT "EvaluationRun_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "EvaluationRun_evaluationSetId_fkey" FOREIGN KEY ("evaluationSetId") REFERENCES "EvaluationSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EvaluationResult" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "caseId" TEXT NOT NULL,
      "externalId" TEXT NOT NULL,
      "question" TEXT NOT NULL,
      "expectedTitles" TEXT NOT NULL DEFAULT '[]',
      "expectedDocumentIds" TEXT NOT NULL DEFAULT '[]',
      "expectedChunkIds" TEXT NOT NULL DEFAULT '[]',
      "actualTitles" TEXT NOT NULL DEFAULT '[]',
      "actualDocumentIds" TEXT NOT NULL DEFAULT '[]',
      "actualChunkIds" TEXT NOT NULL DEFAULT '[]',
      "retrievalMode" TEXT,
      "retrievalDebug" TEXT,
      "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
      "firstRelevantRank" INTEGER,
      "hitAt1" BOOLEAN NOT NULL DEFAULT 0,
      "hitAt3" BOOLEAN NOT NULL DEFAULT 0,
      "hitAt5" BOOLEAN NOT NULL DEFAULT 0,
      "recallAt5" REAL NOT NULL DEFAULT 0,
      "reciprocalRank" REAL NOT NULL DEFAULT 0,
      "durationMs" INTEGER,
      "failureReason" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "EvaluationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "EvaluationResult_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "EvaluationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "EvaluationSet_knowledgeBaseId_name_key" ON "EvaluationSet" ("knowledgeBaseId", "name")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "EvaluationSet_knowledgeBaseId_updatedAt_idx" ON "EvaluationSet" ("knowledgeBaseId", "updatedAt")`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "EvaluationCase_evaluationSetId_externalId_key" ON "EvaluationCase" ("evaluationSetId", "externalId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "EvaluationCase_evaluationSetId_updatedAt_idx" ON "EvaluationCase" ("evaluationSetId", "updatedAt")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "EvaluationRun_knowledgeBaseId_startedAt_idx" ON "EvaluationRun" ("knowledgeBaseId", "startedAt")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "EvaluationRun_evaluationSetId_startedAt_idx" ON "EvaluationRun" ("evaluationSetId", "startedAt")`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "EvaluationResult_runId_caseId_key" ON "EvaluationResult" ("runId", "caseId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "EvaluationResult_caseId_createdAt_idx" ON "EvaluationResult" ("caseId", "createdAt")`);
}

async function main(): Promise<void> {
  await ensureEvaluationSchema();
  const columns = {
    runConfigOverrides: await ensureColumn("EvaluationRun", "configOverridesJson", "TEXT"),
    runIsSandbox: await ensureColumn("EvaluationRun", "isSandbox", "BOOLEAN NOT NULL DEFAULT 0"),
    resultGeneratedAnswer: await ensureColumn("EvaluationResult", "generatedAnswer", "TEXT"),
    resultAnswerScoreJson: await ensureColumn("EvaluationResult", "answerScoreJson", "TEXT"),
    resultAnswerScoreStatus: await ensureColumn("EvaluationResult", "answerScoreStatus", "TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED'"),
  };
  const result = await ensureDefaultEvaluationSet();
  console.log(JSON.stringify({ evaluationSetId: result.id, status: result.created ? "created" : "already-present", columns }));
}

void main().finally(async () => prisma.$disconnect());

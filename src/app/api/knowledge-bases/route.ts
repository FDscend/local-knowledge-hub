import { NextResponse } from "next/server";

import { getEmbeddingIndexStatus } from "@/lib/embedding";
import { getKnowledgeStats } from "@/lib/knowledge";
import { DEFAULT_KNOWLEDGE_BASE_ID, DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID, listKnowledgeBases } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";

function getKnowledgeBaseKind(id: string, syncRootPath: string | null): "INBOX" | "DEVELOPMENT" | "SYNC" | "SNAPSHOT" {
  if (id === DEFAULT_KNOWLEDGE_BASE_ID) {
    return "INBOX";
  }
  if (id === DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID) {
    return "DEVELOPMENT";
  }
  return syncRootPath ? "SYNC" : "SNAPSHOT";
}

async function getSyncStatusSummary(knowledgeBaseId: string) {
  const [grouped, latest] = await Promise.all([
    prisma.knowledgeSource.groupBy({
      by: ["syncStatus"],
      where: { knowledgeBaseId, syncStatus: { in: ["SYNCED", "CONFLICT", "MISSING", "SNAPSHOT"] } },
      _count: { _all: true },
    }),
    prisma.knowledgeSource.aggregate({
      where: { knowledgeBaseId, syncStatus: { in: ["SYNCED", "CONFLICT"] } },
      _max: { lastSeenAt: true },
    }),
  ]);

  const counts = Object.fromEntries(grouped.map((item) => [item.syncStatus, item._count._all]));
  return {
    syncedCount: counts.SYNCED ?? 0,
    conflictCount: counts.CONFLICT ?? 0,
    missingCount: counts.MISSING ?? 0,
    snapshotCount: counts.SNAPSHOT ?? 0,
    lastSyncedAt: latest._max.lastSeenAt?.toISOString() ?? null,
  };
}

export async function GET() {
  const knowledgeBases = await listKnowledgeBases();
  const summaries = await Promise.all(
    knowledgeBases.map(async (knowledgeBase) => {
      const [stats, embedding, sync] = await Promise.all([
        getKnowledgeStats(knowledgeBase.id),
        Promise.resolve(getEmbeddingIndexStatus(knowledgeBase.id)),
        knowledgeBase.syncRootPath ? getSyncStatusSummary(knowledgeBase.id) : Promise.resolve(null),
      ]);

      return {
        id: knowledgeBase.id,
        name: knowledgeBase.name,
        description: knowledgeBase.description,
        defaultLanguage: knowledgeBase.defaultLanguage,
        kind: getKnowledgeBaseKind(knowledgeBase.id, knowledgeBase.syncRootPath),
        documentCount: stats.total,
        chunkCount: stats.chunkTotal,
        embedding: {
          configured: embedding.configured,
          status: embedding.status,
          indexedCount: embedding.indexedCount,
          dimensions: embedding.dimensions,
          model: embedding.model,
          indexedAt: embedding.indexedAt,
        },
        sync,
      };
    }),
  );

  return NextResponse.json({ knowledgeBases: summaries });
}

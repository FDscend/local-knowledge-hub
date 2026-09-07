import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

let initialized = false;

function buildMatchQuery(terms: string[]): string {
  return terms
    .map((term) => term.replaceAll('"', '""').trim())
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" OR ");
}

export async function ensureFtsIndex(): Promise<void> {
  if (initialized) {
    return;
  }
  await prisma.$executeRaw`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunk_fts
    USING fts5(chunkId UNINDEXED, knowledgeBaseId UNINDEXED, title, tags, sectionPath, content, tokenize = 'unicode61')
  `;
  initialized = true;
}

export async function rebuildKnowledgeBaseFtsIndex(knowledgeBaseId: string): Promise<void> {
  await ensureFtsIndex();
  await prisma.$executeRaw`DELETE FROM knowledge_chunk_fts WHERE knowledgeBaseId = ${knowledgeBaseId}`;
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { document: { knowledgeBaseId } },
    include: { document: { select: { title: true, tagsText: true } } },
  });

  for (const chunk of chunks) {
    await prisma.$executeRaw`
      INSERT INTO knowledge_chunk_fts (chunkId, knowledgeBaseId, title, tags, sectionPath, content)
      VALUES (${chunk.id}, ${knowledgeBaseId}, ${chunk.document.title}, ${chunk.document.tagsText}, ${chunk.sectionPath}, ${chunk.content})
    `;
  }
}

export async function searchFtsChunkIds(knowledgeBaseId: string, terms: string[], limit = 200): Promise<string[]> {
  await ensureFtsIndex();
  const query = buildMatchQuery(terms);
  if (!query) {
    return [];
  }

  const rows = await prisma.$queryRaw<Array<{ chunkId: string }>>(Prisma.sql`
    SELECT chunkId
    FROM knowledge_chunk_fts
    WHERE knowledge_chunk_fts MATCH ${query} AND knowledgeBaseId = ${knowledgeBaseId}
    ORDER BY bm25(knowledge_chunk_fts)
    LIMIT ${limit}
  `);
  return rows.map((row) => row.chunkId);
}

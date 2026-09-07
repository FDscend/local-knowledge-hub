import { DocumentStatus, type Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { initializeKnowledgeBaseState, requireKnowledgeBase } from "@/lib/knowledge-base";

export type KnowledgeFilters = {
  knowledgeBaseId?: string;
  query?: string;
  tags?: string[];
  status?: "ALL" | DocumentStatus;
  sort?: KnowledgeSort;
};

export type KnowledgeSort = "updated-desc" | "updated-asc" | "created-desc" | "title-asc" | "title-desc";

function resolveOrderBy(sort: KnowledgeSort = "updated-desc"): Prisma.KnowledgeDocumentOrderByWithRelationInput[] {
  switch (sort) {
    case "updated-asc":
      return [{ updatedAt: "asc" }];
    case "created-desc":
      return [{ createdAt: "desc" }];
    case "title-asc":
      return [{ title: "asc" }];
    case "title-desc":
      return [{ title: "desc" }];
    default:
      return [{ updatedAt: "desc" }];
  }
}

export async function listKnowledge(filters: KnowledgeFilters = {}) {
  await initializeKnowledgeBaseState();
  const knowledgeBase = await requireKnowledgeBase(filters.knowledgeBaseId);
  const query = filters.query?.trim();
  const tags = Array.from(
    new Set(
      (filters.tags ?? [])
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
  const status = filters.status && filters.status !== "ALL" ? filters.status : undefined;

  const conditions: Prisma.KnowledgeDocumentWhereInput[] = [];

  if (status) {
    conditions.push({ status });
  }

  if (tags.length > 0) {
    conditions.push(
      ...tags.map((tag) => ({
        tagsText: { contains: tag },
      })),
    );
  }

  if (query) {
    conditions.push({
      OR: [
        { title: { contains: query } },
        { summary: { contains: query } },
        { tagsText: { contains: query } },
        { content: { contains: query } },
        { chunks: { some: { content: { contains: query } } } },
      ],
    });
  }

  const where: Prisma.KnowledgeDocumentWhereInput = {
    knowledgeBaseId: knowledgeBase.id,
    ...(conditions.length > 0 ? { AND: conditions } : {}),
  };

  return prisma.knowledgeDocument.findMany({
    where,
    orderBy: resolveOrderBy(filters.sort),
    include: {
      _count: {
        select: {
          chunks: true,
        },
      },
    },
  });
}

export async function getKnowledgeDocument(id: string, knowledgeBaseId?: string) {
  await initializeKnowledgeBaseState();
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  return prisma.knowledgeDocument.findFirst({
    where: { id, knowledgeBaseId: knowledgeBase.id },
    include: {
      chunks: {
        orderBy: {
          chunkIndex: "asc",
        },
      },
    },
  });
}

export async function getKnowledgeStats(knowledgeBaseId?: string) {
  await initializeKnowledgeBaseState();
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const [total, active, draft, disabled, chunkTotal, latestIngestRun] = await Promise.all([
    prisma.knowledgeDocument.count({ where: { knowledgeBaseId: knowledgeBase.id } }),
    prisma.knowledgeDocument.count({ where: { knowledgeBaseId: knowledgeBase.id, status: DocumentStatus.ACTIVE } }),
    prisma.knowledgeDocument.count({ where: { knowledgeBaseId: knowledgeBase.id, status: DocumentStatus.DRAFT } }),
    prisma.knowledgeDocument.count({ where: { knowledgeBaseId: knowledgeBase.id, status: DocumentStatus.DISABLED } }),
    prisma.knowledgeChunk.count({ where: { document: { knowledgeBaseId: knowledgeBase.id } } }),
    prisma.ingestRun.findFirst({ where: { knowledgeBaseId: knowledgeBase.id }, orderBy: { startedAt: "desc" } }),
  ]);

  return {
    total,
    active,
    draft,
    disabled,
    chunkTotal,
    latestIngestRun,
  };
}

export async function getAvailableTags(knowledgeBaseId?: string) {
  await initializeKnowledgeBaseState();
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const rows = await prisma.knowledgeDocument.findMany({
    where: { knowledgeBaseId: knowledgeBase.id },
    select: {
      tagsText: true,
    },
  });

  return Array.from(
    new Set(
      rows.flatMap((row) =>
        row.tagsText
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ),
  ).sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export async function getKnowledgeListStats(filters: KnowledgeFilters = {}) {
  const [documents, allTags, total, active] = await Promise.all([
    listKnowledge(filters),
    getAvailableTags(filters.knowledgeBaseId),
    prisma.knowledgeDocument.count({ where: { knowledgeBaseId: filters.knowledgeBaseId ?? "default" } }),
    prisma.knowledgeDocument.count({ where: { knowledgeBaseId: filters.knowledgeBaseId ?? "default", status: DocumentStatus.ACTIVE } }),
  ]);

  return {
    filteredTotal: documents.length,
    total,
    active,
    tagCount: allTags.length,
  };
}

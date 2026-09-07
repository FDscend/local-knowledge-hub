import { NextResponse } from "next/server";

import { requireKnowledgeBase } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";

// 二级侧栏文档列表使用的轻量摘要，不返回正文或切片。
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const knowledgeBase = await requireKnowledgeBase(id);
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.round(rawLimit))) : 100;

  const documents = await prisma.knowledgeDocument.findMany({
    where: { knowledgeBaseId: knowledgeBase.id, status: { not: "DISABLED" } },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, title: true, status: true, updatedAt: true },
  });

  return NextResponse.json({
    documents: documents.map((document) => ({ ...document, updatedAt: document.updatedAt.toISOString() })),
  });
}

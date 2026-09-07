import { NextResponse } from "next/server";

import { requireKnowledgeBase } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";

// 辅助面板文档预览用：只返回渲染所需字段，校验文档属于当前知识库。
export async function GET(request: Request, context: { params: Promise<{ id: string; documentId: string }> }) {
  const { id, documentId } = await context.params;
  const knowledgeBase = await requireKnowledgeBase(id);

  const document = await prisma.knowledgeDocument.findFirst({
    where: { id: documentId, knowledgeBaseId: knowledgeBase.id },
    select: { id: true, title: true, content: true, frontmatter: true },
  });

  if (!document) {
    return NextResponse.json({ error: "文档不存在或不属于当前知识库。" }, { status: 404 });
  }

  return NextResponse.json(document);
}

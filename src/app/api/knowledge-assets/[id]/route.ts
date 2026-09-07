import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

const SAFE_ASSET_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!SAFE_ASSET_ID.test(id)) return new NextResponse("Not found", { status: 404 });
  const knowledgeBaseId = new URL(request.url).searchParams.get("knowledgeBaseId")?.trim();
  if (!knowledgeBaseId) return new NextResponse("Not found", { status: 404 });

  const asset = await prisma.managedAsset.findFirst({ where: { id, knowledgeBaseId }, include: { object: true } });
  if (!asset) return new NextResponse("Not found", { status: 404 });

  try {
    const content = await readFile(asset.object.storagePath);
    const mimeType = asset.object.mimeType || "application/octet-stream";
    const canInline = /^image\/(png|jpeg|gif|webp)$/i.test(mimeType);
    return new NextResponse(content, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `${canInline ? "inline" : "attachment"}; filename="${asset.originalName.replace(/["\\\r\n]/g, "-")}"`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
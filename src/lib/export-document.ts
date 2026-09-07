import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { collectKnowledgeAssetIds, rewriteKnowledgeAssetLinks } from "@/lib/knowledge-assets";
import { requireKnowledgeBase } from "@/lib/knowledge-base";
import { getKnowledgeBaseDirectory } from "@/lib/data-directory";
import { prisma } from "@/lib/prisma";

export type DocumentExportResult = {
  exportDirectory: string;
  markdownPath: string;
  assetCount: number;
  title: string;
};

function sanitizeFileName(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned.slice(0, 80) || "document";
}

export async function exportKnowledgeDocument(documentId: string, knowledgeBaseId: string): Promise<DocumentExportResult> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const document = await prisma.knowledgeDocument.findFirst({
    where: { id: documentId, knowledgeBaseId: knowledgeBase.id },
    include: { currentVersion: true },
  });
  if (!document) {
    throw new Error("文档不存在或不属于当前知识库。");
  }

  const markdown = document.currentVersion?.contentMarkdown || document.content;
  const assetIds = collectKnowledgeAssetIds(markdown);
  const assets = assetIds.length
    ? await prisma.managedAsset.findMany({
        where: { knowledgeBaseId: knowledgeBase.id, id: { in: assetIds } },
        include: { object: true },
      })
    : [];

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportDirectory = path.join(getKnowledgeBaseDirectory(knowledgeBase.id), "exports", `${sanitizeFileName(document.title)}-${stamp}`);
  const assetsDirectory = path.join(exportDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });

  const lookup: Record<string, string> = {};
  const usedNames = new Set<string>();
  for (const asset of assets) {
    const extension = path.extname(asset.originalName);
    const baseName = sanitizeFileName(path.basename(asset.originalName, extension) || asset.id);
    let fileName = `${baseName}${extension || ""}`;
    let counter = 1;
    while (usedNames.has(fileName.toLowerCase())) {
      fileName = `${baseName}-${counter}${extension || ""}`;
      counter += 1;
    }
    usedNames.add(fileName.toLowerCase());
    const targetPath = path.join(assetsDirectory, fileName);
    await copyFile(asset.object.storagePath, targetPath);
    lookup[asset.id] = `assets/${fileName}`;
  }

  const exportedMarkdown = rewriteKnowledgeAssetLinks(markdown, lookup);
  const markdownPath = path.join(exportDirectory, `${sanitizeFileName(document.title)}.md`);
  await writeFile(markdownPath, exportedMarkdown, "utf8");

  await prisma.auditLog.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      action: "export-document",
      targetType: "KnowledgeDocument",
      targetId: document.id,
      afterData: JSON.stringify({ exportDirectory, assetCount: assets.length }),
    },
  });

  return {
    exportDirectory,
    markdownPath,
    assetCount: assets.length,
    title: document.title,
  };
}

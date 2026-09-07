import path from "node:path";

import {
  DocumentStatus,
  ImportSourceMode,
  IngestMode,
  KnowledgeSourceKind,
  SourceType,
} from "@prisma/client";
import matter from "gray-matter";

import { chunkMarkdown } from "@/lib/ingest";
import { persistKnowledgeAssets, rewriteMarkdownImageLinks } from "@/lib/knowledge-assets";
import { hashContent } from "@/lib/knowledge-base";
import { persistManagedSource } from "@/lib/managed-objects";
import type { MineruAsset } from "@/lib/mineru";
import { prisma } from "@/lib/prisma";
import { createImportedSlug } from "@/lib/slug";

export type UpsertImportedDocumentInput = {
  knowledgeBaseId: string;
  runId: string;
  canonicalPathOrUrl: string;
  relativeSourcePath: string;
  sourceKind: KnowledgeSourceKind;
  importMode: ImportSourceMode;
  syncStatus: string;
  sourceType: SourceType;
  sourceContent: Buffer;
  sourceFileName: string;
  sourceMimeType?: string | null;
  markdown: string;
  assets?: MineruAsset[];
  createdBy: string;
  changeReasonCreate: string;
  changeReasonUpdate: string;
  slugSeed?: string;
  forceOverwriteConflict?: boolean;
};

export type UpsertImportedDocumentResult = {
  status: "imported" | "unchanged" | "conflict";
  documentId?: string;
  chunkCount: number;
  conflictReason?: string;
};

export function normalizeMarkdownLineEndings(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n");
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const parsed = matter(markdown);
  if (typeof parsed.data.title === "string" && parsed.data.title.trim()) {
    return parsed.data.title.trim();
  }
  const heading = parsed.content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback;
}

function tagsFromMarkdown(markdown: string): string {
  const parsed = matter(markdown);
  const tags = Array.isArray(parsed.data.tags)
    ? parsed.data.tags.map((tag) => String(tag).trim())
    : typeof parsed.data.tags === "string"
      ? parsed.data.tags.split(/[\n,]/).map((tag) => tag.trim())
      : [];
  return Array.from(new Set(tags.filter(Boolean))).join(", ");
}

function summarize(markdown: string): string {
  const content = matter(markdown).content.replace(/\s+/g, " ").trim();
  return content.length > 180 ? `${content.slice(0, 180).trim()}...` : content;
}

export async function upsertImportedDocument(input: UpsertImportedDocumentInput): Promise<UpsertImportedDocumentResult> {
  const rawMarkdown = normalizeMarkdownLineEndings(input.markdown);
  const parsedRaw = matter(rawMarkdown);
  let content = parsedRaw.content.trim();
  if (!content) {
    throw new Error("解析后的 Markdown 正文为空。");
  }

  let assetIds: string[] = [];
  if (input.assets && input.assets.length > 0) {
    const persistedAssets = await persistKnowledgeAssets({
      knowledgeBaseId: input.knowledgeBaseId,
      assets: input.assets,
    });
    assetIds = persistedAssets.assetIds;
    content = rewriteMarkdownImageLinks(content, persistedAssets.lookup);
  }

  const contentHash = hashContent(content);
  const sourceFileHash = hashContent(input.sourceContent);
  const existingSource = await prisma.knowledgeSource.findFirst({
    where: { knowledgeBaseId: input.knowledgeBaseId, canonicalPathOrUrl: input.canonicalPathOrUrl, importMode: input.importMode },
    include: { documents: { take: 1, select: { id: true, content: true, updatedAt: true } } },
  });
  const existingDocument = existingSource?.documents[0];

  if (
    !input.forceOverwriteConflict &&
    input.importMode === ImportSourceMode.SYNC &&
    existingSource?.sourceFileHash === sourceFileHash &&
    existingDocument
  ) {
    await prisma.knowledgeSource.update({
      where: { id: existingSource.id },
      data: { lastSeenAt: new Date(), syncStatus: input.syncStatus, importMode: input.importMode },
    });
    return { status: "unchanged", documentId: existingDocument.id, chunkCount: 0 };
  }

  if (existingSource?.contentHash === contentHash && existingDocument) {
    await prisma.knowledgeSource.update({
      where: { id: existingSource.id },
      data: { lastSeenAt: new Date(), syncStatus: input.syncStatus, importMode: input.importMode, sourceFileHash },
    });
    return { status: "unchanged", documentId: existingDocument.id, chunkCount: 0 };
  }

  if (
    !input.forceOverwriteConflict &&
    input.importMode === ImportSourceMode.SYNC &&
    existingDocument &&
    existingSource?.contentHash &&
    existingSource.contentHash !== contentHash
  ) {
    const knowledgeHash = hashContent(existingDocument.content);
    if (knowledgeHash !== existingSource.contentHash) {
      await prisma.knowledgeSource.update({
        where: { id: existingSource.id },
        data: {
          lastSeenAt: new Date(),
          syncStatus: "CONFLICT",
        },
      });
      await prisma.auditLog.create({
        data: {
          knowledgeBaseId: input.knowledgeBaseId,
          action: "sync-conflict",
          targetType: "KnowledgeDocument",
          targetId: existingDocument.id,
          afterData: JSON.stringify({
            relativePath: input.relativeSourcePath,
            sourceHash: contentHash,
            knowledgeHash,
            trackedHash: existingSource.contentHash,
          }),
        },
      });
      return {
        status: "conflict",
        documentId: existingDocument.id,
        chunkCount: 0,
        conflictReason: "源文件与知识库正文均已变更，需人工选择保留源 / 保留知识库 / 新建文档。",
      };
    }
  }

  const fallbackTitle = path.basename(input.relativeSourcePath, path.extname(input.relativeSourcePath));
  const title = titleFromMarkdown(rawMarkdown, fallbackTitle);
  const chunks = chunkMarkdown(content, IngestMode.HEADING_CHUNKS, title);
  const managedSource = await persistManagedSource({
    knowledgeBaseId: input.knowledgeBaseId,
    content: input.sourceContent,
    originalName: input.sourceFileName,
    mimeType: input.sourceMimeType,
  });
  const frontmatterData = parsedRaw.data;
  const frontmatter = Object.keys(frontmatterData).length > 0 ? JSON.stringify(frontmatterData) : null;

  const documentId = await prisma.$transaction(async (transaction) => {
    const source = existingSource
      ? await transaction.knowledgeSource.update({
          where: { id: existingSource.id },
          data: {
            contentHash,
            sourceFileHash,
            lastSeenAt: new Date(),
            syncStatus: input.syncStatus,
            importMode: input.importMode,
            kind: input.sourceKind,
          },
        })
      : await transaction.knowledgeSource.create({
          data: {
            knowledgeBaseId: input.knowledgeBaseId,
            kind: input.sourceKind,
            importMode: input.importMode,
            canonicalPathOrUrl: input.canonicalPathOrUrl,
            contentHash,
            sourceFileHash,
            lastSeenAt: new Date(),
            syncStatus: input.syncStatus,
          },
        });

    const documentData = {
      knowledgeBaseId: input.knowledgeBaseId,
      sourceId: source.id,
      slug: createImportedSlug(input.slugSeed ?? `${input.importMode.toLowerCase()}-${hashContent(input.relativeSourcePath).slice(0, 12)}`, title),
      title,
      summary: summarize(content),
      tagsText: tagsFromMarkdown(rawMarkdown),
      domain: "",
      sourceType: input.sourceType,
      sourcePath: input.relativeSourcePath,
      sourceUrl: typeof frontmatterData.source === "string" ? String(frontmatterData.source) : null,
      status: DocumentStatus.ACTIVE,
      ingestMode: IngestMode.HEADING_CHUNKS,
      content,
      frontmatter,
      lastIngestRunId: input.runId,
    };

    const document = existingDocument
      ? await transaction.knowledgeDocument.update({ where: { id: existingDocument.id }, data: documentData })
      : await transaction.knowledgeDocument.create({ data: documentData });

    const version = await transaction.documentVersion.create({
      data: {
        documentId: document.id,
        contentMarkdown: content,
        contentHash,
        managedObjectHash: managedSource.sha256,
        createdBy: input.createdBy,
        changeReason: existingDocument ? input.changeReasonUpdate : input.changeReasonCreate,
      },
    });
    await transaction.knowledgeDocument.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
    if (assetIds.length > 0) {
      await transaction.managedAsset.updateMany({
        where: { id: { in: assetIds }, knowledgeBaseId: input.knowledgeBaseId },
        data: { documentVersionId: version.id },
      });
    }
    await transaction.knowledgeChunk.deleteMany({ where: { documentId: document.id } });
    if (chunks.length > 0) {
      await transaction.knowledgeChunk.createMany({
        data: chunks.map((chunk, index) => ({
          documentId: document.id,
          chunkIndex: index,
          heading: chunk.heading,
          sectionPath: chunk.sectionPath,
          content: chunk.content,
          tokenEstimate: chunk.tokenEstimate,
        })),
      });
    }
    await transaction.auditLog.create({
      data: {
        knowledgeBaseId: input.knowledgeBaseId,
        action: existingDocument ? input.changeReasonUpdate : input.changeReasonCreate,
        targetType: "KnowledgeDocument",
        targetId: document.id,
        afterData: JSON.stringify({ relativePath: input.relativeSourcePath, versionId: version.id }),
      },
    });
    return document.id;
  });

  return { status: "imported", documentId, chunkCount: chunks.length };
}

import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { ManagedObjectKind } from "@prisma/client";

import { getKnowledgeBaseDataDir, getManagedObjectPath } from "@/lib/data-directory";
import { type MineruAsset } from "@/lib/mineru";
import { persistKnowledgeAssets, rewriteMarkdownImageLinks } from "@/lib/knowledge-assets";
import { hashContent, initializeKnowledgeBaseState } from "@/lib/knowledge-base";
import { persistManagedSource } from "@/lib/managed-objects";
import { prisma } from "@/lib/prisma";

function getLegacyAssetPaths(content: string): string[] {
  const matches = content.matchAll(/\/uploads\/knowledge-assets\/[^\s)"']+/g);
  return Array.from(new Set(Array.from(matches, (match) => match[0])));
}

async function loadLegacyAssets(content: string): Promise<MineruAsset[]> {
  const assets: MineruAsset[] = [];
  for (const publicUrl of getLegacyAssetPaths(content)) {
    const relativePath = publicUrl.slice(1);
    if (!relativePath.startsWith("uploads/knowledge-assets/")) continue;
    const absolutePath = path.resolve(process.cwd(), "public", relativePath);
    const publicRoot = `${path.resolve(process.cwd(), "public")}${path.sep}`;
    if (!absolutePath.startsWith(publicRoot)) continue;
    try {
      const data = await readFile(absolutePath);
      assets.push({ sourcePath: relativePath, fileName: path.basename(relativePath), mimeType: "application/octet-stream", data });
    } catch {
      console.warn(`跳过无法读取的历史附件：${publicUrl}`);
    }
  }
  return assets;
}

function isLegacyObjectPath(storagePath: string): boolean {
  const legacyRoot = path.resolve(getKnowledgeBaseDataDir(), "objects");
  const normalizedPath = path.resolve(storagePath);
  return normalizedPath === legacyRoot || normalizedPath.startsWith(`${legacyRoot}${path.sep}`);
}

async function copyObjectToKnowledgeBase(args: {
  knowledgeBaseId: string;
  sha256: string;
  kind: ManagedObjectKind;
  sourcePath: string;
  originalName: string;
}): Promise<string | null> {
  const category = args.kind === ManagedObjectKind.SOURCE ? "source" : "assets";
  const storagePath = getManagedObjectPath(args.knowledgeBaseId, args.sha256, category, args.originalName);
  try {
    await access(args.sourcePath);
    await mkdir(path.dirname(storagePath), { recursive: true });
    if (path.resolve(args.sourcePath) !== path.resolve(storagePath)) {
      await copyFile(args.sourcePath, storagePath);
    }
    await access(storagePath);
    return storagePath;
  } catch {
    console.warn(`无法复制旧受管对象：${args.sourcePath}`);
    return null;
  }
}

async function migrateLegacyManagedObjects(): Promise<{ copiedObjects: number; unavailableObjects: number; remappedAssets: number }> {
  const legacyObjects = await prisma.managedObject.findMany({
    where: { storagePath: { contains: `${path.sep}objects${path.sep}` } },
    include: { assets: true },
  });
  const versionReferences = await prisma.documentVersion.findMany({
    where: { managedObjectHash: { not: null } },
    select: { managedObjectHash: true, document: { select: { knowledgeBaseId: true } } },
  });
  const versionKnowledgeBasesByHash = new Map<string, Set<string>>();
  for (const version of versionReferences) {
    if (!version.managedObjectHash) continue;
    const knowledgeBaseIds = versionKnowledgeBasesByHash.get(version.managedObjectHash) ?? new Set<string>();
    knowledgeBaseIds.add(version.document.knowledgeBaseId);
    versionKnowledgeBasesByHash.set(version.managedObjectHash, knowledgeBaseIds);
  }

  let copiedObjects = 0;
  let unavailableObjects = 0;
  let remappedAssets = 0;

  for (const object of legacyObjects) {
    if (!isLegacyObjectPath(object.storagePath)) continue;
    const knowledgeBaseIds = new Set<string>([
      ...object.assets.map((asset) => asset.knowledgeBaseId),
      ...(versionKnowledgeBasesByHash.get(object.sha256) ?? []),
    ]);
    if (knowledgeBaseIds.size === 0) knowledgeBaseIds.add("default");
    const primaryKnowledgeBaseId = Array.from(knowledgeBaseIds)[0];

    const originalName = path.basename(object.storagePath) || "object";
    const objectIdsByKnowledgeBase = new Map<string, string>();
    for (const knowledgeBaseId of knowledgeBaseIds) {
      const storagePath = await copyObjectToKnowledgeBase({
        knowledgeBaseId,
        sha256: object.sha256,
        kind: object.kind,
        sourcePath: object.storagePath,
        originalName,
      });
      if (!storagePath) {
        unavailableObjects += 1;
        continue;
      }

      const migrated = knowledgeBaseId === primaryKnowledgeBaseId
        ? await prisma.managedObject.update({ where: { id: object.id }, data: { knowledgeBaseId, storagePath } })
        : await prisma.managedObject.upsert({
            where: { knowledgeBaseId_sha256: { knowledgeBaseId, sha256: object.sha256 } },
            update: { storagePath, mimeType: object.mimeType, size: object.size },
            create: {
              knowledgeBaseId,
              sha256: object.sha256,
              kind: object.kind,
              storagePath,
              mimeType: object.mimeType,
              size: object.size,
              referenceCount: object.referenceCount,
              retentionUntil: object.retentionUntil,
            },
          });
      objectIdsByKnowledgeBase.set(knowledgeBaseId, migrated.id);
      copiedObjects += 1;
    }

    for (const asset of object.assets) {
      const targetObjectId = objectIdsByKnowledgeBase.get(asset.knowledgeBaseId);
      if (!targetObjectId || targetObjectId === asset.objectId) continue;
      await prisma.managedAsset.update({ where: { id: asset.id }, data: { objectId: targetObjectId } });
      remappedAssets += 1;
    }
  }

  return { copiedObjects, unavailableObjects, remappedAssets };
}

async function migrateLegacyDocumentContent(): Promise<{ sourceCopies: number; assetCopies: number; rewrittenDocuments: number }> {
  const documents = await prisma.knowledgeDocument.findMany({ include: { currentVersion: true } });
  let sourceCopies = 0;
  let assetCopies = 0;
  let rewrittenDocuments = 0;

  for (const document of documents) {
    const sourceCandidate = path.resolve(process.cwd(), document.sourcePath);
    const workspaceRoot = path.resolve(process.cwd()) + path.sep;
    if (sourceCandidate.startsWith(workspaceRoot)) {
      try {
        const sourceData = await readFile(sourceCandidate);
        const persisted = await persistManagedSource({
          knowledgeBaseId: document.knowledgeBaseId,
          content: sourceData,
          originalName: path.basename(sourceCandidate),
        });
        if (document.currentVersion) {
          await prisma.documentVersion.update({ where: { id: document.currentVersion.id }, data: { managedObjectHash: persisted.sha256 } });
        }
        sourceCopies += 1;
      } catch {
        console.warn(`来源文件不可读，保留原有快照：${document.sourcePath}`);
      }
    }

    const assets = await loadLegacyAssets(document.content);
    if (assets.length === 0) continue;
    const persistedAssets = await persistKnowledgeAssets({ knowledgeBaseId: document.knowledgeBaseId, assets });
    const nextContent = rewriteMarkdownImageLinks(document.content, persistedAssets.lookup);
    assetCopies += persistedAssets.assetIds.length;
    if (nextContent === document.content) continue;

    const version = await prisma.documentVersion.create({
      data: {
        documentId: document.id,
        contentMarkdown: nextContent,
        contentHash: hashContent(nextContent),
        managedObjectHash: document.currentVersion?.managedObjectHash || null,
        createdBy: "migration",
        changeReason: "stage-a-asset-migration",
      },
    });
    await prisma.$transaction([
      prisma.knowledgeDocument.update({ where: { id: document.id }, data: { content: nextContent, currentVersionId: version.id } }),
      prisma.managedAsset.updateMany({ where: { id: { in: persistedAssets.assetIds }, knowledgeBaseId: document.knowledgeBaseId }, data: { documentVersionId: version.id } }),
    ]);
    rewrittenDocuments += 1;
  }

  return { sourceCopies, assetCopies, rewrittenDocuments };
}

async function main(): Promise<void> {
  await initializeKnowledgeBaseState();
  const objectMigration = await migrateLegacyManagedObjects();
  const contentMigration = await migrateLegacyDocumentContent();
  const allManagedObjects = await prisma.managedObject.findMany({ select: { storagePath: true } });
  const remainingLegacyObjects = allManagedObjects.filter((object) => isLegacyObjectPath(object.storagePath)).length;
  if (remainingLegacyObjects > 0) {
    throw new Error(`仍有 ${remainingLegacyObjects} 个旧对象路径未迁移；旧全局对象池未被删除。`);
  }

  console.log(JSON.stringify({ ...objectMigration, ...contentMigration, legacyObjectsReclaimed: true }));
}

void main().finally(async () => prisma.$disconnect());
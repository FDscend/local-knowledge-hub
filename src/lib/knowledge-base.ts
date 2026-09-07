import { createHash } from "node:crypto";
import { realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { KnowledgeSourceKind, type KnowledgeBase } from "@prisma/client";

import { rebuildKnowledgeBaseFtsIndex } from "@/lib/fts";
import { prisma } from "@/lib/prisma";
import { ensureKnowledgeBaseDataDirectories, getKnowledgeBaseDataDir, getKnowledgeBaseDirectory } from "@/lib/data-directory";

export const DEFAULT_KNOWLEDGE_BASE_ID = "default";
export const DEFAULT_KNOWLEDGE_BASE_NAME = "默认收件箱";
export const DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID = "__dev_demo__";
export const DEVELOPMENT_DEMO_KNOWLEDGE_BASE_NAME = "开发测试仓库";

export type KnowledgeBaseInput = {
  name: string;
  description?: string | null;
  defaultLanguage?: string | null;
};

export type SyncKnowledgeBaseInput = KnowledgeBaseInput & {
  rootPath: string;
};

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function ensureDefaultKnowledgeBase(): Promise<KnowledgeBase> {
  const knowledgeBase = await prisma.knowledgeBase.upsert({
    where: { id: DEFAULT_KNOWLEDGE_BASE_ID },
    update: {
      name: DEFAULT_KNOWLEDGE_BASE_NAME,
      description: "浏览器单文件上传固定写入的本地收件箱；不参与目录同步。",
      syncRootPath: null,
    },
    create: {
      id: DEFAULT_KNOWLEDGE_BASE_ID,
      name: DEFAULT_KNOWLEDGE_BASE_NAME,
      description: "浏览器单文件上传固定写入的本地收件箱；不参与目录同步。",
      defaultLanguage: "zh-CN",
    },
  });
  await ensureKnowledgeBaseDataDirectories(knowledgeBase.id);
  return knowledgeBase;
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  await ensureDefaultKnowledgeBase();
  return prisma.knowledgeBase.findMany({ orderBy: [{ createdAt: "asc" }, { name: "asc" }] });
}

export async function getKnowledgeBase(knowledgeBaseId: string): Promise<KnowledgeBase | null> {
  await ensureDefaultKnowledgeBase();
  return prisma.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
}

export async function requireKnowledgeBase(knowledgeBaseId: string | null | undefined): Promise<KnowledgeBase> {
  const normalizedId = knowledgeBaseId?.trim() || DEFAULT_KNOWLEDGE_BASE_ID;
  const knowledgeBase = await getKnowledgeBase(normalizedId);
  if (!knowledgeBase) {
    throw new Error("指定的知识库不存在。");
  }
  return knowledgeBase;
}

export async function createKnowledgeBase(input: KnowledgeBaseInput): Promise<KnowledgeBase> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("知识库名称不能为空。");
  }
  if (name === DEFAULT_KNOWLEDGE_BASE_NAME || name === DEVELOPMENT_DEMO_KNOWLEDGE_BASE_NAME) {
    throw new Error("该名称为系统保留名称。");
  }

  const knowledgeBase = await prisma.knowledgeBase.create({
    data: {
      name,
      description: input.description?.trim() || null,
      defaultLanguage: input.defaultLanguage?.trim() || "zh-CN",
    },
  });
  await ensureKnowledgeBaseDataDirectories(knowledgeBase.id);
  return knowledgeBase;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!path.isAbsolute(relativePath) && !relativePath.startsWith(`..${path.sep}`) && relativePath !== "..");
}

async function resolveSyncRoot(rootPath: string): Promise<string> {
  const requestedPath = rootPath.trim();
  if (!requestedPath) {
    throw new Error("同步目录不能为空。");
  }

  const canonicalPath = await realpath(path.resolve(requestedPath));
  const details = await stat(canonicalPath);
  if (!details.isDirectory()) {
    throw new Error("同步根目录必须是本机目录。");
  }

  const dataDirectory = await realpath(getKnowledgeBaseDataDir()).catch(() => path.resolve(getKnowledgeBaseDataDir()));
  if (isPathWithinRoot(canonicalPath, dataDirectory) || isPathWithinRoot(dataDirectory, canonicalPath)) {
    throw new Error("同步根目录不能包含应用受管数据目录。");
  }
  return canonicalPath;
}

export async function createSyncKnowledgeBase(input: SyncKnowledgeBaseInput): Promise<KnowledgeBase> {
  if (process.env.KNOWLEDGE_BASE_PACKAGED === "true") {
    throw new Error("安装版尚未提供同步目录配置入口。");
  }

  const name = input.name.trim();
  if (!name || name === DEFAULT_KNOWLEDGE_BASE_NAME || name === DEVELOPMENT_DEMO_KNOWLEDGE_BASE_NAME) {
    throw new Error("知识库名称不可用于目录同步。");
  }

  const syncRootPath = await resolveSyncRoot(input.rootPath);
  const knowledgeBase = await prisma.knowledgeBase.create({
    data: {
      name,
      description: input.description?.trim() || null,
      defaultLanguage: input.defaultLanguage?.trim() || "zh-CN",
      syncRootPath,
    },
  });
  await ensureKnowledgeBaseDataDirectories(knowledgeBase.id);
  return knowledgeBase;
}

async function requireConfirmedKnowledgeBase(knowledgeBaseId: string, confirmationName: string): Promise<KnowledgeBase> {
  const knowledgeBase = await prisma.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
  if (!knowledgeBase) {
    throw new Error("指定的知识库不存在。");
  }
  if (confirmationName.trim() !== knowledgeBase.name) {
    throw new Error("输入的知识库名称不匹配。");
  }
  return knowledgeBase;
}

export async function clearKnowledgeBase(knowledgeBaseId: string, confirmationName: string): Promise<void> {
  const knowledgeBase = await requireConfirmedKnowledgeBase(knowledgeBaseId, confirmationName);
  if (knowledgeBase.id === DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID) {
    throw new Error("开发测试仓库只能通过显式开发 seed 脚本重置。");
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.knowledgeDocument.deleteMany({ where: { knowledgeBaseId: knowledgeBase.id } });
    await transaction.ingestRun.deleteMany({ where: { knowledgeBaseId: knowledgeBase.id } });
    await transaction.knowledgeSource.deleteMany({ where: { knowledgeBaseId: knowledgeBase.id } });
    await transaction.managedAsset.deleteMany({ where: { knowledgeBaseId: knowledgeBase.id } });
    await transaction.managedObject.deleteMany({ where: { knowledgeBaseId: knowledgeBase.id } });
    await transaction.auditLog.deleteMany({ where: { knowledgeBaseId: knowledgeBase.id } });
    await transaction.auditLog.create({
      data: {
        knowledgeBaseId: knowledgeBase.id,
        action: "clear-knowledge-base",
        targetType: "KnowledgeBase",
        targetId: knowledgeBase.id,
      },
    });
  });
  await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
  await rm(getKnowledgeBaseDirectory(knowledgeBase.id), { recursive: true, force: true });
  await ensureKnowledgeBaseDataDirectories(knowledgeBase.id);
}

export async function deleteKnowledgeBase(knowledgeBaseId: string, confirmationName: string): Promise<void> {
  const knowledgeBase = await requireConfirmedKnowledgeBase(knowledgeBaseId, confirmationName);
  if (knowledgeBase.id === DEFAULT_KNOWLEDGE_BASE_ID || knowledgeBase.id === DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID) {
    throw new Error("内置知识库不能删除。");
  }

  await prisma.knowledgeBase.delete({ where: { id: knowledgeBase.id } });
  await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
  await rm(getKnowledgeBaseDirectory(knowledgeBase.id), { recursive: true, force: true });
}

export async function backfillKnowledgeBaseRecords(): Promise<void> {
  await ensureDefaultKnowledgeBase();

  const documents = await prisma.knowledgeDocument.findMany({
    where: { sourceId: null },
    select: { id: true, knowledgeBaseId: true, sourcePath: true, sourceUrl: true, content: true, createdAt: true },
  });

  for (const document of documents) {
    const source = await prisma.knowledgeSource.create({
      data: {
        knowledgeBaseId: document.knowledgeBaseId,
        kind: KnowledgeSourceKind.MANIFEST,
        canonicalPathOrUrl: document.sourceUrl || document.sourcePath,
        contentHash: hashContent(document.content),
        lastSeenAt: document.createdAt,
        syncStatus: "SNAPSHOT",
      },
    });

    await prisma.knowledgeDocument.update({ where: { id: document.id }, data: { sourceId: source.id } });
  }

  const versions = await prisma.knowledgeDocument.findMany({
    where: { currentVersionId: null },
    select: { id: true, content: true, createdAt: true },
  });

  for (const document of versions) {
    const version = await prisma.documentVersion.create({
      data: {
        documentId: document.id,
        contentMarkdown: document.content,
        contentHash: hashContent(document.content),
        createdBy: "migration",
        changeReason: "stage-a-backfill",
        createdAt: document.createdAt,
      },
    });
    await prisma.knowledgeDocument.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
  }
}

let initializationPromise: Promise<void> | undefined;

export async function initializeKnowledgeBaseState(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await ensureDefaultKnowledgeBase();
      await backfillKnowledgeBaseRecords();
    })();
  }

  return initializationPromise;
}
import path from "node:path";
import { rm } from "node:fs/promises";

import { ImportSourceMode } from "@prisma/client";

import { DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID, DEVELOPMENT_DEMO_KNOWLEDGE_BASE_NAME } from "@/lib/knowledge-base";
import { getKnowledgeBaseDirectory } from "@/lib/data-directory";
import { syncDirectoryKnowledgeBase } from "@/lib/directory-sync";
import { prisma } from "@/lib/prisma";

async function main(): Promise<void> {
  if (process.env.KNOWLEDGE_BASE_SEED_DEMO !== "true") {
    throw new Error("请显式设置 KNOWLEDGE_BASE_SEED_DEMO=true 后再运行开发测试仓库 seed。");
  }
  if (process.env.KNOWLEDGE_BASE_PACKAGED === "true") {
    throw new Error("安装版禁止创建开发测试仓库。");
  }

  const materialsRootPath = path.join(process.cwd(), "materials");
  await prisma.knowledgeBase.upsert({
    where: { id: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID },
    update: {
      name: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_NAME,
      description: "仅供显式开发测试使用；同步跟踪工作区 materials/ 的 Markdown 快照。",
      syncRootPath: materialsRootPath,
    },
    create: {
      id: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID,
      name: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_NAME,
      description: "仅供显式开发测试使用；同步跟踪工作区 materials/ 的 Markdown 快照。",
      defaultLanguage: "zh-CN",
      syncRootPath: materialsRootPath,
    },
  });

  await prisma.knowledgeDocument.deleteMany({ where: { knowledgeBaseId: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID } });
  await prisma.ingestRun.deleteMany({ where: { knowledgeBaseId: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID } });
  await prisma.auditLog.deleteMany({ where: { knowledgeBaseId: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID } });
  await prisma.knowledgeSource.deleteMany({ where: { knowledgeBaseId: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID } });
  await prisma.managedAsset.deleteMany({ where: { knowledgeBaseId: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID } });
  await prisma.managedObject.deleteMany({ where: { knowledgeBaseId: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID } });
  await rm(getKnowledgeBaseDirectory(DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID), { recursive: true, force: true });

  const result = await syncDirectoryKnowledgeBase(DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID);
  console.log(JSON.stringify({ knowledgeBaseId: DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID, importMode: ImportSourceMode.SYNC, rootPath: materialsRootPath, ...result }));
}

void main().finally(async () => prisma.$disconnect());
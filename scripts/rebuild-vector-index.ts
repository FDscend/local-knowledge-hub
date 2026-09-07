import "dotenv/config";

import { rebuildKnowledgeBaseVectorIndex } from "@/lib/embedding";
import { prisma } from "@/lib/prisma";

function readKnowledgeBaseId(): string {
  const value = process.argv.find((argument) => argument.startsWith("--knowledgeBaseId="))?.slice("--knowledgeBaseId=".length).trim();
  if (!value) {
    throw new Error("缺少 --knowledgeBaseId=... 参数。");
  }
  return value;
}

async function main(): Promise<void> {
  const result = await rebuildKnowledgeBaseVectorIndex(readKnowledgeBaseId());
  console.log(JSON.stringify(result));
}

void main().finally(async () => prisma.$disconnect());

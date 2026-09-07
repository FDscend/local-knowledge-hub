import { rebuildKnowledgeBaseFtsIndex } from "@/lib/fts";
import { requireKnowledgeBase } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";

function readKnowledgeBaseId(): string {
  const value = process.argv.find((argument) => argument.startsWith("--knowledgeBaseId="))?.slice("--knowledgeBaseId=".length).trim();
  if (!value) {
    throw new Error("缺少 --knowledgeBaseId=... 参数。");
  }
  return value;
}

async function main(): Promise<void> {
  const knowledgeBase = await requireKnowledgeBase(readKnowledgeBaseId());
  await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
  console.log(JSON.stringify({ knowledgeBaseId: knowledgeBase.id, rebuilt: true }));
}

void main().finally(async () => prisma.$disconnect());

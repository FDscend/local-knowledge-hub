import { createSyncKnowledgeBase } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";

function readRequiredArgument(name: string): string {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1).trim();
  if (!value) {
    throw new Error(`缺少 ${name}=... 参数。`);
  }
  return value;
}

async function main(): Promise<void> {
  const knowledgeBase = await createSyncKnowledgeBase({
    name: readRequiredArgument("--name"),
    rootPath: readRequiredArgument("--root"),
    description: process.argv.find((argument) => argument.startsWith("--description="))?.slice("--description=".length) ?? null,
    defaultLanguage: process.argv.find((argument) => argument.startsWith("--language="))?.slice("--language=".length) ?? "zh-CN",
  });
  console.log(JSON.stringify({ id: knowledgeBase.id, name: knowledgeBase.name, syncRootPath: knowledgeBase.syncRootPath }));
}

void main().finally(async () => prisma.$disconnect());
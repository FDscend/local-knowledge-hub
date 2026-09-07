import { prisma } from "@/lib/prisma";

type SQLiteColumn = {
  name: string;
};

async function main(): Promise<void> {
  const columns = await prisma.$queryRaw<SQLiteColumn[]>`PRAGMA table_info("KnowledgeSource")`;
  const migrated = !columns.some((column) => column.name === "sourceFileHash");

  if (migrated) {
    await prisma.$executeRawUnsafe("ALTER TABLE \"KnowledgeSource\" ADD COLUMN \"sourceFileHash\" TEXT");
  }

  console.log(JSON.stringify({ sourceFileHash: migrated ? "added" : "already-present" }));
}

void main().finally(async () => prisma.$disconnect());
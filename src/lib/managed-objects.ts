import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ManagedObjectKind } from "@prisma/client";

import { getManagedObjectPath } from "@/lib/data-directory";
import { prisma } from "@/lib/prisma";

export async function persistManagedSource(args: {
  knowledgeBaseId: string;
  content: Buffer;
  originalName: string;
  mimeType?: string | null;
}): Promise<{ sha256: string; objectId: string }> {
  const sha256 = createHash("sha256").update(args.content).digest("hex");
  const safeName = path.basename(args.originalName).replace(/[^a-zA-Z0-9._-]/g, "-") || "source";
  const storagePath = getManagedObjectPath(args.knowledgeBaseId, sha256, "source", safeName);
  await mkdir(path.dirname(storagePath), { recursive: true });
  await writeFile(storagePath, args.content);

  const managedObject = await prisma.managedObject.upsert({
    where: { knowledgeBaseId_sha256: { knowledgeBaseId: args.knowledgeBaseId, sha256 } },
    update: { storagePath, mimeType: args.mimeType || null, size: args.content.byteLength },
    create: {
      knowledgeBaseId: args.knowledgeBaseId,
      sha256,
      kind: ManagedObjectKind.SOURCE,
      storagePath,
      mimeType: args.mimeType || null,
      size: args.content.byteLength,
      referenceCount: 1,
    },
  });

  return { sha256, objectId: managedObject.id };
}
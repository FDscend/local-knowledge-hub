import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DATA_DIR_ENV = "KNOWLEDGE_BASE_DATA_DIR";
const SAFE_KNOWLEDGE_BASE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function requireSafeKnowledgeBaseId(knowledgeBaseId: string): string {
  const normalized = knowledgeBaseId.trim();
  if (!SAFE_KNOWLEDGE_BASE_ID.test(normalized)) {
    throw new Error("知识库标识无效。");
  }
  return normalized;
}

export function getKnowledgeBaseDataDir(): string {
  const configured = process.env[DATA_DIR_ENV]?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  if (process.env.KNOWLEDGE_BASE_PACKAGED === "true") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AIKnowledgeBase");
  }

  return path.join(process.cwd(), ".data", "knowledge-base");
}

export function getKnowledgeBaseDirectory(knowledgeBaseId: string): string {
  return path.join(getKnowledgeBaseDataDir(), "knowledge-bases", requireSafeKnowledgeBaseId(knowledgeBaseId));
}

export function getManagedObjectPath(knowledgeBaseId: string, sha256: string, category: "source" | "assets", originalName: string): string {
  const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, "-") || "asset";
  return path.join(getKnowledgeBaseDirectory(knowledgeBaseId), "objects", sha256, category, safeName);
}

export async function ensureKnowledgeBaseDataDirectories(knowledgeBaseId?: string): Promise<void> {
  const root = getKnowledgeBaseDataDir();
  const paths = [path.join(root, "config")];
  if (knowledgeBaseId) {
    const knowledgeBaseDirectory = getKnowledgeBaseDirectory(knowledgeBaseId);
    paths.push(
      path.join(knowledgeBaseDirectory, "config"),
      path.join(knowledgeBaseDirectory, "objects"),
      path.join(knowledgeBaseDirectory, "jobs"),
      path.join(knowledgeBaseDirectory, "exports"),
    );
  }
  await Promise.all(paths.map((directory) => mkdir(directory, { recursive: true })));
}


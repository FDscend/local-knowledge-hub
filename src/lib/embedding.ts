import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import Database from "better-sqlite3";
import OpenAI from "openai";
import * as sqliteVec from "sqlite-vec";

export type EmbeddingConfig = {
  apiKey: string;
  baseURL?: string;
  model: string;
};

export type EmbeddingConfigOverrides = {
  apiKey?: string | null;
  baseURL?: string | null;
  model?: string | null;
};

export type VectorIndexLifecycle = "IDLE" | "PENDING" | "READY" | "FAILED";

export type EmbeddingIndexStatus = {
  configured: boolean;
  indexedCount: number;
  dimensions: number | null;
  model: string;
  indexedAt: string | null;
  status: VectorIndexLifecycle;
  configSnapshot: string | null;
  errorText: string | null;
};

type VectorDatabase = Database.Database;

let vectorDatabase: VectorDatabase | undefined;
const vectorTableDimensions = new Map<string, number>();

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "::" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) {
    return true;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

async function validateEmbeddingBaseURL(baseURL: string | undefined): Promise<void> {
  if (!baseURL) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("Embedding Base URL 无效。");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw new Error("Embedding Base URL 仅允许不含凭据或自定义端口的 HTTPS 公网地址。");
  }
  if (isIP(parsed.hostname)) {
    if (isPrivateAddress(parsed.hostname)) {
      throw new Error("Embedding Base URL 不能指向回环或私网地址。");
    }
    return;
  }
  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Embedding Base URL 不能解析到回环或私网地址。");
  }
}

function resolveDatabasePath(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  if (!rawUrl.startsWith("file:")) {
    throw new Error("向量索引只支持本机 SQLite DATABASE_URL。");
  }
  const relativePath = rawUrl.slice("file:".length);
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), relativePath);
}

function getVectorDatabase(): VectorDatabase {
  if (vectorDatabase) {
    return vectorDatabase;
  }
  const databasePath = resolveDatabasePath();
  if (!existsSync(databasePath)) {
    throw new Error("SQLite 数据库尚未初始化。");
  }
  vectorDatabase = new Database(databasePath);
  sqliteVec.load(vectorDatabase);
  const vecModule = vectorDatabase.prepare("SELECT name FROM pragma_module_list WHERE name = 'vec0'").get() as { name?: string } | undefined;
  if (vecModule?.name !== "vec0") {
    vectorDatabase.close();
    vectorDatabase = undefined;
    throw new Error("sqlite-vec 扩展未成功加载。");
  }
  return vectorDatabase;
}

function getVectorTableName(knowledgeBaseId: string): string {
  if (!/^[a-zA-Z0-9_]{1,128}$/.test(knowledgeBaseId)) {
    throw new Error("知识库标识不能用于向量索引。");
  }
  return "knowledge_chunk_vectors_" + knowledgeBaseId;
}

function ensureVectorTable(knowledgeBaseId: string, dimensions: number): { database: VectorDatabase; tableName: string } {
  const database = getVectorDatabase();
  const tableName = getVectorTableName(knowledgeBaseId);
  const existingDimensions = vectorTableDimensions.get(knowledgeBaseId);
  if (existingDimensions !== undefined && existingDimensions !== dimensions) {
    database.exec("DROP TABLE IF EXISTS " + tableName);
  }
  database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS " + tableName + " USING vec0(embedding float[" + dimensions + "])");
  vectorTableDimensions.set(knowledgeBaseId, dimensions);
  return { database, tableName };
}

export function getEmbeddingConfig(overrides: EmbeddingConfigOverrides = {}): EmbeddingConfig {
  return {
    apiKey: overrides.apiKey?.trim() || process.env.EMBEDDING_API_KEY?.trim() || "",
    baseURL: overrides.baseURL?.trim() || process.env.EMBEDDING_BASE_URL?.trim() || undefined,
    model: overrides.model?.trim() || process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
  };
}

function ensureVectorMetaTable(database: VectorDatabase): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS knowledge_vector_index_meta (knowledgeBaseId TEXT PRIMARY KEY, status TEXT NOT NULL, embeddingModel TEXT, dimensions INTEGER, indexedCount INTEGER NOT NULL DEFAULT 0, configSnapshot TEXT, errorText TEXT, indexedAt TEXT, updatedAt TEXT NOT NULL)",
  );
}

function writeVectorIndexMeta(
  database: VectorDatabase,
  knowledgeBaseId: string,
  data: {
    status: VectorIndexLifecycle;
    embeddingModel?: string | null;
    dimensions?: number | null;
    indexedCount?: number;
    configSnapshot?: string | null;
    errorText?: string | null;
    indexedAt?: string | null;
  },
): void {
  ensureVectorMetaTable(database);
  database
    .prepare(
      "INSERT INTO knowledge_vector_index_meta (knowledgeBaseId, status, embeddingModel, dimensions, indexedCount, configSnapshot, errorText, indexedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(knowledgeBaseId) DO UPDATE SET status = excluded.status, embeddingModel = excluded.embeddingModel, dimensions = excluded.dimensions, indexedCount = excluded.indexedCount, configSnapshot = excluded.configSnapshot, errorText = excluded.errorText, indexedAt = excluded.indexedAt, updatedAt = excluded.updatedAt",
    )
    .run(
      knowledgeBaseId,
      data.status,
      data.embeddingModel ?? null,
      data.dimensions ?? null,
      data.indexedCount ?? 0,
      data.configSnapshot ?? null,
      data.errorText ?? null,
      data.indexedAt ?? null,
      new Date().toISOString(),
    );
}

export function getEmbeddingIndexStatus(knowledgeBaseId: string): EmbeddingIndexStatus {
  const config = getEmbeddingConfig();
  let database: VectorDatabase | undefined;
  try {
    database = new Database(resolveDatabasePath(), { readonly: true });
    let meta:
      | {
          status: VectorIndexLifecycle;
          embeddingModel: string | null;
          dimensions: number | null;
          indexedCount: number;
          configSnapshot: string | null;
          errorText: string | null;
          indexedAt: string | null;
        }
      | undefined;
    try {
      meta = database
        .prepare(
          "SELECT status, embeddingModel, dimensions, indexedCount, configSnapshot, errorText, indexedAt FROM knowledge_vector_index_meta WHERE knowledgeBaseId = ?",
        )
        .get(knowledgeBaseId) as typeof meta;
    } catch {
      meta = undefined;
    }
    let row: { indexedCount: number; dimensions: number | null; model: string | null; indexedAt: string | null } = {
      indexedCount: 0,
      dimensions: null,
      model: null,
      indexedAt: null,
    };
    try {
      row = database
        .prepare(
          "SELECT COUNT(*) AS indexedCount, MAX(dimensions) AS dimensions, MAX(embeddingModel) AS model, MAX(indexedAt) AS indexedAt FROM knowledge_chunk_vector_map WHERE knowledgeBaseId = ?",
        )
        .get(knowledgeBaseId) as typeof row;
    } catch {
      // mapping table may not exist yet
    }
    const indexedCount = meta?.indexedCount ?? row.indexedCount;
    const status = meta?.status ?? (indexedCount > 0 ? "READY" : "IDLE");
    return {
      configured: Boolean(config.apiKey),
      indexedCount,
      dimensions: meta?.dimensions ?? row.dimensions,
      model: meta?.embeddingModel || row.model || config.model,
      indexedAt: meta?.indexedAt ?? row.indexedAt,
      status,
      configSnapshot: meta?.configSnapshot ?? null,
      errorText: meta?.errorText ?? null,
    };
  } catch {
    return {
      configured: Boolean(config.apiKey),
      indexedCount: 0,
      dimensions: null,
      model: config.model,
      indexedAt: null,
      status: "IDLE",
      configSnapshot: null,
      errorText: null,
    };
  } finally {
    database?.close();
  }
}

async function createEmbedding(input: string, config: EmbeddingConfig): Promise<number[]> {
  await validateEmbeddingBaseURL(config.baseURL);
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const response = await client.embeddings.create({ model: config.model, input });
  const vector = response.data[0]?.embedding;
  if (!vector?.length || !vector.every(Number.isFinite)) {
    throw new Error("Embedding API 未返回有效向量。");
  }
  return vector;
}

export async function rebuildKnowledgeBaseVectorIndex(
  knowledgeBaseId: string,
  overrides: EmbeddingConfigOverrides = {},
): Promise<{ indexedCount: number; dimensions: number; model: string; status: VectorIndexLifecycle }> {
  const config = getEmbeddingConfig(overrides);
  if (!config.apiKey) {
    throw new Error("未配置 Embedding API Key；当前仍可使用 FTS5 关键词检索。");
  }

  const configSnapshot = JSON.stringify({
    model: config.model,
    baseURL: config.baseURL || null,
    hasApiKey: true,
  });
  const metaDatabase = getVectorDatabase();
  writeVectorIndexMeta(metaDatabase, knowledgeBaseId, {
    status: "PENDING",
    embeddingModel: config.model,
    configSnapshot,
    errorText: null,
  });

  try {
    const [{ requireKnowledgeBase }, { prisma }] = await Promise.all([import("@/lib/knowledge-base"), import("@/lib/prisma")]);
    await requireKnowledgeBase(knowledgeBaseId);
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { document: { knowledgeBaseId } },
      select: { id: true, content: true, sectionPath: true, document: { select: { title: true } } },
    });
    if (chunks.length === 0) {
      writeVectorIndexMeta(metaDatabase, knowledgeBaseId, {
        status: "READY",
        embeddingModel: config.model,
        dimensions: 0,
        indexedCount: 0,
        configSnapshot,
        errorText: null,
        indexedAt: new Date().toISOString(),
      });
      return { indexedCount: 0, dimensions: 0, model: config.model, status: "READY" };
    }

    const embeddings: Array<{ chunkId: string; vector: number[] }> = [];
    for (const chunk of chunks) {
      const input = chunk.document.title + "\n" + chunk.sectionPath + "\n" + chunk.content;
      embeddings.push({ chunkId: chunk.id, vector: await createEmbedding(input, config) });
    }
    const dimensions = embeddings[0].vector.length;
    if (embeddings.some((entry) => entry.vector.length !== dimensions)) {
      throw new Error("Embedding API 返回了不一致的向量维度。");
    }

    const rawDatabase = getVectorDatabase();
    const staleTableName = getVectorTableName(knowledgeBaseId);
    rawDatabase.exec("DROP TABLE IF EXISTS " + staleTableName);
    vectorTableDimensions.delete(knowledgeBaseId);
    const { database, tableName } = ensureVectorTable(knowledgeBaseId, dimensions);
    database.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_chunk_vector_map (vectorRowId INTEGER NOT NULL, chunkId TEXT NOT NULL UNIQUE, knowledgeBaseId TEXT NOT NULL, embeddingModel TEXT NOT NULL, dimensions INTEGER NOT NULL, indexedAt TEXT NOT NULL, UNIQUE(knowledgeBaseId, vectorRowId))",
    );
    database.exec("DELETE FROM " + tableName);
    database.prepare("DELETE FROM knowledge_chunk_vector_map WHERE knowledgeBaseId = ?").run(knowledgeBaseId);
    const insertVector = database.prepare("INSERT INTO " + tableName + " (embedding) VALUES (?)");
    const insertMap = database.prepare(
      "INSERT INTO knowledge_chunk_vector_map (vectorRowId, chunkId, knowledgeBaseId, embeddingModel, dimensions, indexedAt) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const indexedAt = new Date().toISOString();
    const transaction = database.transaction(() => {
      for (const entry of embeddings) {
        const result = insertVector.run(JSON.stringify(entry.vector));
        insertMap.run(result.lastInsertRowid, entry.chunkId, knowledgeBaseId, config.model, dimensions, indexedAt);
      }
    });
    transaction();
    writeVectorIndexMeta(database, knowledgeBaseId, {
      status: "READY",
      embeddingModel: config.model,
      dimensions,
      indexedCount: embeddings.length,
      configSnapshot,
      errorText: null,
      indexedAt,
    });
    return { indexedCount: embeddings.length, dimensions, model: config.model, status: "READY" };
  } catch (error) {
    writeVectorIndexMeta(metaDatabase, knowledgeBaseId, {
      status: "FAILED",
      embeddingModel: config.model,
      configSnapshot,
      errorText: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function searchVectorChunkIds(
  knowledgeBaseId: string,
  question: string,
  limit = 30,
  overrides: EmbeddingConfigOverrides = {},
): Promise<string[]> {
  const config = getEmbeddingConfig(overrides);
  if (!config.apiKey) {
    return [];
  }
  const database = getVectorDatabase();
  const mapping = database.prepare("SELECT dimensions FROM knowledge_chunk_vector_map WHERE knowledgeBaseId = ? LIMIT 1").get(knowledgeBaseId) as
    | { dimensions?: number }
    | undefined;
  if (!mapping?.dimensions) {
    return [];
  }
  const vector = await createEmbedding(question, config);
  if (vector.length !== mapping.dimensions) {
    return [];
  }
  const { tableName } = ensureVectorTable(knowledgeBaseId, mapping.dimensions);
  const rows = database
    .prepare(
      "SELECT mapping.chunkId FROM " +
        tableName +
        " vectors JOIN knowledge_chunk_vector_map mapping ON mapping.vectorRowId = vectors.rowid WHERE vectors.embedding MATCH ? AND k = ? AND mapping.knowledgeBaseId = ?",
    )
    .all(JSON.stringify(vector), limit, knowledgeBaseId) as Array<{ chunkId: string }>;
  return rows.map((row) => row.chunkId);
}

/** 读取当前知识库已索引切片的向量（chunkId → 向量），供图谱语义近邻等离线计算使用；无向量索引时返回空数组。 */
export function readIndexedChunkVectors(knowledgeBaseId: string): Array<{ chunkId: string; vector: number[] }> {
  try {
    const database = getVectorDatabase();
    const mapping = database.prepare("SELECT dimensions FROM knowledge_chunk_vector_map WHERE knowledgeBaseId = ? LIMIT 1").get(knowledgeBaseId) as
      | { dimensions?: number }
      | undefined;
    if (!mapping?.dimensions) {
      return [];
    }
    const { tableName } = ensureVectorTable(knowledgeBaseId, mapping.dimensions);
    const rows = database
      .prepare("SELECT vectors.rowid AS rowid, vec_to_json(vectors.embedding) AS vector FROM " + tableName + " vectors")
      .all() as Array<{ rowid: number; vector: string }>;
    const mapRows = database
      .prepare("SELECT vectorRowId, chunkId FROM knowledge_chunk_vector_map WHERE knowledgeBaseId = ?")
      .all(knowledgeBaseId) as Array<{ vectorRowId: number; chunkId: string }>;
    const chunkByRowId = new Map(mapRows.map((row) => [row.vectorRowId, row.chunkId]));
    const result: Array<{ chunkId: string; vector: number[] }> = [];
    for (const row of rows) {
      const chunkId = chunkByRowId.get(row.rowid);
      if (!chunkId) {
        continue;
      }
      const parsed: unknown = JSON.parse(row.vector);
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "number")) {
        result.push({ chunkId, vector: parsed as number[] });
      }
    }
    return result;
  } catch {
    return [];
  }
}

import path from "node:path";

import { readIndexedChunkVectors } from "@/lib/embedding";
import { prisma } from "@/lib/prisma";

// 图谱节点与边类型：节点支持文档 / 标签；边按显式（Markdown 链接）、规则（标签、同来源）、
// 模型建议（切片向量语义近邻）三类生成，每条边保存 provenance 与 confidence。
export type GraphNodeType = "DOCUMENT" | "TAG";
export type GraphEdgeType = "MARKDOWN_LINK" | "HAS_TAG" | "SAME_SOURCE" | "SEMANTIC";

export type GraphNodeItem = {
  id: string;
  nodeType: GraphNodeType;
  documentId: string | null;
  label: string;
};

export type GraphEdgeItem = {
  id: string;
  edgeType: GraphEdgeType;
  sourceNodeId: string;
  targetNodeId: string;
  confidence: number;
  provenance: string;
  evidence: Record<string, unknown> | null;
};

export type GraphBuildResult = {
  nodeCount: number;
  edgeCount: number;
  linkCount: number;
  tagCount: number;
  sourceCount: number;
  semanticCount: number;
  semanticSkipped: boolean;
  skippedDuplicateTitles: string[];
  documentCount: number;
};

type GraphDocument = {
  id: string;
  title: string;
  slug: string;
  sourcePath: string;
  tagsText: string;
  sourceId: string | null;
};

const SEMANTIC_THRESHOLD = 0.72;
const SEMANTIC_TOP_N_PER_DOCUMENT = 3;
const SEMANTIC_MAX_DOCUMENTS = 500;

const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

function normalizeLinkTarget(raw: string): string | null {
  const target = raw.trim();
  if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("data:") || target.startsWith("knowledge-asset://")) {
    return null;
  }
  let normalized = target.split("#")[0] ?? target;
  normalized = normalized.replace(/^\.\//, "");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // 保留原文
  }
  normalized = normalized.replace(/\.md$/i, "");
  return normalized;
}

function parseTags(tagsText: string): string[] {
  return Array.from(new Set(tagsText.split(/[\n,，]/).map((tag) => tag.trim()).filter(Boolean)));
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

// 语义近邻：按文档聚合切片向量（归一化后取平均），两两计算余弦相似度，返回每文档 Top N 的边候选。
function computeSemanticCandidates(
  vectors: Array<{ chunkId: string; vector: number[] }>,
  documentByChunk: Map<string, string>,
  documents: GraphDocument[],
): Array<{ sourceId: string; targetId: string; similarity: number; vectorCount: number }> {
  if (documents.length > SEMANTIC_MAX_DOCUMENTS) {
    return [];
  }
  const documentVectors = new Map<string, { sum: number[]; count: number }>();
  for (const item of vectors) {
    const documentId = documentByChunk.get(item.chunkId);
    if (!documentId) {
      continue;
    }
    const existing = documentVectors.get(documentId);
    const normalized = normalizeVector(item.vector);
    if (existing) {
      for (let i = 0; i < normalized.length; i += 1) {
        existing.sum[i] += normalized[i];
      }
      existing.count += 1;
    } else {
      documentVectors.set(documentId, { sum: normalized, count: 1 });
    }
  }
  const averaged = new Map<string, number[]>();
  for (const [documentId, entry] of documentVectors) {
    averaged.set(documentId, normalizeVector(entry.sum.map((value) => value / entry.count)));
  }
  const ids = documents.map((document) => document.id).filter((id) => averaged.has(id));
  const pairs: Array<{ sourceId: string; targetId: string; similarity: number }> = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const similarity = cosineSimilarity(averaged.get(ids[i]) ?? [], averaged.get(ids[j]) ?? []);
      if (similarity >= SEMANTIC_THRESHOLD) {
        pairs.push({ sourceId: ids[i], targetId: ids[j], similarity });
      }
    }
  }
  const bySource = new Map<string, typeof pairs>();
  for (const pair of pairs) {
    const list = bySource.get(pair.sourceId) ?? [];
    list.push(pair);
    bySource.set(pair.sourceId, list);
  }
  const candidates: Array<{ sourceId: string; targetId: string; similarity: number; vectorCount: number }> = [];
  for (const [sourceId, list] of bySource) {
    const top = [...list].sort((a, b) => b.similarity - a.similarity).slice(0, SEMANTIC_TOP_N_PER_DOCUMENT);
    for (const pair of top) {
      candidates.push({ sourceId, targetId: pair.targetId, similarity: pair.similarity, vectorCount: 0 });
    }
  }
  for (const candidate of candidates) {
    candidate.vectorCount = documentVectors.get(candidate.sourceId)?.count ?? 0;
  }
  return candidates;
}

// 全量重建当前知识库图谱：先清空旧节点与边，再按文档 / 标签节点与三类边重建。
export async function buildKnowledgeGraph(knowledgeBaseId: string): Promise<GraphBuildResult> {
  const documents = (await prisma.knowledgeDocument.findMany({
    where: { knowledgeBaseId, status: "ACTIVE" },
    select: { id: true, title: true, slug: true, sourcePath: true, tagsText: true, sourceId: true, content: true },
    orderBy: { updatedAt: "asc" },
  })) as Array<GraphDocument & { content: string }>;

  await prisma.$transaction(async (transaction) => {
    await transaction.graphEdge.deleteMany({ where: { knowledgeBaseId } });
    await transaction.graphNode.deleteMany({ where: { knowledgeBaseId } });
  });

  const nodeByDocument = new Map<string, string>();
  const skippedDuplicateTitles: string[] = [];
  for (const document of documents) {
    if (nodeByDocument.has(document.id)) {
      continue;
    }
    const existing = await prisma.graphNode.findUnique({
      where: { knowledgeBaseId_nodeType_label: { knowledgeBaseId, nodeType: "DOCUMENT", label: document.title } },
    });
    if (existing) {
      skippedDuplicateTitles.push(document.title);
      continue;
    }
    const node = await prisma.graphNode.create({
      data: { knowledgeBaseId, nodeType: "DOCUMENT", documentId: document.id, label: document.title },
    });
    nodeByDocument.set(document.id, node.id);
  }

  const tagNodeIds = new Map<string, string>();
  for (const document of documents) {
    const nodeId = nodeByDocument.get(document.id);
    if (!nodeId) {
      continue;
    }
    for (const tag of parseTags(document.tagsText)) {
      let tagNodeId = tagNodeIds.get(tag);
      if (!tagNodeId) {
        const existing = await prisma.graphNode.findUnique({
          where: { knowledgeBaseId_nodeType_label: { knowledgeBaseId, nodeType: "TAG", label: tag } },
        });
        if (existing) {
          tagNodeId = existing.id;
        } else {
          const created = await prisma.graphNode.create({
            data: { knowledgeBaseId, nodeType: "TAG", label: tag },
          });
          tagNodeId = created.id;
        }
        tagNodeIds.set(tag, tagNodeId);
      }
    }
  }

  // 显式关系：文档正文中的 Markdown 链接与 wikilink（按 slug / 标题 / 源文件名匹配库内文档）。
  const slugToDocument = new Map<string, GraphDocument>();
  const titleToDocument = new Map<string, GraphDocument>();
  const basenameToDocument = new Map<string, GraphDocument>();
  for (const document of documents) {
    slugToDocument.set(document.slug.toLowerCase(), document);
    if (!titleToDocument.has(document.title)) {
      titleToDocument.set(document.title, document);
    }
    const basename = path.basename(document.sourcePath, path.extname(document.sourcePath));
    if (!basenameToDocument.has(basename)) {
      basenameToDocument.set(basename, document);
    }
  }
  const linkEdges: Array<{ sourceId: string; targetId: string; linkText: string; rawTarget: string }> = [];
  for (const document of documents) {
    const sourceNodeId = nodeByDocument.get(document.id);
    if (!sourceNodeId) {
      continue;
    }
    const targets: Array<{ raw: string; text: string }> = [];
    for (const match of document.content.matchAll(LINK_PATTERN)) {
      targets.push({ raw: match[1] ?? "", text: (match[0].match(/\[([^\]]*)\]/)?.[1] ?? "").trim() });
    }
    for (const match of document.content.matchAll(WIKILINK_PATTERN)) {
      targets.push({ raw: match[1] ?? "", text: (match[1] ?? "").trim() });
    }
    const seen = new Set<string>();
    for (const target of targets) {
      const normalized = normalizeLinkTarget(target.raw);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      const matched =
        slugToDocument.get(normalized.toLowerCase()) ??
        titleToDocument.get(normalized) ??
        basenameToDocument.get(normalized);
      if (!matched || matched.id === document.id) {
        continue;
      }
      linkEdges.push({ sourceId: document.id, targetId: matched.id, linkText: target.text || normalized, rawTarget: target.raw });
    }
  }

  // 规则关系：共享标签（HAS_TAG）与同一来源（SAME_SOURCE）。
  const tagEdges: Array<{ tag: string; documentId: string }> = [];
  for (const document of documents) {
    const nodeId = nodeByDocument.get(document.id);
    if (!nodeId) {
      continue;
    }
    for (const tag of parseTags(document.tagsText)) {
      tagEdges.push({ tag, documentId: document.id });
    }
  }
  const sourceEdges: Array<{ sourceId: string; targetId: string; sourcePath: string }> = [];
  const bySource = new Map<string, GraphDocument[]>();
  for (const document of documents) {
    if (!document.sourceId) {
      continue;
    }
    const list = bySource.get(document.sourceId) ?? [];
    list.push(document);
    bySource.set(document.sourceId, list);
  }
  for (const list of bySource.values()) {
    if (list.length < 2) {
      continue;
    }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [first, second] = [list[i], list[j]].sort((a, b) => a.id.localeCompare(b.id));
        sourceEdges.push({ sourceId: first.id, targetId: second.id, sourcePath: first.sourcePath });
      }
    }
  }

  // 模型建议关系：切片向量语义近邻（无向量索引时跳过并标记）。
  let semanticSkipped = false;
  let semanticEdges: Array<{ sourceId: string; targetId: string; similarity: number; vectorCount: number }> = [];
  const vectors = readIndexedChunkVectors(knowledgeBaseId);
  if (vectors.length > 0) {
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { documentId: { in: documents.map((document) => document.id) } },
      select: { id: true, documentId: true },
    });
    const documentByChunk = new Map(chunks.map((chunk) => [chunk.id, chunk.documentId]));
    semanticEdges = computeSemanticCandidates(vectors, documentByChunk, documents);
  } else {
    semanticSkipped = true;
  }

  let linkCount = 0;
  let tagCount = 0;
  let sourceCount = 0;
  let semanticCount = 0;

  await prisma.$transaction(async (transaction) => {
    const nodeIdOf = (documentId: string): string => nodeByDocument.get(documentId) ?? "";
    for (const edge of linkEdges) {
      const sourceNodeId = nodeIdOf(edge.sourceId);
      const targetNodeId = nodeIdOf(edge.targetId);
      if (!sourceNodeId || !targetNodeId) {
        continue;
      }
      await transaction.graphEdge.create({
        data: {
          knowledgeBaseId,
          edgeType: "MARKDOWN_LINK",
          sourceNodeId,
          targetNodeId,
          confidence: 1,
          provenance: "文档内 Markdown 链接（显式关系）",
          evidenceJson: JSON.stringify({ linkText: edge.linkText, rawTarget: edge.rawTarget }),
        },
      });
      linkCount += 1;
    }
    for (const edge of tagEdges) {
      const tagNodeId = tagNodeIds.get(edge.tag);
      const documentNodeId = nodeIdOf(edge.documentId);
      if (!tagNodeId || !documentNodeId) {
        continue;
      }
      await transaction.graphEdge.create({
        data: {
          knowledgeBaseId,
          edgeType: "HAS_TAG",
          sourceNodeId: tagNodeId,
          targetNodeId: documentNodeId,
          confidence: 1,
          provenance: "共享标签（规则关系）",
          evidenceJson: JSON.stringify({ tag: edge.tag }),
        },
      });
      tagCount += 1;
    }
    for (const edge of sourceEdges) {
      const sourceNodeId = nodeIdOf(edge.sourceId);
      const targetNodeId = nodeIdOf(edge.targetId);
      if (!sourceNodeId || !targetNodeId) {
        continue;
      }
      await transaction.graphEdge.create({
        data: {
          knowledgeBaseId,
          edgeType: "SAME_SOURCE",
          sourceNodeId,
          targetNodeId,
          confidence: 1,
          provenance: "同一导入来源（规则关系）",
          evidenceJson: JSON.stringify({ sourcePath: edge.sourcePath }),
        },
      });
      sourceCount += 1;
    }
    for (const edge of semanticEdges) {
      const sourceNodeId = nodeIdOf(edge.sourceId);
      const targetNodeId = nodeIdOf(edge.targetId);
      if (!sourceNodeId || !targetNodeId) {
        continue;
      }
      await transaction.graphEdge.create({
        data: {
          knowledgeBaseId,
          edgeType: "SEMANTIC",
          sourceNodeId,
          targetNodeId,
          confidence: edge.similarity,
          provenance: "切片向量语义近邻（模型建议，非事实关系）",
          evidenceJson: JSON.stringify({ similarity: Number(edge.similarity.toFixed(4)), vectorCount: edge.vectorCount }),
        },
      });
      semanticCount += 1;
    }
  });

  const totalNodeCount = await prisma.graphNode.count({ where: { knowledgeBaseId } });
  await prisma.auditLog.create({
    data: {
      knowledgeBaseId,
      actor: "local-user",
      action: "graph-rebuilt",
      targetType: "KnowledgeBase",
      targetId: knowledgeBaseId,
      afterData: JSON.stringify({ nodeCount: totalNodeCount, edgeCount: linkCount + tagCount + sourceCount + semanticCount, linkCount, tagCount, sourceCount, semanticCount, semanticSkipped }),
    },
  });

  return {
    nodeCount: totalNodeCount,
    edgeCount: linkCount + tagCount + sourceCount + semanticCount,
    linkCount,
    tagCount,
    sourceCount,
    semanticCount,
    semanticSkipped,
    skippedDuplicateTitles,
    documentCount: documents.length,
  };
}

export type GraphQueryOptions = {
  edgeTypes?: GraphEdgeType[];
  /** 节点数量上限（按文档更新时间取最近 N 个，保护大库渲染）。 */
  maxNodes?: number;
  tagFilter?: string;
};

export async function getKnowledgeGraph(
  knowledgeBaseId: string,
  options: GraphQueryOptions = {},
): Promise<{ nodes: GraphNodeItem[]; edges: GraphEdgeItem[] }> {
  const maxNodes = Math.min(options.maxNodes ?? 400, 1000);
  let nodes = await prisma.graphNode.findMany({
    where: { knowledgeBaseId },
    orderBy: [{ nodeType: "asc" }, { updatedAt: "desc" }],
    take: maxNodes,
  });
  if (options.tagFilter?.trim()) {
    const tag = options.tagFilter.trim();
    const tagNode = nodes.find((node) => node.nodeType === "TAG" && node.label === tag);
    const documentIds = tagNode
      ? (
          await prisma.graphEdge.findMany({
            where: { knowledgeBaseId, edgeType: "HAS_TAG", sourceNodeId: tagNode.id },
            select: { targetNodeId: true },
          })
        ).map((edge) => edge.targetNodeId)
      : [];
    nodes = nodes.filter((node) => node.id === tagNode?.id || documentIds.includes(node.id));
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = await prisma.graphEdge.findMany({
    where: {
      knowledgeBaseId,
      sourceNodeId: { in: Array.from(nodeIds) },
      targetNodeId: { in: Array.from(nodeIds) },
      ...(options.edgeTypes?.length ? { edgeType: { in: options.edgeTypes } } : {}),
    },
  });
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      nodeType: node.nodeType as GraphNodeType,
      documentId: node.documentId,
      label: node.label,
    })),
    edges: edges.map((edge) => {
      let evidence: Record<string, unknown> | null = null;
      if (edge.evidenceJson) {
        try {
          const parsed: unknown = JSON.parse(edge.evidenceJson);
          if (parsed && typeof parsed === "object") {
            evidence = parsed as Record<string, unknown>;
          }
        } catch {
          evidence = null;
        }
      }
      return {
        id: edge.id,
        edgeType: edge.edgeType as GraphEdgeType,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        confidence: edge.confidence,
        provenance: edge.provenance,
        evidence,
      };
    }),
  };
}

export type GraphStatus = {
  nodeCount: number;
  edgeCount: number;
  builtAt: string | null;
  semanticSkipped: boolean | null;
};

export async function getGraphStatus(knowledgeBaseId: string): Promise<GraphStatus> {
  const [nodeCount, edgeCount, lastTask] = await Promise.all([
    prisma.graphNode.count({ where: { knowledgeBaseId } }),
    prisma.graphEdge.count({ where: { knowledgeBaseId } }),
    prisma.task.findFirst({
      where: { knowledgeBaseId, kind: "GRAPH_BUILD" },
      orderBy: { createdAt: "desc" },
      select: { status: true, resultJson: true, finishedAt: true },
    }),
  ]);
  let semanticSkipped: boolean | null = null;
  if (lastTask?.resultJson) {
    try {
      const result = JSON.parse(lastTask.resultJson) as { semanticSkipped?: boolean };
      semanticSkipped = Boolean(result.semanticSkipped);
    } catch {
      semanticSkipped = null;
    }
  }
  return {
    nodeCount,
    edgeCount,
    builtAt: lastTask?.finishedAt?.toISOString() ?? null,
    semanticSkipped,
  };
}

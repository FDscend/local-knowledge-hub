"use server";

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { DocumentStatus, ImportSourceMode, IngestMode, KnowledgeSourceKind, SourceType } from "@prisma/client";
import matter from "gray-matter";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { chunkMarkdown } from "@/lib/ingest";
import { rebuildKnowledgeBaseFtsIndex } from "@/lib/fts";
import { ensureKnowledgeBaseDataDirectories, getKnowledgeBaseDirectory } from "@/lib/data-directory";
import { resolveSyncConflict, saveDirectoryIgnoreRules, syncDirectoryKnowledgeBase } from "@/lib/directory-sync";
import { exportKnowledgeDocument } from "@/lib/export-document";
import { persistKnowledgeAssets, rewriteMarkdownImageLinks } from "@/lib/knowledge-assets";
import { clearKnowledgeBase, createKnowledgeBase, deleteKnowledgeBase, hashContent, requireKnowledgeBase } from "@/lib/knowledge-base";
import { readUploadedKnowledgeContent } from "@/lib/knowledge-import";
import { generateMetadataSuggestions } from "@/lib/knowledge-metadata";
import { persistManagedSource } from "@/lib/managed-objects";
import { prisma } from "@/lib/prisma";
import { createManualSlug } from "@/lib/slug";
import { TASK_KIND, cancelQueuedTask, enqueueTask, retryTask } from "@/lib/tasks";

const editableDocumentSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  title: z.string().trim().min(1, "标题不能为空"),
  summary: z.string().trim().optional().transform((value) => value || null),
  tagsText: z.string().trim().optional().transform((value) => value || ""),
  domain: z.string().trim().optional().transform((value) => value || ""),
  sourceType: z.nativeEnum(SourceType),
  sourcePath: z.string().trim().min(1, "来源路径不能为空"),
  sourceUrl: z.string().trim().optional().transform((value) => value || null),
  status: z.nativeEnum(DocumentStatus),
  ingestMode: z.nativeEnum(IngestMode).optional().default(IngestMode.SMALL_NOTE),
  content: z.string().trim().min(1, "正文不能为空"),
  runtimeLlmApiKey: z.string().trim().optional().transform((value) => value || ""),
  runtimeLlmBaseUrl: z.string().trim().optional().transform((value) => value || ""),
  runtimeLlmModel: z.string().trim().optional().transform((value) => value || ""),
});

const createDocumentSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  title: z.string().trim().min(1, "标题不能为空"),
  summary: z.string().trim().optional().transform((value) => value || null),
  tagsText: z.string().trim().optional().transform((value) => value || ""),
  domain: z.string().trim().optional().transform((value) => value || ""),
  sourceType: z.nativeEnum(SourceType),
  sourceUrl: z.string().trim().optional().transform((value) => value || null),
  status: z.nativeEnum(DocumentStatus),
  sourcePath: z.string().trim().optional().transform((value) => value || ""),
  content: z.string().trim().optional().transform((value) => value || ""),
  mineruMode: z.enum(["light", "precise"]).optional().default("light"),
  runtimeLlmApiKey: z.string().trim().optional().transform((value) => value || ""),
  runtimeLlmBaseUrl: z.string().trim().optional().transform((value) => value || ""),
  runtimeLlmModel: z.string().trim().optional().transform((value) => value || ""),
  runtimeMineruApiKey: z.string().trim().optional().transform((value) => value || ""),
});

function normalizeTags(tagsText: string): string {
  return Array.from(
    new Set(
      tagsText
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).join(", ");
}

function createSummary(summary: string | null, content: string): string {
  if (summary) {
    return summary;
  }

  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 180).trim()}...` : compact;
}

function extractFrontmatterTags(content: string): string[] {
  const parsed = matter(content);
  const rawTags = parsed.data.tags;

  if (Array.isArray(rawTags)) {
    return rawTags.map((tag) => String(tag).trim()).filter(Boolean);
  }

  if (typeof rawTags === "string") {
    return rawTags
      .split(/[\n,]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

async function resolveSummary(
  summary: string | null,
  title: string,
  domain: string,
  content: string,
  runtimeLlmApiKey: string,
  runtimeLlmBaseUrl: string,
  runtimeLlmModel: string,
): Promise<string> {
  if (summary) {
    return summary;
  }

  try {
    const suggestions = await generateMetadataSuggestions(
      {
        title,
        domain,
        content,
      },
      {
        llmApiKey: runtimeLlmApiKey,
        llmBaseURL: runtimeLlmBaseUrl,
        llmModel: runtimeLlmModel,
      },
    );

    if (suggestions.summary.trim()) {
      return suggestions.summary.trim();
    }
  } catch {
    // Fall through to local excerpt if metadata generation fails.
  }

  return createSummary(summary, content);
}

function parseEditableFormData(formData: FormData) {
  return editableDocumentSchema.parse({
    knowledgeBaseId: formData.get("knowledgeBaseId"),
    title: formData.get("title"),
    summary: formData.get("summary"),
    tagsText: formData.get("tagsText"),
    domain: formData.get("domain"),
    sourceType: formData.get("sourceType"),
    sourcePath: formData.get("sourcePath"),
    sourceUrl: formData.get("sourceUrl"),
    status: formData.get("status"),
    ingestMode: formData.get("ingestMode"),
    content: formData.get("content"),
    runtimeLlmApiKey: formData.get("runtimeLlmApiKey"),
    runtimeLlmBaseUrl: formData.get("runtimeLlmBaseUrl"),
    runtimeLlmModel: formData.get("runtimeLlmModel"),
  });
}

function parseCreateFormData(formData: FormData) {
  return createDocumentSchema.parse({
    knowledgeBaseId: formData.get("knowledgeBaseId"),
    title: formData.get("title"),
    summary: formData.get("summary"),
    tagsText: formData.get("tagsText"),
    domain: formData.get("domain"),
    sourceType: formData.get("sourceType"),
    sourceUrl: formData.get("sourceUrl"),
    status: formData.get("status"),
    sourcePath: formData.get("sourcePath"),
    content: formData.get("content") ?? undefined,
    mineruMode: formData.get("mineruMode") ?? undefined,
    runtimeLlmApiKey: formData.get("runtimeLlmApiKey"),
    runtimeLlmBaseUrl: formData.get("runtimeLlmBaseUrl"),
    runtimeLlmModel: formData.get("runtimeLlmModel"),
    runtimeMineruApiKey: formData.get("runtimeMineruApiKey"),
  });
}

async function rewriteDocumentChunks(documentId: string, content: string, ingestMode: IngestMode, title: string) {
  const chunks = chunkMarkdown(content, ingestMode, title);

  await prisma.knowledgeChunk.deleteMany({
    where: {
      documentId,
    },
  });

  if (chunks.length === 0) {
    return;
  }

  await prisma.knowledgeChunk.createMany({
    data: chunks.map((chunk, index) => ({
      documentId,
      chunkIndex: index,
      heading: chunk.heading,
      sectionPath: chunk.sectionPath,
      content: chunk.content,
      tokenEstimate: chunk.tokenEstimate,
    })),
  });
}

async function createKnowledgeDocument(input: {
  knowledgeBaseId: string;
  title: string;
  summary: string | null;
  tagsText: string;
  domain: string;
  sourceType: SourceType;
  sourcePath: string;
  sourceUrl: string | null;
  status: DocumentStatus;
  ingestMode: IngestMode;
  content: string;
  runtimeLlmApiKey: string;
  runtimeLlmBaseUrl: string;
  runtimeLlmModel: string;
  sourceKind: KnowledgeSourceKind;
  sourceContent: Buffer;
  sourceFileName: string;
  sourceMimeType?: string | null;
  assetIds?: string[];
  frontmatter?: string | null;
}) {
  const knowledgeBase = await requireKnowledgeBase(input.knowledgeBaseId);
  const tagsText = normalizeTags(input.tagsText);
  const summary = await resolveSummary(
    input.summary,
    input.title,
    input.domain,
    input.content,
    input.runtimeLlmApiKey,
    input.runtimeLlmBaseUrl,
    input.runtimeLlmModel,
  );

  const parsedContent = matter(input.content);
  const frontmatter = input.frontmatter ?? (Object.keys(parsedContent.data).length > 0 ? JSON.stringify(parsedContent.data) : null);
  const body = parsedContent.content.trim() || input.content;

  const managedSource = await persistManagedSource({
    knowledgeBaseId: knowledgeBase.id,
    content: input.sourceContent,
    originalName: input.sourceFileName,
    mimeType: input.sourceMimeType,
  });
  const contentHash = hashContent(body);
  const source = await prisma.knowledgeSource.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      kind: input.sourceKind,
      importMode: ImportSourceMode.SNAPSHOT,
      canonicalPathOrUrl: input.sourceUrl || input.sourcePath,
      contentHash,
      lastSeenAt: new Date(),
      syncStatus: "SNAPSHOT",
    },
  });

  const document = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      sourceId: source.id,
      slug: createManualSlug(input.title),
      title: input.title,
      summary,
      tagsText,
      domain: input.domain,
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      sourceUrl: input.sourceUrl,
      status: input.status,
      ingestMode: input.ingestMode,
      content: body,
      frontmatter,
    },
  });

  const version = await prisma.documentVersion.create({
    data: {
      documentId: document.id,
      contentMarkdown: body,
      contentHash,
      managedObjectHash: managedSource.sha256,
      createdBy: "local-admin",
      changeReason: "create",
    },
  });
  await prisma.knowledgeDocument.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
  if (input.assetIds?.length) {
    await prisma.managedAsset.updateMany({ where: { id: { in: input.assetIds }, knowledgeBaseId: knowledgeBase.id }, data: { documentVersionId: version.id } });
  }
  await rewriteDocumentChunks(document.id, body, input.ingestMode, input.title);
  await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
  await prisma.auditLog.create({
    data: { knowledgeBaseId: knowledgeBase.id, action: "create-document", targetType: "KnowledgeDocument", targetId: document.id, afterData: JSON.stringify({ versionId: version.id }) },
  });
  return document;
}

export async function createKnowledgeBaseAction(formData: FormData) {
  const name = z.string().trim().min(1, "知识库名称不能为空").parse(formData.get("name"));
  const description = z.string().trim().optional().parse(formData.get("description"));
  const defaultLanguage = z.string().trim().optional().parse(formData.get("defaultLanguage"));
  const knowledgeBase = await createKnowledgeBase({ name, description, defaultLanguage });
  revalidatePath("/");
  revalidatePath("/knowledge-bases");
  redirect(`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`);
}

export async function syncKnowledgeBaseAction(formData: FormData) {
  const knowledgeBaseId = z.string().trim().min(1).parse(formData.get("knowledgeBaseId"));
  const selectedPaths = formData
    .getAll("selectedPaths")
    .map((value) => String(value).trim())
    .filter(Boolean);
  const mineruMode = z.enum(["light", "precise"]).optional().parse(formData.get("mineruMode") || undefined) ?? "light";
  const mineruApiKey = z.string().trim().optional().parse(formData.get("runtimeMineruApiKey") || undefined) ?? null;
  const result = await syncDirectoryKnowledgeBase(knowledgeBaseId, {
    relativePaths: selectedPaths.length > 0 ? selectedPaths : undefined,
    mineruMode,
    mineruApiKey,
  });
  revalidatePath("/");
  revalidatePath("/knowledge");
  revalidatePath("/knowledge-bases");
  revalidatePath("/qa");
  redirect(
    `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/sync?imported=${result.importedCount}&unchanged=${result.unchangedCount}&missing=${result.missingCount}&conflicts=${result.conflictCount}&skipped=${result.skippedCount}&errors=${result.errorCount}`,
  );
}

export async function resolveSyncConflictAction(formData: FormData) {
  const input = z
    .object({
      knowledgeBaseId: z.string().trim().min(1),
      relativePath: z.string().trim().min(1),
      resolution: z.enum(["keep-source", "keep-knowledge", "create-new"]),
      mineruMode: z.enum(["light", "precise"]).optional().default("light"),
      runtimeMineruApiKey: z.string().trim().optional().transform((value) => value || null),
    })
    .parse({
      knowledgeBaseId: formData.get("knowledgeBaseId"),
      relativePath: formData.get("relativePath"),
      resolution: formData.get("resolution"),
      mineruMode: formData.get("mineruMode") ?? undefined,
      runtimeMineruApiKey: formData.get("runtimeMineruApiKey"),
    });
  const result = await resolveSyncConflict({
    knowledgeBaseId: input.knowledgeBaseId,
    relativePath: input.relativePath,
    resolution: input.resolution,
    mineruMode: input.mineruMode,
    mineruApiKey: input.runtimeMineruApiKey,
  });
  revalidatePath("/");
  revalidatePath("/knowledge");
  revalidatePath(`/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/sync`);
  redirect(
    `/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/sync?imported=${result.importedCount}&unchanged=${result.unchangedCount}&missing=${result.missingCount}&conflicts=${result.conflictCount}&skipped=${result.skippedCount}&errors=${result.errorCount}`,
  );
}

export async function exportKnowledgeDocumentAction(formData: FormData) {
  const input = z
    .object({
      knowledgeBaseId: z.string().trim().min(1),
      documentId: z.string().trim().min(1),
    })
    .parse({
      knowledgeBaseId: formData.get("knowledgeBaseId"),
      documentId: formData.get("documentId"),
    });
  const result = await exportKnowledgeDocument(input.documentId, input.knowledgeBaseId);
  revalidatePath(`/knowledge/${encodeURIComponent(input.documentId)}`);
  redirect(
    `/knowledge/${encodeURIComponent(input.documentId)}?knowledgeBaseId=${encodeURIComponent(input.knowledgeBaseId)}&exported=1&exportDir=${encodeURIComponent(result.exportDirectory)}&assetCount=${result.assetCount}`,
  );
}

export async function retryTaskAction(formData: FormData) {
  const input = z
    .object({
      taskId: z.string().trim().min(1),
      knowledgeBaseId: z.string().trim().min(1),
    })
    .parse({
      taskId: formData.get("taskId"),
      knowledgeBaseId: formData.get("knowledgeBaseId"),
    });
  const retried = await retryTask(input.knowledgeBaseId, input.taskId);
  if (!retried) {
    throw new Error("只有失败状态的任务可以重试。");
  }
  revalidatePath("/tasks");
}

export async function cancelTaskAction(formData: FormData) {
  const input = z
    .object({
      taskId: z.string().trim().min(1),
      knowledgeBaseId: z.string().trim().min(1),
    })
    .parse({
      taskId: formData.get("taskId"),
      knowledgeBaseId: formData.get("knowledgeBaseId"),
    });
  const cancelled = await cancelQueuedTask(input.knowledgeBaseId, input.taskId);
  if (!cancelled) {
    throw new Error("只有排队中的任务可以取消。");
  }
  revalidatePath("/tasks");
}

export async function saveKnowledgeBaseIgnoreRulesAction(formData: FormData) {
  const input = z
    .object({
      knowledgeBaseId: z.string().trim().min(1),
      globalRules: z.string().max(20_000),
      knowledgeBaseRules: z.string().max(20_000),
    })
    .parse({
      knowledgeBaseId: formData.get("knowledgeBaseId"),
      globalRules: formData.get("globalRules") ?? "",
      knowledgeBaseRules: formData.get("knowledgeBaseRules") ?? "",
    });
  await saveDirectoryIgnoreRules(input.knowledgeBaseId, { global: input.globalRules, knowledgeBase: input.knowledgeBaseRules });
  revalidatePath(`/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/sync`);
  redirect(`/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/sync?rulesSaved=1`);
}

/** 多文件批量上传（非文件夹）：文件名去重后落盘到任务工作目录，交给 INGEST 任务后台解析。 */
export async function importBrowserMultiFileAction(formData: FormData) {
  const knowledgeBaseId = z.string().trim().min(1).parse(formData.get("knowledgeBaseId"));
  const mineruMode = z.enum(["light", "precise"]).optional().parse(formData.get("mineruMode") || undefined) ?? "light";
  const files = formData.getAll("files");
  if (!files.every((value): value is File => value instanceof File)) {
    throw new Error("批量上传包含无效文件。");
  }
  if (files.length === 0 || files.length > 200) {
    throw new Error("请选择 1 至 200 份文件。");
  }

  await requireKnowledgeBase(knowledgeBaseId);
  await ensureKnowledgeBaseDataDirectories(knowledgeBaseId);
  const queued = await enqueueTask(knowledgeBaseId, TASK_KIND.INGEST, { mineruMode, files: [], jobDir: "" }, { maxAttempts: 2 });
  const jobDir = path.join(getKnowledgeBaseDirectory(knowledgeBaseId), "jobs", queued.id);
  await mkdir(jobDir, { recursive: true });

  // 多文件没有目录层级，相对路径使用去重后的文件名（同名文件追加序号）。
  const nameCounts = new Map<string, number>();
  const fileEntries: Array<{ relativePath: string; filePath: string }> = [];
  for (const file of files) {
    const baseName = path.basename(file.name);
    const extension = path.extname(baseName);
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    const occurrence = (nameCounts.get(baseName) ?? 0) + 1;
    nameCounts.set(baseName, occurrence);
    const uniqueName = occurrence === 1 ? baseName : `${stem}-${occurrence}${extension}`;
    const destination = path.join(jobDir, uniqueName);
    await writeFile(destination, Buffer.from(await file.arrayBuffer()));
    fileEntries.push({ relativePath: uniqueName, filePath: destination });
  }
  await prisma.task.update({
    where: { id: queued.id },
    data: { payloadJson: JSON.stringify({ mineruMode, jobDir, files: fileEntries }) },
  });

  revalidatePath("/");
  revalidatePath("/knowledge");
  revalidatePath("/knowledge-bases");
  revalidatePath("/qa");
  revalidatePath("/tasks");
  redirect(`/tasks?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}&queued=1&taskId=${encodeURIComponent(queued.id)}`);
}

export async function importBrowserDirectoryAction(formData: FormData) {
  const knowledgeBaseId = z.string().trim().min(1).parse(formData.get("knowledgeBaseId"));
  const mineruMode = z.enum(["light", "precise"]).optional().parse(formData.get("mineruMode") || undefined) ?? "light";
  const mineruApiKey = z.string().trim().optional().parse(formData.get("runtimeMineruApiKey") || undefined) ?? null;
  const files = formData.getAll("files");
  if (!files.every((value): value is File => value instanceof File)) {
    throw new Error("目录上传包含无效文件。");
  }
  const relativePaths = z.array(z.string().trim().min(1).max(1_024)).parse(formData.getAll("relativePaths"));
  if (files.length !== relativePaths.length) {
    throw new Error("所选文件与相对路径数量不一致，请重新选择文件夹后再试。");
  }
  if (files.length === 0 || files.length > 200) {
    throw new Error("请选择 1 至 200 份文件。");
  }

  // 文件先落盘到任务工作目录，解析（含 MinerU）交给后台任务执行器，页面立即返回任务中心。
  await requireKnowledgeBase(knowledgeBaseId);
  await ensureKnowledgeBaseDataDirectories(knowledgeBaseId);
  const queued = await enqueueTask(knowledgeBaseId, TASK_KIND.INGEST, { mineruMode, files: [], jobDir: "" }, { maxAttempts: 2 });
  const jobDir = path.join(getKnowledgeBaseDirectory(knowledgeBaseId), "jobs", queued.id);
  await mkdir(jobDir, { recursive: true });
  const fileEntries: Array<{ relativePath: string; filePath: string }> = [];
  for (const [index, file] of files.entries()) {
    const relativePath = path.posix.join(...relativePaths[index].split("/").map((part) => path.basename(part)));
    const destination = path.join(jobDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(await file.arrayBuffer()));
    fileEntries.push({ relativePath, filePath: destination });
  }
  await prisma.task.update({
    where: { id: queued.id },
    data: { payloadJson: JSON.stringify({ mineruMode, jobDir, files: fileEntries }) },
  });

  revalidatePath("/");
  revalidatePath("/knowledge");
  revalidatePath("/knowledge-bases");
  revalidatePath("/qa");
  revalidatePath("/tasks");
  redirect(`/tasks?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}&queued=1&taskId=${encodeURIComponent(queued.id)}`);
}

const knowledgeBaseConfirmationSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  confirmationName: z.string().trim().min(1, "请输入知识库名称确认操作。"),
});

export async function clearKnowledgeBaseAction(formData: FormData) {
  const input = knowledgeBaseConfirmationSchema.parse({
    knowledgeBaseId: formData.get("knowledgeBaseId"),
    confirmationName: formData.get("confirmationName"),
  });
  await clearKnowledgeBase(input.knowledgeBaseId, input.confirmationName);
  revalidatePath("/");
  revalidatePath("/knowledge");
  revalidatePath("/knowledge-bases");
  revalidatePath("/qa");
  redirect(`/knowledge-bases?cleared=${encodeURIComponent(input.knowledgeBaseId)}`);
}

export async function deleteKnowledgeBaseAction(formData: FormData) {
  const input = knowledgeBaseConfirmationSchema.parse({
    knowledgeBaseId: formData.get("knowledgeBaseId"),
    confirmationName: formData.get("confirmationName"),
  });
  await deleteKnowledgeBase(input.knowledgeBaseId, input.confirmationName);
  revalidatePath("/");
  revalidatePath("/knowledge");
  revalidatePath("/knowledge-bases");
  revalidatePath("/qa");
  redirect("/knowledge-bases?deleted=1");
}

export async function createKnowledgeAction(formData: FormData) {
  const input = parseCreateFormData(formData);
  const file = formData.get("file");

  const uploadSourceTypes: SourceType[] = [SourceType.MD, SourceType.CLIPPING, SourceType.PDF, SourceType.DOCX, SourceType.PPTX, SourceType.XLSX, SourceType.IMAGE];
  const isUploadSource = uploadSourceTypes.includes(input.sourceType);
  const targetKnowledgeBaseId = input.knowledgeBaseId;
  const targetKnowledgeBase = await requireKnowledgeBase(targetKnowledgeBaseId);
  if (isUploadSource && targetKnowledgeBase.syncRootPath) {
    throw new Error("已绑定同步根目录的知识库不能通过单文件上传写入，请将文件放入同步根目录后执行同步。");
  }

  const document = isUploadSource
    ? await (async () => {
        if (!(file instanceof File) || file.size === 0) {
          throw new Error(input.sourceType === SourceType.MD || input.sourceType === SourceType.CLIPPING ? "请先选择一个 Markdown 文件。" : "请先选择一个待解析文件。");
        }

        const uploaded = await readUploadedKnowledgeContent({
          file,
          sourceType: input.sourceType,
          fallbackTitle: input.title,
          fallbackTagsText: input.tagsText,
          explicitSourceUrl: input.sourceUrl,
          mineruMode: input.mineruMode,
          mineruApiKey: input.runtimeMineruApiKey,
        });

        let normalizedContent = uploaded.content;
        let assetIds: string[] = [];
        if (uploaded.assets.length > 0) {
          const persistedAssets = await persistKnowledgeAssets({
            knowledgeBaseId: targetKnowledgeBaseId,
            assets: uploaded.assets,
          });
          normalizedContent = rewriteMarkdownImageLinks(uploaded.content, persistedAssets.lookup);
          assetIds = persistedAssets.assetIds;
        }

        return createKnowledgeDocument({
          knowledgeBaseId: targetKnowledgeBaseId,
          title: uploaded.title,
          summary: input.summary,
          tagsText: uploaded.tagsText,
          domain: input.domain,
          sourceType: input.sourceType,
          sourcePath: uploaded.sourcePath,
          sourceUrl: uploaded.sourceUrl,
          status: input.status,
          ingestMode: uploaded.ingestMode,
          content: normalizedContent,
          frontmatter: uploaded.frontmatter,
          runtimeLlmApiKey: input.runtimeLlmApiKey,
          runtimeLlmBaseUrl: input.runtimeLlmBaseUrl,
          runtimeLlmModel: input.runtimeLlmModel,
          sourceKind: KnowledgeSourceKind.UPLOAD,
          sourceContent: Buffer.from(await file.arrayBuffer()),
          sourceFileName: file.name,
          sourceMimeType: file.type || null,
          assetIds,
        });
      })()
    : await createKnowledgeDocument({
        knowledgeBaseId: targetKnowledgeBaseId,
        title: input.title,
        summary: input.summary,
        tagsText: [...normalizeTags(input.tagsText), ...extractFrontmatterTags(input.content)].join(", "),
        domain: input.domain,
        sourceType: input.sourceType,
        sourcePath: input.sourcePath || "manual/new-entry.md",
        sourceUrl: input.sourceUrl,
        status: input.status,
        ingestMode: IngestMode.SMALL_NOTE,
        content: input.content,
        runtimeLlmApiKey: input.runtimeLlmApiKey,
        runtimeLlmBaseUrl: input.runtimeLlmBaseUrl,
        runtimeLlmModel: input.runtimeLlmModel,
        sourceKind: KnowledgeSourceKind.MANUAL,
        sourceContent: Buffer.from(input.content, "utf8"),
        sourceFileName: path.basename(input.sourcePath || "manual/new-entry.md"),
        sourceMimeType: "text/markdown",
      });

  revalidatePath("/");
  revalidatePath("/knowledge");
  redirect(`/knowledge/${document.id}?knowledgeBaseId=${encodeURIComponent(targetKnowledgeBaseId)}`);
}

export async function updateKnowledgeAction(id: string, formData: FormData) {
  const input = parseEditableFormData(formData);
  await requireKnowledgeBase(input.knowledgeBaseId);
  const tagsText = normalizeTags(input.tagsText);
  const summary = await resolveSummary(
    input.summary,
    input.title,
    input.domain,
    input.content,
    input.runtimeLlmApiKey,
    input.runtimeLlmBaseUrl,
    input.runtimeLlmModel,
  );

  const parsedContent = matter(input.content);
  const frontmatter = Object.keys(parsedContent.data).length > 0 ? JSON.stringify(parsedContent.data) : null;
  const body = parsedContent.content.trim() || input.content;
  const managedSource = await persistManagedSource({
    knowledgeBaseId: input.knowledgeBaseId,
    content: Buffer.from(input.content, "utf8"),
    originalName: path.basename(input.sourcePath),
    mimeType: "text/markdown",
  });

  const existingDocument = await prisma.knowledgeDocument.findFirst({ where: { id, knowledgeBaseId: input.knowledgeBaseId } });
  if (!existingDocument) {
    throw new Error("文档不存在或不属于当前知识库。");
  }
  const document = await prisma.knowledgeDocument.update({
    where: { id: existingDocument.id },
    data: {
      title: input.title,
      summary,
      tagsText,
      domain: input.domain,
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      sourceUrl: input.sourceUrl,
      status: input.status,
      ingestMode: input.ingestMode,
      content: body,
      frontmatter,
    },
  });

  await rewriteDocumentChunks(document.id, body, input.ingestMode, input.title);
  const version = await prisma.documentVersion.create({
    data: {
      documentId: document.id,
      contentMarkdown: body,
      contentHash: hashContent(body),
      managedObjectHash: managedSource.sha256,
      createdBy: "local-admin",
      changeReason: "edit",
    },
  });
  await prisma.knowledgeDocument.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
  await prisma.auditLog.create({
    data: { knowledgeBaseId: input.knowledgeBaseId, action: "edit-document", targetType: "KnowledgeDocument", targetId: document.id, afterData: JSON.stringify({ versionId: version.id }) },
  });
  await rebuildKnowledgeBaseFtsIndex(input.knowledgeBaseId);

  revalidatePath("/");
  revalidatePath("/knowledge");
  revalidatePath(`/knowledge/${id}`);
  redirect(`/knowledge/${id}?knowledgeBaseId=${encodeURIComponent(input.knowledgeBaseId)}`);
}

export async function deleteKnowledgeAction(id: string, knowledgeBaseId = "default") {
  await prisma.knowledgeDocument.deleteMany({ where: { id, knowledgeBaseId } });
  await rebuildKnowledgeBaseFtsIndex(knowledgeBaseId);

  revalidatePath("/");
  revalidatePath("/knowledge");
  redirect(`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
}

export async function toggleKnowledgeStatusAction(id: string, knowledgeBaseId = "default") {
  const document = await prisma.knowledgeDocument.findFirst({
    where: { id, knowledgeBaseId },
    select: { status: true },
  });

  if (!document) {
    return;
  }

  const nextStatus = document.status === DocumentStatus.DISABLED ? DocumentStatus.ACTIVE : DocumentStatus.DISABLED;

  await prisma.knowledgeDocument.update({
    where: { id },
    data: { status: nextStatus },
  });

  revalidatePath("/");
  revalidatePath("/knowledge");
  revalidatePath(`/knowledge/${id}`);
}

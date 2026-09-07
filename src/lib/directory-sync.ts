import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ImportSourceMode, IngestRunStatus, KnowledgeSourceKind, SourceType } from "@prisma/client";
import matter from "gray-matter";

import { ensureKnowledgeBaseDataDirectories, getKnowledgeBaseDataDir, getKnowledgeBaseDirectory } from "@/lib/data-directory";
import { normalizeMarkdownLineEndings, upsertImportedDocument } from "@/lib/document-upsert";
import { rebuildKnowledgeBaseFtsIndex } from "@/lib/fts";
import { hashContent, requireKnowledgeBase } from "@/lib/knowledge-base";
import { detectMimeTypeFromFileName, getMineruDocumentType, parseDocumentWithMineru, type MineruAsset, type MineruMode } from "@/lib/mineru";
import { prisma } from "@/lib/prisma";
import { enqueueAutoEvaluation, recordCompletedTask } from "@/lib/tasks";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const MINERU_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp"]);
const SUPPORTED_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, ...MINERU_EXTENSIONS]);
const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules", "__pycache__", ".data", ".next"]);

type IgnoreRuleScope = "global" | "knowledgeBase";

type IgnoreRule = {
  pattern: string;
  include: boolean;
  line: number;
  scope: IgnoreRuleScope;
};

export type MatchedRuleSource = "global" | "knowledgeBase" | "system";

export type DirectoryScanItem = {
  relativePath: string;
  absolutePath: string;
  status: "READY" | "IGNORED" | "UNSUPPORTED" | "OUTSIDE_ROOT" | "CHANGED" | "CONFLICT" | "MISSING" | "SYNCED";
  matchedRule: string | null;
  matchedRuleSource: MatchedRuleSource | null;
  matchedRuleLine: number | null;
  matchedRuleInclude: boolean | null;
  sourceType: "MD" | "PDF" | "DOCX" | "PPTX" | "XLSX" | "IMAGE" | null;
  documentId: string | null;
  contentHash: string | null;
  documentContentHash: string | null;
  documentUpdatedAt: Date | null;
  sourceFileHash: string | null;
  lastSeenAt: Date | null;
  fileSize: number | null;
  lastModifiedAt: Date | null;
};

export type DirectorySyncResult = {
  runId: string;
  importedCount: number;
  unchangedCount: number;
  missingCount: number;
  conflictCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
};

export type DirectorySyncOptions = {
  relativePaths?: string[];
  mineruMode?: MineruMode;
  mineruApiKey?: string | null;
  forceOverwriteConflict?: boolean;
};

export type BrowserDirectorySnapshotFile = {
  file: File;
  relativePath: string;
};

function toPosixRelativePath(rootPath: string, candidatePath: string): string {
  return path.relative(rootPath, candidatePath).split(path.sep).join("/");
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== "..");
}

function parseIgnoreRules(content: string, scope: IgnoreRuleScope): IgnoreRule[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith("#"))
    .map(({ line, lineNumber }) => ({ include: line.startsWith("!"), pattern: line.startsWith("!") ? line.slice(1) : line, line: lineNumber, scope }))
    .filter((rule) => rule.pattern.length > 0);
}

async function readIgnoreRules(filePath: string, scope: IgnoreRuleScope): Promise<IgnoreRule[]> {
  try {
    return parseIgnoreRules(await readFile(filePath, "utf8"), scope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\//, "").replace(/\/$/, "/**");
  let expression = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const nextCharacter = normalized[index + 1];
    if (character === "*" && nextCharacter === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }

  return new RegExp(`${expression}$`, "u");
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  if (!normalizedPattern.includes("/")) {
    return globToRegExp(`**/${normalizedPattern}`).test(relativePath) || globToRegExp(normalizedPattern).test(path.posix.basename(relativePath));
  }
  return globToRegExp(normalizedPattern).test(relativePath);
}

function findMatchingRule(relativePath: string, rules: IgnoreRule[]): IgnoreRule | null {
  let result: IgnoreRule | null = null;
  for (const rule of rules) {
    if (matchesPattern(relativePath, rule.pattern)) {
      result = rule;
    }
  }
  return result;
}

async function loadRules(knowledgeBaseId: string): Promise<IgnoreRule[]> {
  const [globalRules, knowledgeBaseRules] = await Promise.all([
    readIgnoreRules(path.join(getKnowledgeBaseDataDir(), "config", "ignore"), "global"),
    readIgnoreRules(path.join(getKnowledgeBaseDirectory(knowledgeBaseId), "ignore"), "knowledgeBase"),
  ]);
  return [...globalRules, ...knowledgeBaseRules];
}

export async function getDirectoryIgnoreRules(knowledgeBaseId: string): Promise<{ global: string; knowledgeBase: string }> {
  await requireKnowledgeBase(knowledgeBaseId);
  const [global, knowledgeBase] = await Promise.all([
    readFile(path.join(getKnowledgeBaseDataDir(), "config", "ignore"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    }),
    readFile(path.join(getKnowledgeBaseDirectory(knowledgeBaseId), "ignore"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    }),
  ]);
  return { global, knowledgeBase };
}

export async function saveDirectoryIgnoreRules(knowledgeBaseId: string, rules: { global: string; knowledgeBase: string }): Promise<void> {
  await requireKnowledgeBase(knowledgeBaseId);
  await ensureKnowledgeBaseDataDirectories(knowledgeBaseId);
  const files = [
    { filePath: path.join(getKnowledgeBaseDataDir(), "config", "ignore"), content: rules.global },
    { filePath: path.join(getKnowledgeBaseDirectory(knowledgeBaseId), "ignore"), content: rules.knowledgeBase },
  ];
  await Promise.all(
    files.map(async ({ filePath, content }) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content.replace(/\r\n/g, "\n"), "utf8");
    }),
  );
}

function detectSourceType(relativePath: string): "MD" | "PDF" | "DOCX" | "PPTX" | "XLSX" | "IMAGE" | null {
  const extension = path.extname(relativePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return "MD";
  }
  const mineruType = getMineruDocumentType(relativePath);
  if (mineruType) {
    return mineruType;
  }
  return null;
}

async function scanDirectory(rootPath: string, knowledgeBaseId: string): Promise<DirectoryScanItem[]> {
  const rules = await loadRules(knowledgeBaseId);
  const dataDirectory = await realpath(getKnowledgeBaseDataDir()).catch(() => path.resolve(getKnowledgeBaseDataDir()));
  const results: DirectoryScanItem[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = toPosixRelativePath(rootPath, entryPath);

      if (entry.isSymbolicLink()) {
        results.push({ relativePath, absolutePath: entryPath, status: "OUTSIDE_ROOT", matchedRule: "符号链接", matchedRuleSource: "system", matchedRuleLine: null, matchedRuleInclude: null, sourceType: null, documentId: null, contentHash: null, documentContentHash: null, documentUpdatedAt: null, sourceFileHash: null, lastSeenAt: null, fileSize: null, lastModifiedAt: null });
        continue;
      }
      if (entry.isDirectory()) {
        if (HARD_EXCLUDED_DIRECTORY_NAMES.has(entry.name) || isWithinRoot(entryPath, dataDirectory)) {
          results.push({ relativePath, absolutePath: entryPath, status: "IGNORED", matchedRule: "安全硬排除", matchedRuleSource: "system", matchedRuleLine: null, matchedRuleInclude: null, sourceType: null, documentId: null, contentHash: null, documentContentHash: null, documentUpdatedAt: null, sourceFileHash: null, lastSeenAt: null, fileSize: null, lastModifiedAt: null });
          continue;
        }
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const resolvedPath = await realpath(entryPath);
      if (!isWithinRoot(resolvedPath, rootPath)) {
        results.push({ relativePath, absolutePath: entryPath, status: "OUTSIDE_ROOT", matchedRule: "解析后路径位于同步根外", matchedRuleSource: "system", matchedRuleLine: null, matchedRuleInclude: null, sourceType: null, documentId: null, contentHash: null, documentContentHash: null, documentUpdatedAt: null, sourceFileHash: null, lastSeenAt: null, fileSize: null, lastModifiedAt: null });
        continue;
      }

      const fileDetails = await stat(resolvedPath);
      const rule = findMatchingRule(relativePath, rules);
      if (rule && !rule.include) {
        results.push({ relativePath, absolutePath: resolvedPath, status: "IGNORED", matchedRule: rule.pattern, matchedRuleSource: rule.scope, matchedRuleLine: rule.line, matchedRuleInclude: rule.include, sourceType: null, documentId: null, contentHash: null, documentContentHash: null, documentUpdatedAt: null, sourceFileHash: null, lastSeenAt: null, fileSize: fileDetails.size, lastModifiedAt: fileDetails.mtime });
        continue;
      }
      const sourceType = detectSourceType(entry.name);
      if (!sourceType) {
        results.push({ relativePath, absolutePath: resolvedPath, status: "UNSUPPORTED", matchedRule: rule?.pattern ?? null, matchedRuleSource: rule?.scope ?? null, matchedRuleLine: rule?.line ?? null, matchedRuleInclude: rule?.include ?? null, sourceType: null, documentId: null, contentHash: null, documentContentHash: null, documentUpdatedAt: null, sourceFileHash: null, lastSeenAt: null, fileSize: fileDetails.size, lastModifiedAt: fileDetails.mtime });
        continue;
      }
      results.push({ relativePath, absolutePath: resolvedPath, status: "READY", matchedRule: rule?.pattern ?? null, matchedRuleSource: rule?.scope ?? null, matchedRuleLine: rule?.line ?? null, matchedRuleInclude: rule?.include ?? null, sourceType, documentId: null, contentHash: null, documentContentHash: null, documentUpdatedAt: null, sourceFileHash: null, lastSeenAt: null, fileSize: fileDetails.size, lastModifiedAt: fileDetails.mtime });
    }
  }

  await visit(rootPath);
  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));
}

function normalizeBrowserRelativePath(relativePath: string, fileName: string): string {
  const normalized = relativePath.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === ".." || part === "." || !part)
  ) {
    throw new Error("浏览器提交的相对路径无效。");
  }
  if (path.posix.basename(normalized) !== fileName) {
    throw new Error("浏览器提交的相对路径与文件名不一致。");
  }
  return normalized;
}

async function parseImportableContent(args: {
  relativePath: string;
  sourceContent: Buffer;
  mineruMode: MineruMode;
  mineruApiKey?: string | null;
}): Promise<{ markdown: string; assets: MineruAsset[]; sourceType: SourceType; mimeType: string }> {
  const sourceType = detectSourceType(args.relativePath);
  if (sourceType === "MD") {
    const rawMarkdown = args.sourceContent.toString("utf8");
    const parsed = matter(rawMarkdown);
    const content = parsed.content.trim();
    if (!content) {
      throw new Error("Markdown 正文为空。");
    }
    return { markdown: rawMarkdown, assets: [], sourceType: SourceType.MD, mimeType: "text/markdown" };
  }
  if (sourceType) {
    const parsed = await parseDocumentWithMineru(
      {
        fileName: path.basename(args.relativePath),
        content: args.sourceContent,
      },
      args.mineruMode,
      { mineruApiKey: args.mineruApiKey },
    );
    if (!parsed.markdown.trim()) {
      throw new Error("MinerU 解析后的 Markdown 为空。");
    }
    const sourceTypeMap = { PDF: SourceType.PDF, DOCX: SourceType.DOCX, PPTX: SourceType.PPTX, XLSX: SourceType.XLSX, IMAGE: SourceType.IMAGE } as const;
    return { markdown: parsed.markdown, assets: parsed.assets, sourceType: sourceTypeMap[sourceType], mimeType: detectMimeTypeFromFileName(args.relativePath) };
  }
  throw new Error("不支持的文件格式。");
}

type ImportCounters = {
  importedCount: number;
  unchangedCount: number;
  chunkCount: number;
  skippedCount: number;
  errors: string[];
};

async function processImportedEntry(
  knowledgeBaseId: string,
  runId: string,
  submittedRelativePath: string,
  sourceContent: Buffer,
  options: { mineruMode?: MineruMode; mineruApiKey?: string | null },
  counters: ImportCounters,
): Promise<void> {
  try {
    const relativePath = normalizeBrowserRelativePath(submittedRelativePath, path.basename(submittedRelativePath));
    if (!SUPPORTED_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      counters.skippedCount += 1;
      return;
    }
    const parsed = await parseImportableContent({
      relativePath,
      sourceContent,
      mineruMode: options.mineruMode ?? "light",
      mineruApiKey: options.mineruApiKey,
    });
    const result = await upsertImportedDocument({
      knowledgeBaseId,
      runId,
      canonicalPathOrUrl: `browser-directory/${relativePath}`,
      relativeSourcePath: relativePath,
      sourceKind: KnowledgeSourceKind.UPLOAD,
      importMode: ImportSourceMode.SNAPSHOT,
      syncStatus: "SNAPSHOT",
      sourceType: parsed.sourceType,
      sourceContent,
      sourceFileName: path.basename(relativePath),
      sourceMimeType: parsed.mimeType,
      markdown: parsed.markdown,
      assets: parsed.assets,
      createdBy: "browser-directory-upload",
      changeReasonCreate: "snapshot-import",
      changeReasonUpdate: "snapshot-update",
    });
    if (result.status === "imported") {
      counters.importedCount += 1;
      counters.chunkCount += result.chunkCount;
    } else if (result.status === "unchanged") {
      counters.unchangedCount += 1;
    }
  } catch (error) {
    counters.errors.push(`${submittedRelativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function importBrowserDirectorySnapshot(
  knowledgeBaseId: string,
  files: BrowserDirectorySnapshotFile[],
  options: { mineruMode?: MineruMode; mineruApiKey?: string | null } = {},
): Promise<DirectorySyncResult> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  if (knowledgeBase.syncRootPath) {
    throw new Error("浏览器目录上传只能导入快照知识库，不能写入已绑定同步目录的知识库。");
  }
  if (files.length === 0 || files.length > 200) {
    throw new Error("请选择 1 至 200 份文件。");
  }
  await ensureKnowledgeBaseDataDirectories(knowledgeBase.id);
  const run = await prisma.ingestRun.create({
    data: { knowledgeBaseId: knowledgeBase.id, source: "browser-directory-upload", priority: "SNAPSHOT", status: IngestRunStatus.RUNNING },
  });
  const counters: ImportCounters = { importedCount: 0, unchangedCount: 0, chunkCount: 0, skippedCount: 0, errors: [] };

  for (const { file, relativePath: submittedRelativePath } of files) {
    const sourceContent = Buffer.from(await file.arrayBuffer());
    await processImportedEntry(knowledgeBase.id, run.id, submittedRelativePath, sourceContent, options, counters);
  }

  const status = counters.errors.length === 0 ? IngestRunStatus.SUCCEEDED : counters.importedCount + counters.unchangedCount > 0 ? IngestRunStatus.PARTIAL : IngestRunStatus.FAILED;
  await prisma.ingestRun.update({ where: { id: run.id }, data: { status, importedCount: counters.importedCount, chunkCount: counters.chunkCount, errorText: counters.errors.length > 0 ? counters.errors.join("\n") : null, finishedAt: new Date() } });
  await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
  await recordCompletedTask(knowledgeBase.id, "INGEST", { runId: run.id, source: "browser-directory", importedCount: counters.importedCount, unchangedCount: counters.unchangedCount, skippedCount: counters.skippedCount, errorCount: counters.errors.length }, { autoTriggered: false });
  await enqueueAutoEvaluation(knowledgeBase.id, `浏览器目录导入完成（${counters.importedCount} 份新增）`);
  return { runId: run.id, importedCount: counters.importedCount, unchangedCount: counters.unchangedCount, missingCount: 0, conflictCount: 0, skippedCount: counters.skippedCount, errorCount: counters.errors.length, errors: counters.errors };
}

/** 后台任务用：从任务工作目录读取已落盘文件执行快照导入，按文件更新进度。 */
export async function importDirectorySnapshotFromDisk(
  knowledgeBaseId: string,
  entries: Array<{ relativePath: string; filePath: string }>,
  options: { mineruMode?: MineruMode; mineruApiKey?: string | null } = {},
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<DirectorySyncResult> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  if (entries.length === 0 || entries.length > 200) {
    throw new Error("请选择 1 至 200 份文件。");
  }
  const run = await prisma.ingestRun.create({
    data: { knowledgeBaseId: knowledgeBase.id, source: "browser-directory-upload", priority: "SNAPSHOT", status: IngestRunStatus.RUNNING },
  });
  const counters: ImportCounters = { importedCount: 0, unchangedCount: 0, chunkCount: 0, skippedCount: 0, errors: [] };

  for (const [index, entry] of entries.entries()) {
    try {
      const sourceContent = await readFile(entry.filePath);
      await processImportedEntry(knowledgeBase.id, run.id, entry.relativePath, sourceContent, options, counters);
    } catch (error) {
      counters.errors.push(`${entry.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (onProgress) {
      await onProgress(index + 1, entries.length);
    }
  }

  const status = counters.errors.length === 0 ? IngestRunStatus.SUCCEEDED : counters.importedCount + counters.unchangedCount > 0 ? IngestRunStatus.PARTIAL : IngestRunStatus.FAILED;
  await prisma.ingestRun.update({ where: { id: run.id }, data: { status, importedCount: counters.importedCount, chunkCount: counters.chunkCount, errorText: counters.errors.length > 0 ? counters.errors.join("\n") : null, finishedAt: new Date() } });
  await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
  await enqueueAutoEvaluation(knowledgeBase.id, `后台目录导入完成（${counters.importedCount} 份新增）`);
  return { runId: run.id, importedCount: counters.importedCount, unchangedCount: counters.unchangedCount, missingCount: 0, conflictCount: 0, skippedCount: counters.skippedCount, errorCount: counters.errors.length, errors: counters.errors };
}

export async function previewDirectoryScan(knowledgeBaseId: string): Promise<DirectoryScanItem[]> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  if (!knowledgeBase.syncRootPath) {
    throw new Error("当前知识库尚未绑定同步根目录。");
  }
  const rootPath = await realpath(knowledgeBase.syncRootPath);
  const items = await scanDirectory(rootPath, knowledgeBase.id);
  const sources = await prisma.knowledgeSource.findMany({
    where: { knowledgeBaseId: knowledgeBase.id, importMode: ImportSourceMode.SYNC },
    include: {
      documents: {
        take: 1,
        select: {
          id: true,
          content: true,
          updatedAt: true,
          currentVersion: { select: { managedObjectHash: true } },
        },
      },
    },
  });
  const sourceByPath = new Map(sources.map((source) => [source.canonicalPathOrUrl, source]));

  const enriched = await Promise.all(
    items.map(async (item) => {
      if (item.status !== "READY") {
        return item;
      }
      const source = sourceByPath.get(item.absolutePath);
      if (!source) {
        return item;
      }
      const document = source.documents[0];
      const sourceMetadata = {
        documentId: document?.id ?? null,
        documentContentHash: document ? hashContent(document.content) : null,
        documentUpdatedAt: document?.updatedAt ?? null,
        sourceFileHash: source.sourceFileHash,
        lastSeenAt: source.lastSeenAt,
      };
      if (source.syncStatus === "CONFLICT") {
        return { ...item, ...sourceMetadata, status: "CONFLICT" as const, contentHash: source.contentHash };
      }
      try {
        if (item.sourceType === "MD") {
          const raw = await readFile(item.absolutePath, "utf8");
          const sourceFileHash = hashContent(raw);
          if (source.sourceFileHash === sourceFileHash) {
            return { ...item, ...sourceMetadata, status: "SYNCED" as const, contentHash: source.contentHash };
          }
          const contentHash = hashContent(matter(normalizeMarkdownLineEndings(raw)).content.trim());
          if (source.contentHash && contentHash !== source.contentHash) {
            const knowledgeHash = document ? hashContent(document.content) : null;
            if (knowledgeHash && knowledgeHash !== source.contentHash) {
              return { ...item, ...sourceMetadata, status: "CONFLICT" as const, contentHash };
            }
            return { ...item, ...sourceMetadata, status: "CHANGED" as const, contentHash };
          }
          return { ...item, ...sourceMetadata, status: "SYNCED" as const, contentHash };
        }

        const sourceContent = await readFile(item.absolutePath);
        const sourceFileHash = hashContent(sourceContent);
        const trackedSourceHash = source.sourceFileHash ?? document?.currentVersion?.managedObjectHash ?? null;
        if (trackedSourceHash && sourceFileHash !== trackedSourceHash) {
          const knowledgeHash = document ? hashContent(document.content) : null;
          if (knowledgeHash && source.contentHash && knowledgeHash !== source.contentHash) {
            return { ...item, ...sourceMetadata, status: "CONFLICT" as const, contentHash: sourceFileHash };
          }
          return { ...item, ...sourceMetadata, status: "CHANGED" as const, contentHash: sourceFileHash };
        }
        return { ...item, ...sourceMetadata, status: "SYNCED" as const, contentHash: sourceFileHash };
      } catch {
        return { ...item, ...sourceMetadata, status: "READY" as const, contentHash: source.contentHash };
      }
    }),
  );

  const presentPaths = new Set(items.map((item) => item.absolutePath));
  for (const source of sources) {
    if (presentPaths.has(source.canonicalPathOrUrl)) {
      continue;
    }
    const relativePath = toPosixRelativePath(rootPath, source.canonicalPathOrUrl);
    enriched.push({
      relativePath: relativePath.startsWith("..") ? source.canonicalPathOrUrl : relativePath,
      absolutePath: source.canonicalPathOrUrl,
      status: "MISSING",
      matchedRule: null,
      matchedRuleSource: null,
      matchedRuleLine: null,
      matchedRuleInclude: null,
      sourceType: detectSourceType(source.canonicalPathOrUrl),
      documentId: source.documents[0]?.id ?? null,
      contentHash: source.contentHash,
      documentContentHash: source.documents[0] ? hashContent(source.documents[0].content) : null,
      documentUpdatedAt: source.documents[0]?.updatedAt ?? null,
      sourceFileHash: source.sourceFileHash,
      lastSeenAt: source.lastSeenAt,
      fileSize: null,
      lastModifiedAt: null,
    });
  }

  return enriched.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));
}

export async function syncDirectoryKnowledgeBase(knowledgeBaseId: string, options: DirectorySyncOptions = {}): Promise<DirectorySyncResult> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  if (!knowledgeBase.syncRootPath) {
    throw new Error("当前知识库尚未绑定同步根目录。");
  }
  if (knowledgeBase.id === "default") {
    throw new Error("默认收件箱不能作为同步知识库。");
  }

  await ensureKnowledgeBaseDataDirectories(knowledgeBase.id);
  const rootPath = await realpath(knowledgeBase.syncRootPath);
  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) {
    throw new Error("同步根目录不可用。");
  }

  const scanItems = await scanDirectory(rootPath, knowledgeBase.id);
  const selected = options.relativePaths?.length
    ? new Set(options.relativePaths.map((value) => value.replace(/\\/g, "/")))
    : null;
  const readyItems = scanItems.filter((item) => item.status === "READY" && (!selected || selected.has(item.relativePath)));
  if (selected) {
    const unknown = Array.from(selected).filter((relativePath) => !scanItems.some((item) => item.relativePath === relativePath && item.status === "READY"));
    if (unknown.length > 0) {
      throw new Error(`以下路径不可同步：${unknown.slice(0, 5).join("、")}${unknown.length > 5 ? "…" : ""}`);
    }
  }

  const run = await prisma.ingestRun.create({
    data: { knowledgeBaseId: knowledgeBase.id, source: "directory-sync", priority: "SYNC", status: IngestRunStatus.RUNNING },
  });

  let importedCount = 0;
  let unchangedCount = 0;
  let conflictCount = 0;
  let chunkCount = 0;
  const errors: string[] = [];
  const existingPaths = new Set(scanItems.filter((item) => item.status !== "OUTSIDE_ROOT").map((item) => item.absolutePath));
  const mineruMode = options.mineruMode ?? "light";

  for (const item of readyItems) {
    try {
      const sourceContent = await readFile(item.absolutePath);
      const existingSource = await prisma.knowledgeSource.findFirst({
        where: { knowledgeBaseId: knowledgeBase.id, canonicalPathOrUrl: item.absolutePath },
        include: {
          documents: {
            take: 1,
            select: {
              id: true,
              content: true,
              currentVersion: { select: { managedObjectHash: true, contentHash: true } },
            },
          },
        },
      });
      const existingDocument = existingSource?.documents[0];
      const sourceFileHash = hashContent(sourceContent);
      const trackedSourceFileHash = existingSource?.sourceFileHash ?? (item.sourceType !== "MD" ? existingDocument?.currentVersion?.managedObjectHash : null);

      if (trackedSourceFileHash === sourceFileHash && existingSource?.syncStatus !== "CONFLICT" && !options.forceOverwriteConflict) {
        await prisma.knowledgeSource.update({
          where: { id: existingSource!.id },
          data: { lastSeenAt: new Date(), syncStatus: "SYNCED", sourceFileHash },
        });
        unchangedCount += 1;
        continue;
      }

      if (
        item.sourceType !== "MD" &&
        existingDocument &&
        existingSource?.contentHash &&
        trackedSourceFileHash &&
        trackedSourceFileHash !== sourceFileHash &&
        hashContent(existingDocument.content) !== existingSource.contentHash &&
        !options.forceOverwriteConflict
      ) {
        await prisma.knowledgeSource.update({
          where: { id: existingSource.id },
          data: { lastSeenAt: new Date(), syncStatus: "CONFLICT" },
        });
        conflictCount += 1;
        errors.push(`${item.relativePath}: 源文件与知识库正文均已变更，需人工选择保留源 / 保留知识库 / 新建文档。`);
        continue;
      }

      const parsed = await parseImportableContent({
        relativePath: item.relativePath,
        sourceContent,
        mineruMode,
        mineruApiKey: options.mineruApiKey,
      });
      const result = await upsertImportedDocument({
        knowledgeBaseId: knowledgeBase.id,
        runId: run.id,
        canonicalPathOrUrl: item.absolutePath,
        relativeSourcePath: item.relativePath,
        sourceKind: KnowledgeSourceKind.DIRECTORY,
        importMode: ImportSourceMode.SYNC,
        syncStatus: "SYNCED",
        sourceType: parsed.sourceType,
        sourceContent,
        sourceFileName: path.basename(item.relativePath),
        sourceMimeType: parsed.mimeType,
        markdown: parsed.markdown,
        assets: parsed.assets,
        createdBy: "directory-sync",
        changeReasonCreate: "sync-import",
        changeReasonUpdate: "sync-update",
        forceOverwriteConflict: options.forceOverwriteConflict,
      });
      if (result.status === "imported") {
        importedCount += 1;
        chunkCount += result.chunkCount;
      } else if (result.status === "unchanged") {
        unchangedCount += 1;
      } else if (result.status === "conflict") {
        conflictCount += 1;
        errors.push(`${item.relativePath}: ${result.conflictReason}`);
      }
    } catch (error) {
      errors.push(`${item.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const synchronizedSources = await prisma.knowledgeSource.findMany({
    where: { knowledgeBaseId: knowledgeBase.id, importMode: ImportSourceMode.SYNC },
    select: { id: true, canonicalPathOrUrl: true, syncStatus: true },
  });
  const missingSources = synchronizedSources.filter((source) => !existingPaths.has(source.canonicalPathOrUrl) && source.syncStatus !== "CONFLICT");
  if (missingSources.length > 0) {
    await prisma.knowledgeSource.updateMany({ where: { id: { in: missingSources.map((source) => source.id) } }, data: { syncStatus: "MISSING" } });
  }

  const status = errors.length === 0 ? IngestRunStatus.SUCCEEDED : importedCount + unchangedCount > 0 ? IngestRunStatus.PARTIAL : IngestRunStatus.FAILED;
  await prisma.ingestRun.update({
    where: { id: run.id },
    data: {
      status,
      importedCount,
      chunkCount,
      errorText: errors.length > 0 ? errors.join("\n") : null,
      finishedAt: new Date(),
    },
  });

  await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
  await recordCompletedTask(knowledgeBase.id, "INGEST", { runId: run.id, source: "sync", importedCount, unchangedCount, conflictCount, errorCount: errors.length }, { autoTriggered: false });
  await enqueueAutoEvaluation(knowledgeBase.id, `目录同步完成（${importedCount} 份新增）`);

  return {
    runId: run.id,
    importedCount,
    unchangedCount,
    missingCount: missingSources.length,
    conflictCount,
    skippedCount: scanItems.length - readyItems.length,
    errorCount: errors.length,
    errors,
  };
}

export async function resolveSyncConflict(args: {
  knowledgeBaseId: string;
  relativePath: string;
  resolution: "keep-source" | "keep-knowledge" | "create-new";
  mineruMode?: MineruMode;
  mineruApiKey?: string | null;
}): Promise<DirectorySyncResult> {
  const knowledgeBase = await requireKnowledgeBase(args.knowledgeBaseId);
  if (!knowledgeBase.syncRootPath) {
    throw new Error("当前知识库尚未绑定同步根目录。");
  }
  const rootPath = await realpath(knowledgeBase.syncRootPath);
  const absolutePath = path.resolve(rootPath, args.relativePath.replace(/\//g, path.sep));
  const resolvedPath = await realpath(absolutePath);
  if (!isWithinRoot(resolvedPath, rootPath)) {
    throw new Error("冲突路径不在同步根目录内。");
  }

  if (args.resolution === "keep-knowledge") {
    const source = await prisma.knowledgeSource.findFirst({
      where: { knowledgeBaseId: knowledgeBase.id, canonicalPathOrUrl: resolvedPath },
      include: { documents: { take: 1 } },
    });
    if (!source?.documents[0]) {
      throw new Error("找不到对应知识库文档。");
    }
    await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: {
        contentHash: hashContent(source.documents[0].content),
        sourceFileHash: hashContent(await readFile(resolvedPath)),
        lastSeenAt: new Date(),
        syncStatus: "SYNCED",
      },
    });
    await prisma.auditLog.create({
      data: {
        knowledgeBaseId: knowledgeBase.id,
        action: "sync-conflict-keep-knowledge",
        targetType: "KnowledgeDocument",
        targetId: source.documents[0].id,
        afterData: JSON.stringify({ relativePath: args.relativePath }),
      },
    });
    return { runId: "manual-conflict-resolution", importedCount: 0, unchangedCount: 1, missingCount: 0, conflictCount: 0, skippedCount: 0, errorCount: 0, errors: [] };
  }

  if (args.resolution === "create-new") {
    const sourceContent = await readFile(resolvedPath);
    const parsed = await parseImportableContent({
      relativePath: args.relativePath,
      sourceContent,
      mineruMode: args.mineruMode ?? "light",
      mineruApiKey: args.mineruApiKey,
    });
    const run = await prisma.ingestRun.create({
      data: { knowledgeBaseId: knowledgeBase.id, source: "directory-sync-conflict-new", priority: "SYNC", status: IngestRunStatus.RUNNING },
    });
    const conflictedSource = await prisma.knowledgeSource.findFirst({
      where: { knowledgeBaseId: knowledgeBase.id, canonicalPathOrUrl: resolvedPath, importMode: ImportSourceMode.SYNC },
      include: { documents: { select: { id: true } } },
    });
    if (!conflictedSource || conflictedSource.documents.length === 0) {
      throw new Error("找不到需要解除同步的冲突来源。");
    }

    const snapshotSource = await prisma.$transaction(async (transaction) => {
      const snapshot = await transaction.knowledgeSource.create({
        data: {
          knowledgeBaseId: knowledgeBase.id,
          kind: conflictedSource.kind,
          importMode: ImportSourceMode.SNAPSHOT,
          canonicalPathOrUrl: `conflict-snapshot://${conflictedSource.id}`,
          contentHash: conflictedSource.contentHash,
          sourceFileHash: conflictedSource.sourceFileHash,
          lastSeenAt: new Date(),
          syncStatus: "SNAPSHOT",
        },
      });
      await transaction.knowledgeDocument.updateMany({
        where: { sourceId: conflictedSource.id },
        data: { sourceId: snapshot.id },
      });
      return snapshot;
    });

    let result;
    try {
      result = await upsertImportedDocument({
        knowledgeBaseId: knowledgeBase.id,
        runId: run.id,
        canonicalPathOrUrl: resolvedPath,
        relativeSourcePath: args.relativePath,
        sourceKind: KnowledgeSourceKind.DIRECTORY,
        importMode: ImportSourceMode.SYNC,
        syncStatus: "SYNCED",
        sourceType: parsed.sourceType,
        sourceContent,
        sourceFileName: path.basename(args.relativePath),
        sourceMimeType: parsed.mimeType,
        markdown: parsed.markdown,
        assets: parsed.assets,
        createdBy: "directory-sync",
        changeReasonCreate: "sync-conflict-new-document",
        changeReasonUpdate: "sync-conflict-new-document",
        slugSeed: `sync-conflict-${conflictedSource.id}-${Date.now()}`,
      });
    } catch (error) {
      await prisma.$transaction([
        prisma.knowledgeDocument.updateMany({ where: { sourceId: snapshotSource.id }, data: { sourceId: conflictedSource.id } }),
        prisma.knowledgeSource.delete({ where: { id: snapshotSource.id } }),
        prisma.knowledgeSource.update({ where: { id: conflictedSource.id }, data: { syncStatus: "CONFLICT" } }),
      ]);
      await prisma.ingestRun.update({
        where: { id: run.id },
        data: { status: IngestRunStatus.FAILED, errorText: error instanceof Error ? error.message : String(error), finishedAt: new Date() },
      });
      throw error;
    }
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        status: result.status === "imported" ? IngestRunStatus.SUCCEEDED : IngestRunStatus.PARTIAL,
        importedCount: result.status === "imported" ? 1 : 0,
        chunkCount: result.chunkCount,
        finishedAt: new Date(),
      },
    });
    await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
    return {
      runId: run.id,
      importedCount: result.status === "imported" ? 1 : 0,
      unchangedCount: 0,
      missingCount: 0,
      conflictCount: 0,
      skippedCount: 0,
      errorCount: 0,
      errors: [],
    };
  }

  return syncDirectoryKnowledgeBase(knowledgeBase.id, {
    relativePaths: [args.relativePath],
    mineruMode: args.mineruMode,
    mineruApiKey: args.mineruApiKey,
    forceOverwriteConflict: true,
  });
}

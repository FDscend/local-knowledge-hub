import { ImportSourceMode, IngestRunStatus, KnowledgeSourceKind, SourceType } from "@prisma/client";
import { DOMParser, parseHTML } from "linkedom";

import { clip, type Template } from "@/vendor/obsidian-clipper-cn/api.mjs";
import { upsertImportedDocument } from "@/lib/document-upsert";
import { rebuildKnowledgeBaseFtsIndex } from "@/lib/fts";
import { hashContent, requireKnowledgeBase } from "@/lib/knowledge-base";
import { persistKnowledgeAssets, rewriteMarkdownImageLinks } from "@/lib/knowledge-assets";
import type { MineruAsset } from "@/lib/mineru";
import { prisma } from "@/lib/prisma";
import { enqueueAutoEvaluation, recordCompletedTask } from "@/lib/tasks";

/** 剪藏 HTML 最大字节数（约 2MB）。 */
export const MAX_CLIPPING_HTML_CHARS = 2_000_000;
/** 剪藏来源 URL 最大长度。 */
export const MAX_CLIPPING_URL_LENGTH = 2000;

/** 内置默认剪藏模板：正文 + 常用 frontmatter 属性（对应上游 createDefaultTemplate 的最小化版本）。 */
const DEFAULT_CLIPPING_TEMPLATE: Template = {
  id: "builtin-clipping-default",
  name: "默认剪藏模板",
  behavior: "create",
  noteNameFormat: "{{title}}",
  path: "Clippings",
  noteContentFormat: "{{content}}",
  context: "",
  properties: [
    { id: "p1", name: "title", value: "{{title}}" },
    { id: "p2", name: "source", value: "{{url}}" },
    { id: "p3", name: "author", value: "{{author}}" },
    { id: "p4", name: "published", value: "{{published}}" },
    { id: "p5", name: "created", value: "{{date}}" },
    { id: "p6", name: "description", value: "{{description}}" },
    { id: "p7", name: "tags", value: "clippings" },
  ],
  triggers: [],
};

export type ClippedMarkdown = {
  /** 裁剪出的文件名 / 标题（已消毒）。 */
  noteName: string;
  /** frontmatter 文本（含尾部换行），与 content 拼接后即为完整 Markdown。 */
  frontmatter: string;
  /** 正文 Markdown（图片引用已按来源 URL 归一化为绝对地址）。 */
  content: string;
  /** frontmatter + content。 */
  markdown: string;
  properties: Array<{ name: string; value: string; type?: string }>;
};

// defuddle/full 的 Markdown 转换内部使用 turndown。turndown 的模块初始化会探测
// 浏览器环境，Node 下探测必然失败，运行时固定走 document.implementation.
// createHTMLDocument().open/write/close 分支；linkedom 不支持这些 API，
// 因此为注入的 document 补一个最小实现（累积 HTML，getElementById 时再解析）。
// 串行执行避免并发请求互相覆盖全局。
const { document: turndownDocument } = parseHTML("<!doctype html><html><body></body></html>");

function createWriteableDocument() {
  let accumulatedHtml = "";
  return {
    open(): void {
      accumulatedHtml = "";
    },
    write(html: string): void {
      accumulatedHtml += String(html);
    },
    close(): void {
      /* 无操作 */
    },
    getElementById(id: string): unknown {
      return parseHTML(accumulatedHtml).document.getElementById(id);
    },
  };
}

// 补丁：turndown 的 parseFromString 分支需要 createHTMLDocument。
(turndownDocument as unknown as { implementation: unknown }).implementation = {
  createHTMLDocument: () => createWriteableDocument(),
};

let turndownQueue: Promise<unknown> = Promise.resolve();

function withTurndownGlobals<T>(task: () => Promise<T>): Promise<T> {
  const run = turndownQueue.then(async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousDOMParser = globalThis.DOMParser;
    globalThis.window = globalThis as unknown as typeof globalThis.window;
    globalThis.document = turndownDocument as unknown as typeof globalThis.document;
    globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
    try {
      return await task();
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.DOMParser = previousDOMParser;
    }
  });
  turndownQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 将一段网页 HTML 裁剪为规范 Markdown（复用 obsidian-clipper-cn 固定核心）。
 * 纯转换，不落库；远程图片默认保留绝对 URL，不下载（文档 11.3 第 5 点）。
 */
export async function clipHtmlToMarkdown(args: { html: string; url: string; title?: string }): Promise<ClippedMarkdown> {
  const html = args.html.trim();
  if (!html) {
    throw new Error("剪藏 HTML 内容不能为空。");
  }
  if (html.length > MAX_CLIPPING_HTML_CHARS) {
    throw new Error(`剪藏 HTML 超过 ${MAX_CLIPPING_HTML_CHARS} 字符上限。`);
  }
  const url = args.url.trim();
  if (!url) {
    throw new Error("剪藏来源 URL 不能为空。");
  }
  if (url.length > MAX_CLIPPING_URL_LENGTH) {
    throw new Error("剪藏来源 URL 过长。");
  }

  const template: Template = {
    ...DEFAULT_CLIPPING_TEMPLATE,
    // 显式标题优先；否则回退到页面 <title>（{{title}} 变量）。
    noteNameFormat: args.title?.trim() || "{{title}}",
  };

  return withTurndownGlobals(async () => {
    const result = await clip({
      html,
      url,
      template,
      documentParser: {
        parseFromString: (source: string) => parseHTML(source).document,
      },
    });

    return {
      noteName: result.noteName,
      frontmatter: result.frontmatter,
      content: result.content,
      markdown: result.fullContent,
      properties: result.properties,
    };
  });
}

export type ImportWebClippingInput = {
  knowledgeBaseId: string;
  html: string;
  url: string;
  title?: string;
};

export type ImportWebClippingResult = {
  documentId: string;
  title: string;
  markdown: string;
  imported: boolean;
};

/** 剪藏类文档的统一落库入口：版本化文档 → 切片 → FTS 重建 → 审计与任务记录。 */
export async function importClippingDocument(args: {
  knowledgeBaseId: string;
  canonicalPathOrUrl: string;
  title: string;
  markdown: string;
  sourceContent: Buffer;
  sourceFileName: string;
  sourceMimeType: string;
  assets?: MineruAsset[];
  slugSeed?: string;
}): Promise<ImportWebClippingResult> {
  const knowledgeBase = await requireKnowledgeBase(args.knowledgeBaseId);
  if (knowledgeBase.syncRootPath) {
    throw new Error("已绑定同步目录的知识库不接受剪藏导入，请先创建或选择快照知识库。");
  }

  const run = await prisma.ingestRun.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      source: `clipping:${args.canonicalPathOrUrl}`,
      priority: "SNAPSHOT",
      status: IngestRunStatus.RUNNING,
    },
  });

  // 附件持久化与引用重写：标准重写（rewriteMarkdownImageLinks）不处理外部 URL，
  // 页面侧附件（飞书图片等）以 URL 引用，需补充改写为受管引用。
  let content = args.markdown;
  if (args.assets && args.assets.length > 0) {
    const persistedAssets = await persistKnowledgeAssets({
      knowledgeBaseId: knowledgeBase.id,
      assets: args.assets,
    });
    content = rewriteMarkdownImageLinks(args.markdown, persistedAssets.lookup);
    for (let index = 0; index < args.assets.length; index += 1) {
      const sourcePath = args.assets[index].sourcePath;
      if (/^https?:\/\//i.test(sourcePath)) {
        content = content.split(sourcePath).join(`knowledge-asset://${persistedAssets.assetIds[index]}`);
      }
    }
  }

  // upsertImportedDocument 内部负责版本、切片与 FTS 重建（附件已持久化，不再重复处理）。
  const result = await upsertImportedDocument({
    knowledgeBaseId: knowledgeBase.id,
    runId: run.id,
    canonicalPathOrUrl: args.canonicalPathOrUrl,
    relativeSourcePath: `clippings/${createSafeFileName(args.title)}.md`,
    sourceKind: KnowledgeSourceKind.WEB,
    importMode: ImportSourceMode.SNAPSHOT,
    syncStatus: "SNAPSHOT",
    sourceType: SourceType.CLIPPING,
    sourceContent: args.sourceContent,
    sourceFileName: args.sourceFileName,
    sourceMimeType: args.sourceMimeType,
    markdown: content,
    createdBy: "web-clipping",
    changeReasonCreate: "web-clipping",
    changeReasonUpdate: "web-clipping-update",
    slugSeed: args.slugSeed,
  });

  await prisma.ingestRun.update({
    where: { id: run.id },
    data: {
      status: IngestRunStatus.SUCCEEDED,
      importedCount: result.status === "imported" ? 1 : 0,
      chunkCount: result.chunkCount,
      finishedAt: new Date(),
    },
  });

  await rebuildKnowledgeBaseFtsIndex(knowledgeBase.id);
  await recordCompletedTask(
    knowledgeBase.id,
    "INGEST",
    {
      runId: run.id,
      source: "web-clipping",
      url: args.canonicalPathOrUrl.slice(0, 200),
      importedCount: result.status === "imported" ? 1 : 0,
      chunkCount: result.chunkCount,
      contentHash: hashContent(args.markdown),
    },
    { autoTriggered: false },
  );
  await enqueueAutoEvaluation(knowledgeBase.id, `网页剪藏导入完成（${args.title}）`);

  if (!result.documentId) {
    throw new Error("剪藏导入未返回文档 ID。");
  }
  return {
    documentId: result.documentId,
    title: args.title,
    markdown: args.markdown,
    imported: result.status === "imported",
  };
}

/**
 * 把网页剪藏 HTML 接入统一导入流水线：裁剪 → 版本化文档 → 切片 →
 * FTS 重建 → 审计与任务记录（文档 11.1.1 第 3 点）。
 */
export async function importWebClipping(input: ImportWebClippingInput): Promise<ImportWebClippingResult> {
  const clipped = await clipHtmlToMarkdown({ html: input.html, url: input.url, title: input.title });
  return importClippingDocument({
    knowledgeBaseId: input.knowledgeBaseId,
    canonicalPathOrUrl: input.url,
    title: clipped.noteName,
    markdown: clipped.markdown,
    sourceContent: Buffer.from(input.html, "utf8"),
    sourceFileName: `${createSafeFileName(clipped.noteName)}.html`,
    sourceMimeType: "text/html",
    slugSeed: clipped.noteName,
  });
}

function createSafeFileName(name: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|\r\n\t]/g, "-").replace(/\s+/g, " ").trim();
  return safe || "clipping";
}

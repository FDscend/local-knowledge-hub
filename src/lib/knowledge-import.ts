import path from "node:path";

import { IngestMode, SourceType } from "@prisma/client";
import matter from "gray-matter";

import { getMineruDocumentType, parseDocumentWithMineru, type MineruAsset, type MineruMode } from "@/lib/mineru";

type UploadedKnowledgeContent = {
  title: string;
  content: string;
  frontmatter: string | null;
  assets: MineruAsset[];
  sourcePath: string;
  sourceUrl: string | null;
  tagsText: string;
  ingestMode: IngestMode;
};

function normalizeTags(tagsText: string): string[] {
  return Array.from(
    new Set(
      tagsText
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function toTagText(tags: string[]): string {
  return normalizeTags(tags.join(", ")).join(", ");
}

function getBaseFileName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

function normalizeUploadSourcePath(fileName: string): string {
  return `upload/${fileName}`;
}

function extractHeadingTitle(content: string): string | null {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (match?.[2]) {
      return match[2].trim();
    }
  }

  return null;
}

export async function readUploadedKnowledgeContent(args: {
  file: File;
  sourceType: SourceType;
  fallbackTitle: string;
  fallbackTagsText: string;
  explicitSourceUrl: string | null;
  mineruMode: MineruMode;
  mineruApiKey?: string | null;
}): Promise<UploadedKnowledgeContent> {
  const { file, sourceType, fallbackTitle, fallbackTagsText, explicitSourceUrl, mineruMode, mineruApiKey } = args;

  const mineruSourceTypes: SourceType[] = [SourceType.PDF, SourceType.DOCX, SourceType.PPTX, SourceType.XLSX, SourceType.IMAGE];
  if (mineruSourceTypes.includes(sourceType)) {
    const detectedType = getMineruDocumentType(file.name);
    if (detectedType !== sourceType) {
      throw new Error("所选来源类型与文件扩展名不一致，请重新选择文件。 ");
    }
    const parsed = await parseDocumentWithMineru(file, mineruMode, {
      mineruApiKey,
    });
    return {
      title: fallbackTitle.trim() || getBaseFileName(file.name),
      content: parsed.markdown,
      frontmatter: null,
      assets: parsed.assets,
      sourcePath: normalizeUploadSourcePath(file.name),
      sourceUrl: explicitSourceUrl,
      tagsText: toTagText([fallbackTagsText]),
      ingestMode: IngestMode.HEADING_CHUNKS,
    };
  }

  const rawText = Buffer.from(await file.arrayBuffer()).toString("utf8");
  const parsed = matter(rawText);
  const frontmatterTitle = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
  const frontmatterSourceUrl = typeof parsed.data.source === "string" ? parsed.data.source.trim() : "";
  const frontmatterTags = Array.isArray(parsed.data.tags)
    ? parsed.data.tags.map((tag) => String(tag))
    : typeof parsed.data.tags === "string"
      ? parsed.data.tags.split(/[\n,]/)
      : [];
  const frontmatterData = Object.keys(parsed.data).length > 0 ? JSON.stringify(parsed.data) : null;
  const body = parsed.content.replace(/\r\n/g, "\n").trim();

  if (!body) {
    throw new Error("上传的 Markdown 文件正文为空，请检查文件内容。");
  }

  return {
    title: fallbackTitle.trim() || frontmatterTitle || extractHeadingTitle(body) || getBaseFileName(file.name),
    content: body,
    frontmatter: frontmatterData,
    assets: [],
    sourcePath: normalizeUploadSourcePath(file.name),
    sourceUrl: explicitSourceUrl || frontmatterSourceUrl || null,
    tagsText: toTagText([...normalizeTags(fallbackTagsText), ...frontmatterTags.map((tag) => tag.trim())]),
    ingestMode: IngestMode.HEADING_CHUNKS,
  };
}
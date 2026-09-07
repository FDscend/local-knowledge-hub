import { IngestMode } from "@prisma/client";

type ChunkDraft = {
  heading: string | null;
  sectionPath: string;
  content: string;
  tokenEstimate: number;
};

function estimateTokens(input: string): number {
  return Math.max(1, Math.ceil(input.length / 4));
}

function excerpt(input: string, maxLength = 180): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength).trim()}...`;
}

function splitLongMarkdown(content: string, maxLength: number): string[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length <= 1 && content.length <= maxLength) {
    return [content.trim()];
  }

  const chunks: string[] = [];
  let buffer = "";

  for (const paragraph of paragraphs) {
    const nextValue = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (buffer && nextValue.length > maxLength) {
      chunks.push(buffer.trim());
      buffer = paragraph;
      continue;
    }
    buffer = nextValue;
  }

  if (buffer.trim()) {
    chunks.push(buffer.trim());
  }

  return chunks;
}

export function chunkMarkdown(markdown: string, mode: IngestMode, title: string): ChunkDraft[] {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();

  if (!normalized) {
    return [];
  }

  const maxLength = mode === IngestMode.SMALL_NOTE ? 700 : 1400;
  const lines = normalized.split("\n");
  const chunks: ChunkDraft[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  let currentLines: string[] = [];
  let currentHeading: string | null = null;
  let currentSectionPath = `${title} > 概览`;
  let hasMeaningfulContent = false;

  const flush = () => {
    const rawContent = currentLines.join("\n").trim();
    if (!rawContent) {
      currentLines = [];
      return;
    }

    const pieces = splitLongMarkdown(rawContent, maxLength);
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex];
      if (!piece.trim()) {
        continue;
      }

      chunks.push({
        heading: currentHeading,
        sectionPath: pieces.length > 1 ? `${currentSectionPath} / part ${pieceIndex + 1}` : currentSectionPath,
        content: piece,
        tokenEstimate: estimateTokens(piece),
      });
    }

    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());

    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }

      headingStack.push({ level, text });
      currentHeading = text;
      currentSectionPath = [title, ...headingStack.map((item) => item.text)].join(" > ");
      currentLines = [line];
      hasMeaningfulContent = true;
      continue;
    }

    if (!hasMeaningfulContent && line.trim()) {
      hasMeaningfulContent = true;
      currentHeading = "概览";
      currentSectionPath = `${title} > 概览`;
    }

    currentLines.push(line);
  }

  flush();

  if (chunks.length === 0) {
    return [
      {
        heading: "全文",
        sectionPath: `${title} > 全文`,
        content: normalized,
        tokenEstimate: estimateTokens(normalized),
      },
    ];
  }

  return chunks;
}

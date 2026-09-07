import { DocumentStatus, SourceType } from "@prisma/client";

export const statusLabels: Record<DocumentStatus, string> = {
  ACTIVE: "启用中",
  DRAFT: "草稿",
  DISABLED: "已停用",
};

export const sourceTypeLabels: Record<SourceType, string> = {
  MD: "Markdown",
  CLIPPING: "Clipping",
  PDF: "PDF",
  DOCX: "Word（DOCX）",
  PPTX: "PowerPoint（PPTX）",
  XLSX: "Excel（XLSX）",
  IMAGE: "图片",
  MANUAL: "手动录入",
};

export function splitTags(tagsText: string): string[] {
  return tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

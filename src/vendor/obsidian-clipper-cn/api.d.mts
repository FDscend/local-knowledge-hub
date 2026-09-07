/**
 * obsidian-clipper-cn 固定裁剪核心的类型声明（对应 api.mjs 产物）。
 * 仅声明本项目使用到的 API 子集；完整类型见上游 src/types/types.ts。
 */
export interface Property {
  id?: string;
  name: string;
  value: string;
  type?: string;
}

export interface Template {
  id: string;
  name: string;
  behavior:
    | "create"
    | "append-specific"
    | "append-daily"
    | "prepend-specific"
    | "prepend-daily"
    | "overwrite";
  noteNameFormat: string;
  path: string;
  noteContentFormat: string;
  properties: Property[];
  triggers?: string[];
  vault?: string;
  context?: string;
}

export interface DocumentParser {
  parseFromString(html: string, mimeType: string): unknown;
}

export interface ClipOptions {
  html: string;
  url: string;
  template: Template;
  documentParser: DocumentParser;
  propertyTypes?: Record<string, string>;
  parsedDocument?: unknown;
}

export interface ClipResult {
  noteName: string;
  frontmatter: string;
  content: string;
  fullContent: string;
  properties: Property[];
  variables: Record<string, string>;
}

export declare function clip(options: ClipOptions): Promise<ClipResult>;
export declare function matchTemplate(templates: Template[], url: string, schemaOrgData?: unknown): Template | undefined;

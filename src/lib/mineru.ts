import path from "node:path";

import JSZip from "jszip";

import { getMineruApiKey } from "@/lib/runtime-config";

export type MineruMode = "light" | "precise";

export type MineruDocumentType = "PDF" | "DOCX" | "PPTX" | "XLSX" | "IMAGE";

export type MineruAsset = {
  sourcePath: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
};

export type MineruParseResult = {
  markdown: string;
  assets: MineruAsset[];
};

type MineruEnvelope<T> = {
  code: number;
  msg: string;
  data: T;
  trace_id?: string;
};

type LightCreateResponse = {
  task_id: string;
  file_url: string;
};

type LightResultResponse = {
  task_id: string;
  state: "waiting-file" | "uploading" | "pending" | "running" | "done" | "failed";
  markdown_url?: string;
  err_msg?: string;
};

type PreciseCreateResponse = {
  batch_id: string;
  file_urls: string[];
};

type PreciseExtractResult = {
  file_name: string;
  state: "waiting-file" | "pending" | "running" | "done" | "failed" | "converting";
  err_msg?: string;
  full_zip_url?: string;
};

type PreciseResultResponse = {
  batch_id: string;
  extract_result: PreciseExtractResult[];
};

const LIGHT_BASE_URL = "https://mineru.net/api/v1/agent";
const PRECISE_BASE_URL = "https://mineru.net/api/v4";
const LIGHT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const MINERU_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp"]);

export function getMineruDocumentType(fileName: string): MineruDocumentType | null {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".pdf") {
    return "PDF";
  }
  if (extension === ".docx") {
    return "DOCX";
  }
  if (extension === ".pptx") {
    return "PPTX";
  }
  if (extension === ".xlsx") {
    return "XLSX";
  }
  if (MINERU_IMAGE_EXTENSIONS.has(extension)) {
    return "IMAGE";
  }
  return null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function readJsonResponse<T>(response: Response): Promise<MineruEnvelope<T>> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(text || `MinerU 请求失败，HTTP ${response.status}`);
  }

  const payload = (await response.json()) as MineruEnvelope<T>;
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || `MinerU 请求失败，HTTP ${response.status}`);
  }

  return payload;
}

async function uploadFileToSignedUrl(file: File, uploadUrl: string): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: await file.arrayBuffer(),
  });

  if (!response.ok) {
    throw new Error(`上传文件到 MinerU 失败，HTTP ${response.status}`);
  }
}

async function downloadMarkdownFromUrl(markdownUrl: string): Promise<string> {
  const response = await fetch(markdownUrl, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`获取 MinerU Markdown 结果失败，HTTP ${response.status}`);
  }

  const markdown = await response.text();
  return markdown.replace(/\r\n/g, "\n").trim();
}

export function detectMimeTypeFromFileName(fileName: string): string {
  const normalized = fileName.toLowerCase();

  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }
  if (normalized.endsWith(".gif")) {
    return "image/gif";
  }
  if (normalized.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (normalized.endsWith(".bmp")) {
    return "image/bmp";
  }
  if (normalized.endsWith(".jp2")) {
    return "image/jp2";
  }
  if (normalized.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (normalized.endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (normalized.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (normalized.endsWith(".pdf")) {
    return "application/pdf";
  }

  return "application/octet-stream";
}

function isImageEntry(entryName: string): boolean {
  const normalized = entryName.toLowerCase();
  return [".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp", ".svg"].some((ext) => normalized.endsWith(ext));
}

async function downloadMarkdownFromZip(zipUrl: string): Promise<MineruParseResult> {
  const response = await fetch(zipUrl, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`获取 MinerU ZIP 结果失败，HTTP ${response.status}`);
  }

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const fullMarkdownEntry = Object.values(zip.files).find((entry) => !entry.dir && entry.name.endsWith("full.md"));

  if (!fullMarkdownEntry) {
    throw new Error("MinerU 精准版结果中缺少 full.md。");
  }

  const markdown = await fullMarkdownEntry.async("string");
  const assets: MineruAsset[] = [];

  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !isImageEntry(entry.name)) {
      continue;
    }

    const data = Buffer.from(await entry.async("uint8array"));
    assets.push({
      sourcePath: entry.name,
      fileName: entry.name.split("/").pop() || "asset",
      mimeType: detectMimeTypeFromFileName(entry.name),
      data,
    });
  }

  return {
    markdown: markdown.replace(/\r\n/g, "\n").trim(),
    assets,
  };
}

async function pollLightweightResult(taskId: string): Promise<MineruParseResult> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(`${LIGHT_BASE_URL}/parse/${taskId}`, {
      cache: "no-store",
    });
    const payload = await readJsonResponse<LightResultResponse>(response);
    const state = payload.data.state;

    if (state === "done" && payload.data.markdown_url) {
      const markdown = await downloadMarkdownFromUrl(payload.data.markdown_url);
      return {
        markdown,
        assets: [],
      };
    }

    if (state === "failed") {
      throw new Error(payload.data.err_msg || "MinerU 轻量解析失败，请稍后重试。");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("MinerU 轻量解析超时，请稍后重试。");
}

async function pollPreciseResult(batchId: string, fileName: string, apiKey: string): Promise<MineruParseResult> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(`${PRECISE_BASE_URL}/extract-results/batch/${batchId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      cache: "no-store",
    });
    const payload = await readJsonResponse<PreciseResultResponse>(response);
    const result = payload.data.extract_result.find((item) => item.file_name === fileName) ?? payload.data.extract_result[0];

    if (!result) {
      throw new Error("MinerU 精准解析未返回结果条目。");
    }

    if (result.state === "done" && result.full_zip_url) {
      return downloadMarkdownFromZip(result.full_zip_url);
    }

    if (result.state === "failed") {
      throw new Error(result.err_msg || "MinerU 精准解析失败，请稍后重试。");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("MinerU 精准解析超时，请稍后重试。");
}

async function parseDocumentWithLightweightMineru(file: File): Promise<MineruParseResult> {
  if (file.size > LIGHT_MAX_FILE_SIZE_BYTES) {
    throw new Error("轻量 MinerU 仅支持 10MB 以内的单个文件，请改用精准模式或压缩文件后重试。");
  }

  const documentType = getMineruDocumentType(file.name);
  if (!documentType) {
    throw new Error("当前文件格式不受 MinerU 支持。请上传 PDF、DOCX、PPTX、XLSX 或图片文件。");
  }

  const requestBody: Record<string, boolean | string> = { file_name: file.name };
  if (documentType === "PDF") {
    requestBody.language = "ch";
    requestBody.enable_table = true;
    requestBody.enable_formula = true;
    requestBody.is_ocr = false;
  }

  const createResponse = await fetch(`${LIGHT_BASE_URL}/parse/file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const createPayload = await readJsonResponse<LightCreateResponse>(createResponse);

  await uploadFileToSignedUrl(file, createPayload.data.file_url);
  return pollLightweightResult(createPayload.data.task_id);
}

async function parseDocumentWithPreciseMineru(file: File, apiKeyOverride?: string | null): Promise<MineruParseResult> {
  const apiKey = getMineruApiKey(apiKeyOverride);
  if (!apiKey) {
    throw new Error("精准 MinerU 需要先在页面右上角 API 设置里补充 MinerU API Key。");
  }
  if (file.size > 200 * 1024 * 1024) {
    throw new Error("精准 MinerU 仅支持 200MB 以内的单个文件。");
  }
  if (!getMineruDocumentType(file.name)) {
    throw new Error("当前文件格式不受 MinerU 支持。请上传 PDF、DOCX、PPTX、XLSX 或图片文件。");
  }

  const createResponse = await fetch(`${PRECISE_BASE_URL}/file-urls/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: [
        {
          name: file.name,
          data_id: crypto.randomUUID(),
        },
      ],
      model_version: "vlm",
      language: "ch",
      enable_table: true,
      enable_formula: true,
    }),
  });
  const createPayload = await readJsonResponse<PreciseCreateResponse>(createResponse);
  const uploadUrl = createPayload.data.file_urls[0];

  if (!uploadUrl) {
    throw new Error("MinerU 精准解析未返回上传地址。");
  }

  await uploadFileToSignedUrl(file, uploadUrl);
  return pollPreciseResult(createPayload.data.batch_id, file.name, apiKey);
}

type ParsePdfWithMineruOptions = {
  mineruApiKey?: string | null;
};

export type MineruDocumentInput = File | {
  fileName: string;
  content: Buffer;
  mimeType?: string | null;
};

function toMineruFile(input: MineruDocumentInput): File {
  if (input instanceof File) {
    return input;
  }
  const fileName = path.basename(input.fileName);
  if (!getMineruDocumentType(fileName)) {
    throw new Error("当前文件格式不受 MinerU 支持。请上传 PDF、DOCX、PPTX、XLSX 或图片文件。");
  }
  const bytes = Uint8Array.from(input.content);
  return new File([bytes], fileName, { type: input.mimeType || detectMimeTypeFromFileName(fileName) });
}

export async function parseDocumentWithMineru(input: MineruDocumentInput, mode: MineruMode, options: ParsePdfWithMineruOptions = {}): Promise<MineruParseResult> {
  const file = toMineruFile(input);
  if (!getMineruDocumentType(file.name)) {
    throw new Error("当前文件格式不受 MinerU 支持。请上传 PDF、DOCX、PPTX 或图片文件。");
  }

  return mode === "precise" ? parseDocumentWithPreciseMineru(file, options.mineruApiKey) : parseDocumentWithLightweightMineru(file);
}
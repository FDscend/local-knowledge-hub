import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ManagedObjectKind } from "@prisma/client";

import { getManagedObjectPath } from "@/lib/data-directory";
import type { MineruAsset } from "@/lib/mineru";
import { prisma } from "@/lib/prisma";

function normalizeAssetPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").trim();
  const withoutPrefix = normalized.replace(/^\.\//, "").replace(/^\/+/, "");

  const segments = withoutPrefix
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  if (segments.length === 0) {
    return "asset";
  }

  const joined = segments.join("/");

  try {
    return decodeURIComponent(joined);
  } catch {
    return joined;
  }
}

function splitUrlPath(rawUrl: string): { pathname: string; suffix: string } {
  const hashIndex = rawUrl.indexOf("#");
  const queryIndex = rawUrl.indexOf("?");
  const splitIndex = [queryIndex, hashIndex].filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? -1;

  if (splitIndex < 0) {
    return {
      pathname: rawUrl,
      suffix: "",
    };
  }

  return {
    pathname: rawUrl.slice(0, splitIndex),
    suffix: rawUrl.slice(splitIndex),
  };
}

function isExternalOrDataUrl(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("data:") || lower.startsWith("//");
}

function tryResolveAssetUrl(rawUrl: string, lookup: Record<string, string>): string | null {
  if (isExternalOrDataUrl(rawUrl)) {
    return null;
  }

  const { pathname, suffix } = splitUrlPath(rawUrl);
  const normalized = normalizeAssetPath(pathname);
  const basename = path.posix.basename(normalized);
  const candidates = [normalized, basename];

  for (const candidate of candidates) {
    const resolved = lookup[candidate];
    if (resolved) {
      return `${resolved}${suffix}`;
    }
  }

  return null;
}

function splitMarkdownDestination(destination: string): { rawUrl: string; rest: string } {
  const trimmed = destination.trim();
  if (!trimmed) {
    return {
      rawUrl: "",
      rest: "",
    };
  }

  if (trimmed.startsWith("<")) {
    const closeIndex = trimmed.indexOf(">", 1);
    if (closeIndex < 0) {
      return {
        rawUrl: trimmed,
        rest: "",
      };
    }

    return {
      rawUrl: trimmed.slice(1, closeIndex).trim(),
      rest: trimmed.slice(closeIndex + 1),
    };
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return {
      rawUrl: trimmed.slice(1, -1).trim(),
      rest: "",
    };
  }

  const firstSpace = trimmed.search(/\s/);
  if (firstSpace < 0) {
    return {
      rawUrl: trimmed,
      rest: "",
    };
  }

  return {
    rawUrl: trimmed.slice(0, firstSpace),
    rest: trimmed.slice(firstSpace),
  };
}

export async function persistKnowledgeAssets(args: {
  knowledgeBaseId: string;
  assets: MineruAsset[];
}): Promise<{ lookup: Record<string, string>; assetIds: string[] }> {
  const { assets, knowledgeBaseId } = args;
  if (assets.length === 0) {
    return { lookup: {}, assetIds: [] };
  }

  const lookup: Record<string, string> = {};
  const assetIds: string[] = [];

  for (const asset of assets) {
    const normalizedSourcePath = normalizeAssetPath(asset.sourcePath || asset.fileName);
    const originalName = path.posix.basename(normalizedSourcePath);
    const sha256 = createHash("sha256").update(asset.data).digest("hex");
    const storagePath = getManagedObjectPath(knowledgeBaseId, sha256, "assets", originalName);

    await mkdir(path.dirname(storagePath), { recursive: true });
    await writeFile(storagePath, asset.data);

    const managedObject = await prisma.managedObject.upsert({
      where: { knowledgeBaseId_sha256: { knowledgeBaseId, sha256 } },
      update: { storagePath, mimeType: asset.mimeType || null, size: asset.data.byteLength },
      create: {
        knowledgeBaseId,
        sha256,
        kind: ManagedObjectKind.ASSET,
        storagePath,
        mimeType: asset.mimeType || null,
        size: asset.data.byteLength,
      },
    });
    const existingAsset = await prisma.managedAsset.findFirst({
      where: { knowledgeBaseId, objectId: managedObject.id, originalPath: normalizedSourcePath },
    });
    const managedAsset = existingAsset ?? await prisma.managedAsset.create({
      data: {
        knowledgeBaseId,
        objectId: managedObject.id,
        originalName,
        originalPath: normalizedSourcePath,
      },
    });
    assetIds.push(managedAsset.id);

    const internalUrl = `knowledge-asset://${managedAsset.id}`;
    lookup[normalizedSourcePath] = internalUrl;

    const baseName = originalName;
    if (!lookup[baseName]) {
      lookup[baseName] = internalUrl;
    }
  }

  return { lookup, assetIds };
}

function mapMarkdownAssetUrls(content: string, resolveUrl: (rawUrl: string) => string | null): string {
  if (!content) {
    return content;
  }

  const rewrittenMarkdownImages = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (fullMatch, altText: string, destination: string) => {
    const { rawUrl, rest } = splitMarkdownDestination(destination);
    if (!rawUrl) {
      return fullMatch;
    }

    const nextUrl = resolveUrl(rawUrl);
    if (!nextUrl) {
      return fullMatch;
    }

    return `![${altText}](${nextUrl}${rest})`;
  });

  const rewrittenReferenceDefinitions = rewrittenMarkdownImages.replace(/(^|\n)\s*\[([^\]]+)\]:\s*(.+)(?=\n|$)/g, (fullMatch, lineStart: string, refId: string, destination: string) => {
    const { rawUrl, rest } = splitMarkdownDestination(destination);
    if (!rawUrl) {
      return fullMatch;
    }

    const nextUrl = resolveUrl(rawUrl);
    if (!nextUrl) {
      return fullMatch;
    }

    return `${lineStart}[${refId}]: ${nextUrl}${rest}`;
  });

  return rewrittenReferenceDefinitions.replace(/<img\b([^>]*?)\bsrc=("|')([^"']+)(\2)([^>]*)>/gi, (fullMatch, beforeSrc: string, quote: string, srcValue: string, _sameQuote: string, afterSrc: string) => {
    const nextUrl = resolveUrl(srcValue);
    if (!nextUrl) {
      return fullMatch;
    }

    return `<img${beforeSrc}src=${quote}${nextUrl}${quote}${afterSrc}>`;
  });
}

export function rewriteMarkdownImageLinks(content: string, lookup: Record<string, string>): string {
  if (!content || Object.keys(lookup).length === 0) {
    return content;
  }

  return mapMarkdownAssetUrls(content, (rawUrl) => tryResolveAssetUrl(rawUrl, lookup));
}

export function collectKnowledgeAssetIds(content: string): string[] {
  if (!content) {
    return [];
  }

  const ids = new Set<string>();
  for (const match of content.matchAll(/knowledge-asset:\/\/([a-zA-Z0-9_-]{1,64})/gi)) {
    if (match[1]) {
      ids.add(match[1]);
    }
  }

  return Array.from(ids);
}

export function rewriteKnowledgeAssetLinks(content: string, lookup: Record<string, string>): string {
  if (!content || Object.keys(lookup).length === 0) {
    return content;
  }

  return mapMarkdownAssetUrls(content, (rawUrl) => {
    const match = /^knowledge-asset:\/\/([a-zA-Z0-9_-]{1,64})(.*)$/i.exec(rawUrl.trim());
    if (!match) {
      return null;
    }
    const nextPath = lookup[match[1]];
    return nextPath ? `${nextPath}${match[2] || ""}` : null;
  });
}

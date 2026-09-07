export function createStableSlug(input: string): string {
  const ascii = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (ascii) {
    return ascii;
  }

  const unicodeHex = Array.from(input.trim())
    .map((char) => char.codePointAt(0)?.toString(16) ?? "")
    .filter(Boolean)
    .join("-")
    .slice(0, 72);

  return unicodeHex || "entry";
}

export function createImportedSlug(importId: string, title: string): string {
  return importId ? importId.toLowerCase() : createStableSlug(title);
}

export function createManualSlug(title: string): string {
  return `manual-${createStableSlug(title)}-${Date.now().toString(36)}`;
}

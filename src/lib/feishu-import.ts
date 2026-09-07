import { importClippingDocument } from "@/lib/clipping";
import type { MineruAsset } from "@/lib/mineru";

export type ImportFeishuClippingInput = {
  knowledgeBaseId: string;
  /** 飞书文档标题。 */
  title: string;
  /** 页面侧转换出的 Markdown。 */
  markdown: string;
  /** 页面侧转换出的附件字节（图片 / 文件）。 */
  assets: MineruAsset[];
  /** 可选来源标识，例如飞书文档 URL；缺省时用 feishu: 前缀。 */
  sourceUrl?: string;
};

export type ImportFeishuClippingResult = {
  documentId: string;
  title: string;
  markdown: string;
  imported: boolean;
};

/**
 * 把飞书页面侧转换结果接入统一剪藏导入流水线。
 * 附件字节在用户当前授权页面中取得后交到这里保存为受管对象（而非短期 URL）。
 */
export async function importFeishuClipping(input: ImportFeishuClippingInput): Promise<ImportFeishuClippingResult> {
  const canonicalPathOrUrl = input.sourceUrl?.trim() || `feishu:${input.title}`;
  return importClippingDocument({
    knowledgeBaseId: input.knowledgeBaseId,
    canonicalPathOrUrl,
    title: input.title,
    markdown: input.markdown,
    sourceContent: Buffer.from(input.markdown, "utf8"),
    sourceFileName: "feishu-docx.md",
    sourceMimeType: "text/markdown",
    assets: input.assets,
    slugSeed: input.title,
  });
}

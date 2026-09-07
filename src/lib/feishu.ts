/**
 * 飞书 Doc / Docx 转换适配层（文档 11.1.1 第 3、6 点）。
 *
 * 仅允许在“用户已登录且已获页面访问许可的飞书文档页面主上下文”中运行：
 * lark 核心（src/vendor-build/cloud-document-converter/lark）直接读取
 * window.PageMain / window.User，因此本模块不得从 Next.js 服务端 import，
 * 只可被未来网页剪藏扩展 / Electron 剪藏窗口的页面侧脚本引用。
 *
 * 复用范围：packages/lark 的 Doc / Docx → Markdown AST 与附件提取逻辑，
 * 输出统一为 { title, markdown, assets[] }；不含扩展菜单、下载 / 剪贴板、
 * 浏览器存储或任意文件保存代码。
 */
import { docx } from "@/vendor-build/cloud-document-converter/lark/src/docx";
import { Docx } from "@/vendor-build/cloud-document-converter/lark/src/docx";

import type { MineruAsset } from "@/lib/mineru";

export type FeishuClippingResult = {
  title: string;
  markdown: string;
  /** 转换出的附件字节（图片 / 文件），sourcePath 与 markdown 中的引用对应。 */
  assets: MineruAsset[];
};

async function blobToBuffer(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

/**
 * 在当前飞书文档页面执行转换。调用前必须确认：
 * - 页面为已登录、已授权的飞书 Doc / Docx 文档；
 * - 页面主上下文已就绪（window.PageMain 可访问）。
 * 转换不读取、上传或持久化 Cookie、CSRF token、Authorization、localStorage。
 */
export async function convertFeishuDocument(): Promise<FeishuClippingResult> {
  if (!docx.isReady()) {
    throw new Error("飞书文档尚未加载完成，请稍后重试。");
  }

  const { root, images, files } = docx.intoMarkdownAST();
  const markdown = Docx.stringify(root);
  if (!markdown.trim()) {
    throw new Error("未能从飞书文档提取到正文内容。");
  }

  const assets: MineruAsset[] = [];
  for (const image of images) {
    const blob = await image.data?.fetchBlob?.().catch(() => null);
    if (!blob || blob.size === 0) {
      continue;
    }
    assets.push({
      sourcePath: image.url,
      fileName: image.data?.name ?? "image.png",
      mimeType: blob.type || "image/png",
      data: await blobToBuffer(blob),
    });
  }
  for (const file of files) {
    const response = await file.data?.fetchFile?.().catch(() => null);
    if (!response || !response.ok) {
      continue;
    }
    const blob = await response.blob();
    assets.push({
      sourcePath: file.url,
      fileName: file.data?.name ?? "attachment",
      mimeType: blob.type || "application/octet-stream",
      data: await blobToBuffer(blob),
    });
  }

  return {
    title: docx.pageTitle ?? "飞书文档",
    markdown,
    assets,
  };
}

import { NextResponse } from "next/server";

import { clipHtmlToMarkdown, importClippingDocument } from "@/lib/clipping";
import { fetchWebPageHtml } from "@/lib/web-fetch";

/** 输入 URL 自动抓取并剪藏：SSRF 防护 → 受限抓取 → 裁剪核心 → 统一导入流水线。 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      knowledgeBaseId?: string;
      url?: string;
      title?: string;
    };
    if (!body.knowledgeBaseId) {
      return NextResponse.json({ error: "缺少 knowledgeBaseId。" }, { status: 400 });
    }
    if (typeof body.url !== "string" || !body.url.trim()) {
      return NextResponse.json({ error: "缺少抓取 URL。" }, { status: 400 });
    }

    const fetched = await fetchWebPageHtml(body.url);
    const clipped = await clipHtmlToMarkdown({
      html: fetched.html,
      url: fetched.finalUrl,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    const result = await importClippingDocument({
      knowledgeBaseId: body.knowledgeBaseId,
      canonicalPathOrUrl: fetched.finalUrl,
      title: clipped.noteName,
      markdown: clipped.markdown,
      sourceContent: Buffer.from(fetched.html, "utf8"),
      sourceFileName: "web-page.html",
      sourceMimeType: "text/html",
      slugSeed: clipped.noteName,
    });

    return NextResponse.json({
      ...result,
      fetched: {
        finalUrl: fetched.finalUrl,
        redirectCount: fetched.redirectCount,
        fetchedAt: fetched.fetchedAt,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "网页抓取失败。",
      },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";

import { importWebClipping } from "@/lib/clipping";

/** 网页剪藏入口：接收 HTML + 来源 URL，经固定裁剪核心转 Markdown 后接入统一导入流水线。 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      knowledgeBaseId?: string;
      html?: string;
      url?: string;
      title?: string;
    };
    if (!body.knowledgeBaseId) {
      return NextResponse.json({ error: "缺少 knowledgeBaseId。" }, { status: 400 });
    }
    if (typeof body.html !== "string" || !body.html.trim()) {
      return NextResponse.json({ error: "缺少剪藏 HTML 内容。" }, { status: 400 });
    }
    if (typeof body.url !== "string" || !body.url.trim()) {
      return NextResponse.json({ error: "缺少剪藏来源 URL。" }, { status: 400 });
    }

    const result = await importWebClipping({
      knowledgeBaseId: body.knowledgeBaseId,
      html: body.html,
      url: body.url,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "网页剪藏导入失败。",
      },
      { status: 500 },
    );
  }
}

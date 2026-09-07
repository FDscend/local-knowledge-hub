import { NextResponse } from "next/server";
import { z } from "zod";

import { generateMetadataSuggestions } from "@/lib/knowledge-metadata";
import { readRuntimeLlmOverridesFromRequest } from "@/lib/runtime-keys";

const requestSchema = z.object({
  title: z.string().trim().optional().default(""),
  domain: z.string().trim().optional().default(""),
  content: z.string().trim().min(1, "正文不能为空"),
});

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const suggestions = await generateMetadataSuggestions(payload, readRuntimeLlmOverridesFromRequest(request));
    return NextResponse.json(suggestions);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "请求参数错误" }, { status: 400 });
    }

    return NextResponse.json({ error: "元数据生成失败，请稍后重试。" }, { status: 500 });
  }
}
import { NextResponse } from "next/server";

import { answerQuestion } from "@/lib/rag";
import { readRuntimeEmbeddingOverridesFromRequest, readRuntimeLlmOverridesFromRequest } from "@/lib/runtime-keys";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { question?: string; knowledgeBaseId?: string };
    const question = body.question?.trim();

    if (!question) {
      return NextResponse.json({ error: "问题不能为空。" }, { status: 400 });
    }

    const result = await answerQuestion(question, {
      ...readRuntimeLlmOverridesFromRequest(request),
      ...readRuntimeEmbeddingOverridesFromRequest(request),
      knowledgeBaseId: body.knowledgeBaseId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "问答接口执行失败。",
      },
      { status: 500 },
    );
  }
}
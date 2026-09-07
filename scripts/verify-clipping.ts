import "dotenv/config";

import { IngestRunStatus, KnowledgeSourceKind, SourceType } from "@prisma/client";

import { clipHtmlToMarkdown, importWebClipping } from "../src/lib/clipping";
import { createKnowledgeBase, deleteKnowledgeBase } from "../src/lib/knowledge-base";
import { prisma } from "../src/lib/prisma";
import { searchRelevantChunks } from "../src/lib/rag";

const TEMP_KB_NAME = `__verify_clipping_${Date.now()}__`;

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>检索增强生成（RAG）示例页面</title>
  <meta name="author" content="示例作者">
  <meta name="description" content="一篇用于验证网页剪藏流水线的示例文章。">
</head>
<body>
  <nav>导航栏不应被剪入正文</nav>
  <article>
    <h1>检索增强生成（RAG）综述</h1>
    <p>检索增强生成让模型结合外部知识回答问题时更可控、更可溯源。</p>
    <img src="/assets/hero.png" alt="RAG 流程示意图">
    <h2>检索环节</h2>
    <p>词法检索基于关键词倒排索引，语义检索依赖向量相似度，<a href="/methods/bm25.html">BM25</a> 是常见的词法打分函数。</p>
    <p>更多细节可参考 <a href="https://example.com/paper">论文链接</a>。</p>
  </article>
  <footer>页脚内容不应被剪入正文</footer>
</body>
</html>`;

function fail(message: string): never {
  throw new Error(`剪藏验证失败：${message}`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

async function main(): Promise<void> {
  const knowledgeBase = await createKnowledgeBase({
    name: TEMP_KB_NAME,
    description: "网页剪藏流水线验证用临时知识库，验证后删除。",
    defaultLanguage: "zh-CN",
  });

  try {
    // 1. 纯转换：HTML → 规范 Markdown。
    const clipped = await clipHtmlToMarkdown({
      html: SAMPLE_HTML,
      url: "https://example.com/article.html",
      title: "检索增强生成（RAG）综述",
    });
    expect(clipped.noteName.includes("检索增强生成（RAG）综述"), `noteName 异常：${clipped.noteName}`);
    expect(clipped.markdown.includes("检索增强生成（RAG）综述"), "Markdown 缺少标题。");
    expect(clipped.markdown.includes("更可控、更可溯源"), "Markdown 缺少正文。");
    expect(clipped.markdown.includes("https://example.com/assets/hero.png"), "相对图片路径未归一化为绝对 URL。");
    expect(clipped.markdown.includes("https://example.com/article.html"), "frontmatter 或正文缺少来源 URL。");
    expect(!/<[a-z][^>]*>/i.test(clipped.markdown), "输出包含未转换的 HTML 标签（Markdown 转换失败）。");
    expect(!clipped.markdown.includes("导航栏不应被剪入正文"), "导航栏内容被误剪入正文。");
    expect(!clipped.markdown.includes("页脚内容不应被剪入正文"), "页脚内容被误剪入正文。");
    console.log(`[1] clipHtmlToMarkdown 转换成功（${clipped.markdown.length} 字符，frontmatter ${clipped.frontmatter.length} 字符）。`);

    // 2. 接入流水线：文档 / 版本 / 切片 / 来源入库。
    const imported = await importWebClipping({
      knowledgeBaseId: knowledgeBase.id,
      html: SAMPLE_HTML,
      url: "https://example.com/article.html",
      title: "检索增强生成（RAG）综述",
    });
    expect(imported.imported, "首次剪藏应标记为 imported。");
    const document = await prisma.knowledgeDocument.findUnique({
      where: { id: imported.documentId },
      include: { source: true, chunks: { select: { id: true } }, _count: { select: { chunks: true } } },
    });
    expect(document, "剪藏文档未入库。");
    expect(document.source?.kind === KnowledgeSourceKind.WEB, "来源 kind 应为 WEB。");
    expect(document.sourceType === SourceType.CLIPPING, "文档 sourceType 应为 CLIPPING。");
    expect(document._count.chunks > 0, "剪藏文档未生成切片。");
    expect(document.content.includes("https://example.com/assets/hero.png"), "库内 Markdown 未保留归一化图片 URL。");
    const run = await prisma.ingestRun.findFirst({ where: { knowledgeBaseId: knowledgeBase.id, source: "clipping:https://example.com/article.html" } });
    expect(run?.status === IngestRunStatus.SUCCEEDED, "IngestRun 未标记成功。");
    console.log(`[2] importWebClipping 入库成功（${document._count.chunks} 个切片，来源 ${document.source.kind}）。`);

    // 3. FTS 检索可命中剪藏文档。
    const hits = await searchRelevantChunks("检索增强生成（RAG）综述", knowledgeBase.id, 5);
    expect(hits.some((chunk) => chunk.documentId === imported.documentId), "FTS 检索未命中剪藏文档。");
    console.log(`[3] FTS 检索命中剪藏文档（共 ${hits.length} 条候选）。`);

    // 4. 同一 URL + 相同内容重复导入 → unchanged（快照去重）。
    const reimported = await importWebClipping({
      knowledgeBaseId: knowledgeBase.id,
      html: SAMPLE_HTML,
      url: "https://example.com/article.html",
    });
    expect(!reimported.imported && reimported.documentId === imported.documentId, "重复剪藏未按内容哈希去重。");
    console.log(`[4] 重复剪藏按内容哈希去重（unchanged，同一文档）。`);

    // 5. 大小限制：超长 HTML 被拒。
    let sizeBlocked = false;
    try {
      await clipHtmlToMarkdown({ html: "<p>x</p>".repeat(300_000), url: "https://example.com/big.html" });
    } catch {
      sizeBlocked = true;
    }
    expect(sizeBlocked, "超长 HTML 未被拒绝。");
    console.log(`[5] 超长 HTML 被拒绝。`);

    console.log("网页剪藏流水线全部验证通过。");
  } finally {
    await deleteKnowledgeBase(knowledgeBase.id, TEMP_KB_NAME);
  }
}

void main().finally(async () => prisma.$disconnect());

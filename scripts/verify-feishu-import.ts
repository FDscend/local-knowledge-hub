import "dotenv/config";

import { importFeishuClipping } from "../src/lib/feishu-import";
import { createKnowledgeBase, deleteKnowledgeBase } from "../src/lib/knowledge-base";
import { prisma } from "../src/lib/prisma";

const TEMP_KB_NAME = `__verify_feishu_${Date.now()}__`;

const SAMPLE_MARKDOWN = `---
title: 飞书示例文档
source: "feishu:示例"
---

# 飞书示例文档

## 背景

本文用于验证飞书转换核心的导入链路。

![飞书图片](https://example.com/feishu/image.png)

附件参考：[设计稿](https://example.com/feishu/design.pdf)
`;

/** 最小 PNG（1x1 红色像素）。 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fail(message: string): never {
  throw new Error(`飞书导入验证失败：${message}`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

async function main(): Promise<void> {
  const knowledgeBase = await createKnowledgeBase({
    name: TEMP_KB_NAME,
    description: "飞书转换核心导入链路验证用临时知识库，验证后删除。",
    defaultLanguage: "zh-CN",
  });

  try {
    const imported = await importFeishuClipping({
      knowledgeBaseId: knowledgeBase.id,
      title: "飞书示例文档",
      markdown: SAMPLE_MARKDOWN,
      sourceUrl: "https://feishu.cn/docx/verify001",
      assets: [
        {
          sourcePath: "https://example.com/feishu/image.png",
          fileName: "image.png",
          mimeType: "image/png",
          data: PNG_BYTES,
        },
      ],
    });
    expect(imported.imported, "首次飞书导入应标记为 imported。");

    const document = await prisma.knowledgeDocument.findUnique({
      where: { id: imported.documentId },
      include: { source: true, _count: { select: { chunks: true } } },
    });
    expect(document, "飞书文档未入库。");
    expect(document.source?.canonicalPathOrUrl === "https://feishu.cn/docx/verify001", "来源 URL 未保存。");
    expect(document._count.chunks > 0, "飞书文档未生成切片。");

    // 图片字节应落为受管对象，markdown 中的图片 URL 改写为 knowledge-asset://。
    expect(document.content.includes("knowledge-asset://"), "图片 URL 未改写为受管引用。");
    expect(!document.content.includes("https://example.com/feishu/image.png"), "原图片 URL 仍保留在正文。");
    const managedAssets = await prisma.managedAsset.findMany({
      where: { knowledgeBaseId: knowledgeBase.id },
      include: { object: true },
    });
    expect(managedAssets.length === 1, `受管附件数量异常：${managedAssets.length}`);
    expect(managedAssets[0].object.mimeType === "image/png", "受管附件 MIME 类型异常。");
    console.log(`[1] 附件字节落为受管对象（${managedAssets[0].object.size} 字节，MIME ${managedAssets[0].object.mimeType}）。`);

    const reimported = await importFeishuClipping({
      knowledgeBaseId: knowledgeBase.id,
      title: "飞书示例文档",
      markdown: SAMPLE_MARKDOWN,
      sourceUrl: "https://feishu.cn/docx/verify001",
      assets: [
        {
          sourcePath: "https://example.com/feishu/image.png",
          fileName: "image.png",
          mimeType: "image/png",
          data: PNG_BYTES,
        },
      ],
    });
    expect(!reimported.imported && reimported.documentId === imported.documentId, "重复导入未按内容哈希去重。");
    console.log(`[2] 重复导入按内容哈希去重（unchanged，${document._count.chunks} 个切片）。`);

    console.log("飞书转换核心导入链路全部验证通过。");
  } finally {
    await deleteKnowledgeBase(knowledgeBase.id, TEMP_KB_NAME);
  }
}

void main().finally(async () => prisma.$disconnect());

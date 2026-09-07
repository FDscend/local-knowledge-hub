import "dotenv/config";

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getKnowledgeBaseDirectory } from "../src/lib/data-directory";
import { prisma } from "../src/lib/prisma";
import { processOneTask } from "../src/lib/task-executor";
import { TASK_KIND, cancelQueuedTask, enqueueTask } from "../src/lib/tasks";

const KB_NAME = "__verify_ingest__";

async function drainUntilFinal(taskId: string, maxRounds = 60): Promise<{ status: string; resultJson: string | null; errorText: string | null }> {
  for (let round = 0; round < maxRounds; round += 1) {
    await processOneTask();
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true, resultJson: true, errorText: true } });
    if (!task) {
      throw new Error("任务记录不存在");
    }
    if (task.status === "SUCCEEDED" || task.status === "FAILED" || task.status === "CANCELLED") {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`任务 ${taskId} 未在预期轮次内结束`);
}

async function main(): Promise<void> {
  const existing = await prisma.knowledgeBase.findUnique({ where: { name: KB_NAME } });
  if (existing) {
    await prisma.knowledgeBase.delete({ where: { id: existing.id } });
  }
  const knowledgeBase = await prisma.knowledgeBase.create({
    data: { name: KB_NAME, description: "导入排队验证用临时知识库，验证后删除。" },
    select: { id: true },
  });

  const jobDir = path.join(getKnowledgeBaseDirectory(knowledgeBase.id), "jobs", "verify-ingest");
  try {
    // 1. 构造任务工作目录（两份 Markdown，含子目录层级）。
    await mkdir(path.join(jobDir, "nested"), { recursive: true });
    await writeFile(path.join(jobDir, "alpha.md"), "# Alpha\n\nRAG 是一种结合检索与生成的问答范式。\n", "utf8");
    await writeFile(path.join(jobDir, "nested", "beta.md"), "# Beta\n\n混合检索通常同时考虑词法与语义两路候选。\n", "utf8");

    const files = [
      { relativePath: "alpha.md", filePath: path.join(jobDir, "alpha.md") },
      { relativePath: "nested/beta.md", filePath: path.join(jobDir, "nested", "beta.md") },
    ];
    const queued = await enqueueTask(knowledgeBase.id, TASK_KIND.INGEST, { mineruMode: "light", jobDir, files }, { maxAttempts: 2 });
    const finished = await drainUntilFinal(queued.id);
    if (finished.status !== "SUCCEEDED") throw new Error(`导入任务未成功：${finished.status} ${finished.errorText ?? ""}`);
    const result = JSON.parse(finished.resultJson ?? "{}") as { importedCount?: number; unchangedCount?: number };
    if (result.importedCount !== 2) throw new Error(`导入数量异常：${finished.resultJson}`);

    // 2. 文档与切片入库、IngestRun 状态、任务进度。
    const documents = await prisma.knowledgeDocument.findMany({ where: { knowledgeBaseId: knowledgeBase.id }, select: { title: true, _count: { select: { chunks: true } } } });
    if (documents.length !== 2 || documents.some((document) => document._count.chunks === 0)) throw new Error(`文档入库异常：${JSON.stringify(documents)}`);
    const ingestRun = await prisma.ingestRun.findFirst({ where: { knowledgeBaseId: knowledgeBase.id }, select: { status: true, importedCount: true } });
    if (ingestRun?.status !== "SUCCEEDED" || ingestRun.importedCount !== 2) throw new Error("IngestRun 状态异常");
    const taskAfter = await prisma.task.findUnique({ where: { id: queued.id }, select: { progressCurrent: true, progressTotal: true } });
    if (taskAfter?.progressCurrent !== 2 || taskAfter.progressTotal !== 2) throw new Error("任务进度未回写");

    // 3. 工作目录已清理、自动评测已排队（防抖去重）。
    let jobDirExists = true;
    try {
      await import("node:fs/promises").then((fs) => fs.access(jobDir));
    } catch {
      jobDirExists = false;
    }
    if (jobDirExists) throw new Error("任务工作目录未清理");
    const autoTask = await prisma.task.findFirst({ where: { knowledgeBaseId: knowledgeBase.id, kind: "AUTO_EVALUATION", status: "QUEUED" }, select: { id: true, autoTriggered: true } });
    if (!autoTask || !autoTask.autoTriggered) throw new Error("导入完成应触发自动评测");
    await cancelQueuedTask(knowledgeBase.id, autoTask.id);

    console.log(JSON.stringify({
      status: "ok",
      imported: result.importedCount,
      documentTitles: documents.map((document) => document.title),
      ingestRun: { status: ingestRun?.status, importedCount: ingestRun?.importedCount },
      progress: { current: taskAfter?.progressCurrent, total: taskAfter?.progressTotal },
      jobDirCleaned: true,
      autoEvaluationQueued: "confirmed",
    }));
  } finally {
    await prisma.knowledgeBase.delete({ where: { id: knowledgeBase.id } }).catch(() => undefined);
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main().finally(async () => prisma.$disconnect());

import Link from "next/link";

import { TasksPanel, type TaskListItem } from "@/components/TasksPanel";
import { listKnowledgeBases } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type TasksPageProps = {
  searchParams: Promise<{ knowledgeBaseId?: string; status?: string; queued?: string; taskId?: string }>;
};

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "QUEUED", label: "排队中" },
  { value: "RUNNING", label: "运行中" },
  { value: "SUCCEEDED", label: "成功" },
  { value: "FAILED", label: "失败" },
  { value: "CANCELLED", label: "已取消" },
];

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const { knowledgeBaseId, status, queued, taskId } = await searchParams;
  const knowledgeBases = await listKnowledgeBases();
  const tasks = await prisma.task.findMany({
    where: {
      ...(knowledgeBaseId?.trim() ? { knowledgeBaseId: knowledgeBaseId.trim() } : {}),
      ...(status && STATUS_OPTIONS.some((option) => option.value === status) ? { status } : {}),
    },
    include: { knowledgeBase: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="workspace-page tasks-page">
      <header className="workspace-toolbar tasks-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">TASK QUEUE</p>
          <h2>任务中心</h2>
          <p className="muted-text">
            所有后台任务（评测、自动评测、向量索引重建、导入）统一在这里排队、执行、重试与取消。自动评测由导入或检索配置变更触发，报告始终标记为“自动触发”，不等同于人工审核指标。
          </p>
        </div>
        <div className="workspace-toolbar-actions">
          <form method="get" className="tasks-filter-form">
            <label className="field compact-field">
              <span>知识库</span>
              <select className="input" name="knowledgeBaseId" defaultValue={knowledgeBaseId ?? ""}>
                <option value="">全部知识库</option>
                {knowledgeBases.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="field compact-field">
              <span>状态</span>
              <select className="input" name="status" defaultValue={status ?? ""}>
                {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button type="submit" className="button secondary">筛选</button>
          </form>
          <Link className="button secondary" href="/evaluations">返回评测</Link>
        </div>
      </header>

      {queued === "1" ? (
        <section className="banner">
          <div>
            <h2>导入任务已排队，正在后台执行</h2>
            <p className="muted-text">文件解析（含 MinerU）完成后会自动触发一次冒烟评测。你可以先做其它事，或在本页跟踪进度、重试失败项。</p>
          </div>
          <Link className="button primary" href={`/tasks?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId ?? "")}&status=RUNNING`}>查看进行中任务</Link>
        </section>
      ) : null}

      <TasksPanel tasks={tasks.map((task) => ({
        id: task.id,
        knowledgeBaseId: task.knowledgeBaseId,
        knowledgeBaseName: task.knowledgeBase.name,
        kind: task.kind,
        status: task.status,
        autoTriggered: task.autoTriggered,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        payloadJson: task.payloadJson,
        resultJson: task.resultJson,
        errorText: task.errorText,
        progressCurrent: task.progressCurrent,
        progressTotal: task.progressTotal,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString() ?? null,
        finishedAt: task.finishedAt?.toISOString() ?? null,
      }))} />
    </div>
  );
}

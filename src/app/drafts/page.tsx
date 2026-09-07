import Link from "next/link";

import { DraftsPanel, type DraftListItem } from "@/components/DraftsPanel";
import { listKnowledgeBases } from "@/lib/knowledge-base";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type DraftsPageProps = {
  searchParams: Promise<{ knowledgeBaseId?: string; status?: string }>;
};

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "PENDING", label: "待审核" },
  { value: "APPLIED", label: "已应用" },
  { value: "REJECTED", label: "已拒绝" },
];

export default async function DraftsPage({ searchParams }: DraftsPageProps) {
  const { knowledgeBaseId, status } = await searchParams;
  const knowledgeBases = await listKnowledgeBases();
  const drafts = await prisma.documentDraft.findMany({
    where: {
      ...(knowledgeBaseId?.trim() ? { knowledgeBaseId: knowledgeBaseId.trim() } : {}),
      ...(status && STATUS_OPTIONS.some((option) => option.value === status) ? { status } : {}),
    },
    include: { knowledgeBase: { select: { name: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  return (
    <div className="workspace-page drafts-page">
      <header className="workspace-toolbar drafts-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">CONTROLLED WRITES</p>
          <h2>草稿中心</h2>
          <p className="muted-text">
            助手提出的知识提案（新建 / 修改 / 停用）只落为待审核草稿，不会直接修改知识库。请先审阅完整
            Markdown 与变更差异，确认无误后再应用；应用会写入版本、切片并留审计记录，可随时在文档管理中停用或编辑。
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
          <Link className="button secondary" href="/qa">返回问答</Link>
        </div>
      </header>

      <DraftsPanel
        drafts={drafts.map((draft) => ({
          id: draft.id,
          knowledgeBaseId: draft.knowledgeBaseId,
          knowledgeBaseName: draft.knowledgeBase.name,
          kind: draft.kind as DraftListItem["kind"],
          documentTitle: draft.documentTitle,
          status: draft.status as DraftListItem["status"],
          sourceTool: draft.sourceTool,
          createdAt: draft.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}

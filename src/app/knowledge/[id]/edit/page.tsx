import Link from "next/link";
import { notFound } from "next/navigation";

import { updateKnowledgeAction } from "@/app/actions";
import { KnowledgeForm } from "@/components/KnowledgeForm";
import { getAvailableTags, getKnowledgeDocument } from "@/lib/knowledge";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type EditKnowledgePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ knowledgeBaseId?: string }>;
};

export default async function EditKnowledgePage({ params, searchParams }: EditKnowledgePageProps) {
  const { id } = await params;
  const { knowledgeBaseId } = await searchParams;
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const [document, availableTags] = await Promise.all([getKnowledgeDocument(id, knowledgeBase.id), getAvailableTags(knowledgeBase.id)]);

  if (!document) {
    notFound();
  }

  return (
    <div className="workspace-page edit-knowledge-page">
      <header className="workspace-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">EDIT KNOWLEDGE</p>
          <h2>编辑知识</h2>
          <p className="muted-text">修改后会重新生成切片，搜索和问答会立即使用更新后的正文。</p>
        </div>
        <div className="workspace-toolbar-actions">
          <Link href={`/knowledge/${document.id}?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            返回详情
          </Link>
          <Link href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            返回列表
          </Link>
        </div>
      </header>

      <section className="workspace-section knowledge-form-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">EDIT</p>
            <h3>{document.title}</h3>
            <p className="muted-text">修改后会重新生成切片，搜索和问答会立即使用更新后的正文。</p>
          </div>
        </div>
        <KnowledgeForm action={updateKnowledgeAction.bind(null, document.id)} submitLabel="保存修改" document={document} knowledgeBaseId={knowledgeBase.id} availableTags={availableTags} mode="edit" />
      </section>
    </div>
  );
}

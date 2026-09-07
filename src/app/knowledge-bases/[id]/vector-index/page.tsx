import Link from "next/link";
import { notFound } from "next/navigation";

import { VectorIndexPanel } from "@/components/VectorIndexPanel";
import { getEmbeddingIndexStatus } from "@/lib/embedding";
import { getKnowledgeStats } from "@/lib/knowledge";
import { getKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type VectorIndexPageProps = {
  params: Promise<{ id: string }>;
};

export default async function KnowledgeBaseVectorIndexPage({ params }: VectorIndexPageProps) {
  const { id } = await params;
  const knowledgeBase = await getKnowledgeBase(id);
  if (!knowledgeBase) {
    notFound();
  }

  const [stats, embeddingStatus] = await Promise.all([
    getKnowledgeStats(knowledgeBase.id),
    Promise.resolve(getEmbeddingIndexStatus(knowledgeBase.id)),
  ]);

  return (
    <div className="workspace-page vector-index-page">
      <header className="workspace-toolbar vector-index-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">SEMANTIC INDEX</p>
          <h2>{knowledgeBase.name} · 语义索引</h2>
          <p className="muted-text">向量索引仅覆盖当前知识库。文档导入、编辑或同步后可在此手动重建；未构建时问答仍使用 FTS5 关键词检索。</p>
        </div>
        <div className="workspace-toolbar-actions">
          <Link className="button secondary" href="/knowledge-bases">知识库管理</Link>
          <Link className="button secondary" href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>打开文档</Link>
          <Link className="button secondary" href={`/qa?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>知识问答</Link>
        </div>
      </header>

      <div className="workspace-content vector-index-content">
        <section className="workspace-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">INDEX STATUS</p>
              <h3>索引状态</h3>
            </div>
            <span className="workspace-section-note">当前知识库</span>
          </div>
          <div className="knowledge-metrics">
            <article className="stat-card">
              <p className="stat-label">当前文档</p>
              <p className="stat-value">{stats.total}</p>
            </article>
            <article className="stat-card">
              <p className="stat-label">当前切片</p>
              <p className="stat-value">{stats.chunkTotal}</p>
            </article>
            <article className="stat-card">
              <p className="stat-label">已索引切片</p>
              <p className="stat-value">{embeddingStatus.indexedCount}</p>
            </article>
          </div>
        </section>

        <VectorIndexPanel
          knowledgeBaseId={knowledgeBase.id}
          serverConfigured={embeddingStatus.configured}
          indexedCount={embeddingStatus.indexedCount}
          dimensions={embeddingStatus.dimensions}
          model={embeddingStatus.model}
          indexedAt={embeddingStatus.indexedAt}
          indexStatus={embeddingStatus.status}
          errorText={embeddingStatus.errorText}
        />
      </div>
    </div>
  );
}
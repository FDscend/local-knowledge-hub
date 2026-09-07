import { DocumentStatus } from "@prisma/client";
import Link from "next/link";
import { notFound } from "next/navigation";

import { deleteKnowledgeAction, exportKnowledgeDocumentAction, toggleKnowledgeStatusAction } from "@/app/actions";
import { AppAuxiliaryPanel } from "@/components/AppAuxiliaryPanel";
import { DocumentDetailLayout } from "@/components/DocumentDetailLayout";
import { MarkdownArticle } from "@/components/MarkdownArticle";
import { formatDateTime, splitTags, sourceTypeLabels, statusLabels } from "@/lib/knowledge-ui";
import { getKnowledgeDocument } from "@/lib/knowledge";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type KnowledgeDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ knowledgeBaseId?: string; exported?: string; exportDir?: string; assetCount?: string }>;
};

export default async function KnowledgeDetailPage({ params, searchParams }: KnowledgeDetailPageProps) {
  const { id } = await params;
  const { knowledgeBaseId, exported, exportDir, assetCount } = await searchParams;
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const document = await getKnowledgeDocument(id, knowledgeBase.id);

  if (!document) {
    notFound();
  }

  return (
    <div className="workspace-page document-detail-page">
      <header className="workspace-toolbar document-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">DOCUMENT READER</p>
          <div className="document-breadcrumbs">
            <Link href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>文档库</Link>
            <span aria-hidden="true">/</span>
            <span>{knowledgeBase.name}</span>
          </div>
          <h2>{document.title}</h2>
          <div className="pill-row document-status-row">
            <span className="status-badge" data-status={document.status}>
              {statusLabels[document.status]}
            </span>
            <span className="badge">{sourceTypeLabels[document.sourceType]}</span>
            {splitTags(document.tagsText).map((tag) => (
              <span key={`${document.id}-${tag}`} className="pill">
                {tag}
              </span>
            ))}
          </div>
          <p className="muted-text document-summary">{document.summary || "暂无摘要"}</p>
        </div>

        <div className="workspace-toolbar-actions document-toolbar-actions">
          <Link href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            返回列表
          </Link>
          <Link href={`/knowledge/${document.id}/edit?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            编辑
          </Link>
          <form action={exportKnowledgeDocumentAction}>
            <input type="hidden" name="knowledgeBaseId" value={knowledgeBase.id} />
            <input type="hidden" name="documentId" value={document.id} />
            <button type="submit" className="button secondary">
              导出 Markdown
            </button>
          </form>
          <form action={toggleKnowledgeStatusAction.bind(null, document.id, knowledgeBase.id)}>
            <button type="submit" className="button secondary">
              {document.status === DocumentStatus.DISABLED ? "启用" : "停用"}
            </button>
          </form>
          <form action={deleteKnowledgeAction.bind(null, document.id, knowledgeBase.id)}>
            <button type="submit" className="button secondary">
              删除
            </button>
          </form>
        </div>
      </header>

      {exported ? (
        <section className="banner document-export-banner">
          <strong>导出完成</strong>
          <span>
            已写入受管 exports 目录{assetCount ? `，附件 ${assetCount} 个` : ""}。
            {exportDir ? ` 路径：${exportDir}` : ""}
          </span>
        </section>
      ) : null}

      <DocumentDetailLayout
        main={
          <article className="document-body-panel">
            <header className="document-section-heading">
              <div>
                <p className="section-kicker">CONTENT</p>
                <h3>正文</h3>
              </div>
              <span className="workspace-section-note">Markdown 原文</span>
            </header>
            <MarkdownArticle content={document.content} frontmatter={document.frontmatter} knowledgeBaseId={knowledgeBase.id} />
          </article>
        }
        side={
          <>
            <AppAuxiliaryPanel kicker="METADATA" title="文档元数据">
              <div className="document-meta-group">
                <p className="section-kicker">SOURCE</p>
                <h3>来源信息</h3>
                <dl>
                  <dt>来源路径</dt>
                  <dd>{document.sourcePath}</dd>
                  <dt>来源链接</dt>
                  <dd>{document.sourceUrl || "-"}</dd>
                  <dt>主题域</dt>
                  <dd>{document.domain}</dd>
                  <dt>切片数</dt>
                  <dd>{document.chunks.length}</dd>
                </dl>
              </div>

              <div className="document-meta-group">
                <p className="section-kicker">VERSION</p>
                <h3>版本信息</h3>
                <dl>
                  <dt>创建时间</dt>
                  <dd>{formatDateTime(document.createdAt)}</dd>
                  <dt>更新时间</dt>
                  <dd>{formatDateTime(document.updatedAt)}</dd>
                  <dt>导入模式</dt>
                  <dd>{document.ingestMode || "-"}</dd>
                  <dt>importId</dt>
                  <dd>{document.importId || "-"}</dd>
                </dl>
              </div>
            </AppAuxiliaryPanel>

            <aside className="document-chunks-panel">
              <header className="document-section-heading">
                <div>
                  <p className="section-kicker">CHUNKS</p>
                  <h3>切片预览</h3>
                </div>
                <span className="workspace-section-note">{document.chunks.length} 个切片</span>
              </header>
              <ul className="chunk-list">
                {document.chunks.map((chunk) => (
                  <li key={chunk.id} className="chunk-card">
                    <h3>{chunk.heading || `切片 ${chunk.chunkIndex + 1}`}</h3>
                    <p className="muted-text">{chunk.sectionPath}</p>
                    <p>{chunk.content.slice(0, 220)}{chunk.content.length > 220 ? "..." : ""}</p>
                  </li>
                ))}
              </ul>
            </aside>
          </>
        }
      />
    </div>
  );
}

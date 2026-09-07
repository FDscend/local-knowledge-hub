import { DocumentStatus } from "@prisma/client";
import Link from "next/link";

import { deleteKnowledgeAction, importBrowserDirectoryAction, toggleKnowledgeStatusAction } from "@/app/actions";
import { BrowserDirectoryImportForm } from "@/components/BrowserDirectoryImportForm";
import { KnowledgeTagFilter } from "@/components/KnowledgeTagFilter";
import { formatDateTime, splitTags, sourceTypeLabels, statusLabels } from "@/lib/knowledge-ui";
import { type KnowledgeSort, getAvailableTags, getKnowledgeStats, listKnowledge } from "@/lib/knowledge";
import { DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID, requireKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type KnowledgePageProps = {
  searchParams: Promise<{
    knowledgeBaseId?: string;
    q?: string;
    tag?: string | string[];
    status?: string;
    imported?: string;
    sort?: string;
    directoryImported?: string;
    unchanged?: string;
    skipped?: string;
    errors?: string;
  }>;
};

const sortOptions: Array<{ value: KnowledgeSort; label: string }> = [
  { value: "updated-desc", label: "最近更新" },
  { value: "updated-asc", label: "最早更新" },
  { value: "created-desc", label: "最近创建" },
  { value: "title-asc", label: "标题 A-Z" },
  { value: "title-desc", label: "标题 Z-A" },
];

function normalizeSelectedTags(input: string | string[] | undefined): string[] {
  if (!input) {
    return [];
  }

  const values = Array.isArray(input) ? input : [input];
  return Array.from(new Set(values.map((tag) => tag.trim()).filter(Boolean)));
}

function buildKnowledgeHref(params: { knowledgeBaseId: string; q?: string; tags?: string[]; status?: string; sort?: string }) {
  const nextParams = new URLSearchParams();

  nextParams.set("knowledgeBaseId", params.knowledgeBaseId);

  if (params.q) {
    nextParams.set("q", params.q);
  }
  for (const tag of params.tags ?? []) {
    nextParams.append("tag", tag);
  }
  if (params.status && params.status !== "ALL") {
    nextParams.set("status", params.status);
  }
  if (params.sort && params.sort !== "updated-desc") {
    nextParams.set("sort", params.sort);
  }

  const query = nextParams.toString();
  return query ? `/knowledge?${query}` : "/knowledge";
}

export default async function KnowledgePage({ searchParams }: KnowledgePageProps) {
  const params = await searchParams;
  const knowledgeBase = await requireKnowledgeBase(params.knowledgeBaseId);
  const status = params.status && params.status in DocumentStatus ? (params.status as DocumentStatus) : undefined;
  const selectedTags = normalizeSelectedTags(params.tag);
  const sort = sortOptions.some((option) => option.value === params.sort) ? (params.sort as KnowledgeSort) : "updated-desc";
  const [documents, tags, stats] = await Promise.all([
    listKnowledge({
      knowledgeBaseId: knowledgeBase.id,
      query: params.q,
      tags: selectedTags,
      status: status ?? "ALL",
      sort,
    }),
    getAvailableTags(knowledgeBase.id),
    getKnowledgeStats(knowledgeBase.id),
  ]);
  const remainingTags = tags.filter((tag) => !selectedTags.includes(tag));
  const canImportBrowserDirectory = knowledgeBase.id !== DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID && !knowledgeBase.syncRootPath;

  return (
    <div className="workspace-page knowledge-page">
      <header className="workspace-toolbar knowledge-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">DOCUMENT LIBRARY</p>
          <h2>{knowledgeBase.name} · 知识管理</h2>
          <p className="muted-text">浏览、检索和维护当前知识库中的文档；每条文档都保留来源路径，供后续问答引用。</p>
          <div className="knowledge-toolbar-summary">
            <span>{stats.total} 篇文档</span>
            <span>{stats.chunkTotal} 个切片</span>
            <span>{tags.length} 个标签</span>
          </div>
        </div>
        <div className="workspace-toolbar-actions">
          <Link href={`/knowledge/new?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button primary">
            新增知识
          </Link>
          <Link href={`/qa?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            去问答页
          </Link>
          <Link href={`/knowledge-bases?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">管理知识库</Link>
        </div>
      </header>

      {params.imported ? <section className="banner"><strong>导入完成。</strong><span>当前列表已刷新为最新数据库内容。</span></section> : null}
      {params.directoryImported ? (
        <section className="banner">
          <strong>目录快照导入完成。</strong>
          <span>新增或更新 {params.imported ?? "0"} 项，未变更 {params.unchanged ?? "0"} 项，跳过 {params.skipped ?? "0"} 项，失败 {params.errors ?? "0"} 项。</span>
        </section>
      ) : null}

      {canImportBrowserDirectory ? (
        <section className="workspace-section import-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">INGEST</p>
              <h3>导入知识</h3>
              <p className="muted-text">将文件夹作为复制快照导入当前知识库；同步库不会显示浏览器上传入口。</p>
            </div>
            <span className="workspace-section-note">当前目标：{knowledgeBase.name}</span>
          </div>
          <BrowserDirectoryImportForm
            action={importBrowserDirectoryAction}
            knowledgeBases={[{ id: knowledgeBase.id, name: knowledgeBase.name }]}
            returnTo="knowledge"
          />
        </section>
      ) : null}

      <section className="knowledge-metrics" aria-label="知识库统计">
        <article className="stat-card">
          <p className="stat-label">当前结果</p>
          <p className="stat-value">{documents.length}</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">知识总数</p>
          <p className="stat-value">{stats.total}</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">启用中</p>
          <p className="stat-value">{stats.active}</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">标签总数</p>
          <p className="stat-value">{tags.length}</p>
        </article>
      </section>

      <section className="workspace-section search-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">SEARCH</p>
            <h3>筛选文档</h3>
          </div>
          {documents.length > 0 ? <span className="workspace-section-note">当前显示 {documents.length} 条结果</span> : null}
        </div>
        <form method="get" className="knowledge-search-form">
        <input type="hidden" name="knowledgeBaseId" value={knowledgeBase.id} />
        <div className="toolbar">
          <label className="field">
            <span>关键词</span>
            <input className="input" name="q" defaultValue={params.q ?? ""} placeholder="标题、标签、正文关键词" />
          </label>

          <label className="field">
            <span>状态</span>
            <select className="input" name="status" defaultValue={params.status ?? "ALL"}>
              <option value="ALL">全部状态</option>
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>排序</span>
            <select className="input" name="sort" defaultValue={sort}>
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" className="button primary">
            搜索
          </button>
        </div>
        </form>
      </section>

      <KnowledgeTagFilter knowledgeBaseId={knowledgeBase.id} query={params.q} status={params.status} sort={sort} selectedTags={selectedTags} remainingTags={remainingTags} />

      {params.q || (params.status && params.status !== "ALL") ? (
        <section className="banner">
          <div>
            <strong>当前筛选</strong>
            <div className="pill-row">
              {params.q ? <span className="badge">关键词：{params.q}</span> : null}
              {params.status && params.status !== "ALL" ? <span className="badge">状态：{statusLabels[params.status as DocumentStatus]}</span> : null}
            </div>
          </div>
          <Link href={buildKnowledgeHref({ knowledgeBaseId: knowledgeBase.id, sort })} scroll={false} className="button secondary">
            清空筛选
          </Link>
        </section>
      ) : null}

      <section className="workspace-section document-section">
        <div className="workspace-section-heading document-section-heading">
          <div>
            <p className="section-kicker">DOCUMENTS</p>
            <h3>文档列表</h3>
          </div>
          <span className="workspace-section-note">启用文档 {stats.active} · 当前结果 {documents.length}</span>
        </div>
        <div className="doc-list">
        {documents.length === 0 ? (
          <article className="doc-card">
            <h2>没有匹配结果</h2>
            <p className="muted-text">可以尝试放宽关键词，或先从首页重新导入 P0 材料。</p>
          </article>
        ) : (
          documents.map((document) => (
            <article key={document.id} className="doc-card">
              <header>
                <div>
                  <h2>{document.title}</h2>
                  <div className="pill-row">
                    <span className="status-badge" data-status={document.status}>
                      {statusLabels[document.status]}
                    </span>
                    <span className="badge">{sourceTypeLabels[document.sourceType]}</span>
                    {splitTags(document.tagsText).map((tag) => {
                      const nextTags = selectedTags.includes(tag)
                        ? selectedTags.filter((current) => current !== tag)
                        : [...selectedTags, tag];

                      return (
                      <Link
                        key={`${document.id}-${tag}`}
                        href={buildKnowledgeHref({
                          knowledgeBaseId: knowledgeBase.id,
                          q: params.q,
                          tags: nextTags,
                          status: params.status,
                          sort,
                        })}
                        scroll={false}
                        className={`pill interactive-pill${selectedTags.includes(tag) ? " active-pill" : ""}`}
                      >
                        {tag}
                      </Link>
                      );
                    })}
                  </div>
                </div>
                <div className="inline-actions">
                  <Link href={`/knowledge/${document.id}?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
                    详情
                  </Link>
                  <Link href={`/knowledge/${document.id}/edit?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
                    编辑
                  </Link>
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

              <p>{document.summary || "暂无摘要"}</p>

              <div className="doc-meta">
                <span>来源路径：{document.sourcePath}</span>
                <span>主题域：{document.domain}</span>
                <span>切片数：{document._count.chunks}</span>
                <span>更新时间：{formatDateTime(document.updatedAt)}</span>
              </div>
            </article>
          ))
        )}
        </div>
      </section>
    </div>
  );
}

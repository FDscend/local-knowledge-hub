import Link from "next/link";

import { formatDateTime, statusLabels } from "@/lib/knowledge-ui";
import { getKnowledgeStats } from "@/lib/knowledge";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type HomePageProps = { searchParams: Promise<{ knowledgeBaseId?: string }> };

export default async function HomePage({ searchParams }: HomePageProps) {
  const { knowledgeBaseId } = await searchParams;
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const stats = await getKnowledgeStats(knowledgeBase.id);

  return (
    <div className="workspace-page overview-page">
      <header className="workspace-toolbar overview-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">OVERVIEW</p>
          <h2>{knowledgeBase.name}</h2>
        </div>
        <div className="workspace-toolbar-actions">
          <Link href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            查看知识列表
          </Link>
          <Link href={`/knowledge/new?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            上传或录入知识
          </Link>
          <Link href={`/qa?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            进入问答页
          </Link>
        </div>
        <p className="muted-text overview-toolbar-description">
          {knowledgeBase.description || "本机运行的独立知识库。"} {knowledgeBase.syncRootPath ? "当前库通过受控目录同步；" : "当前快照库支持手动录入和浏览器上传；"}当前版本支持知识管理、关键词搜索和基于检索的简易问答。
        </p>
      </header>

      <div className="workspace-content overview-content">
        <section className="workspace-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">STATUS</p>
              <h3>状态摘要</h3>
            </div>
            <span className="workspace-section-note">当前知识库统计</span>
          </div>
          <div className="knowledge-metrics">
            <article className="stat-card">
              <p className="stat-label">知识文档总数</p>
              <p className="stat-value">{stats.total}</p>
            </article>
            <article className="stat-card">
              <p className="stat-label">启用中文档</p>
              <p className="stat-value">{stats.active}</p>
            </article>
            <article className="stat-card">
              <p className="stat-label">切片总数</p>
              <p className="stat-value">{stats.chunkTotal}</p>
            </article>
            <article className="stat-card">
              <p className="stat-label">草稿 / 停用</p>
              <p className="stat-value">
                {stats.draft} / {stats.disabled}
              </p>
            </article>
          </div>
        </section>

        <section className="workspace-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">QUICK START</p>
              <h3>快速开始</h3>
            </div>
            <span className="workspace-section-note">推荐操作顺序</span>
          </div>
          <p className="muted-text">
            1. {knowledgeBase.syncRootPath ? "将文件放入同步根目录后，在同步源页执行同步。" : "点击“上传或录入知识”上传单篇文件或手动录入；批量文件夹导入在知识管理页。"} 2. 在知识管理页检索并查看详情。3. 在问答页提问并检查命中的来源路径。
          </p>
          <div className="overview-latest-import">
            <h3>最近一次导入</h3>
            {stats.latestIngestRun ? (
              <dl className="overview-import-grid">
                <div>
                  <dt>状态</dt>
                  <dd>{stats.latestIngestRun.status}</dd>
                </div>
                <div>
                  <dt>导入文档</dt>
                  <dd>{stats.latestIngestRun.importedCount}</dd>
                </div>
                <div>
                  <dt>切片数</dt>
                  <dd>{stats.latestIngestRun.chunkCount}</dd>
                </div>
                <div>
                  <dt>完成时间</dt>
                  <dd>{formatDateTime(stats.latestIngestRun.finishedAt ?? stats.latestIngestRun.startedAt)}</dd>
                </div>
              </dl>
            ) : (
              <p className="muted-text">还没有导入记录。</p>
            )}
          </div>
        </section>

        <section className="workspace-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">MODULES</p>
              <h3>页面入口与状态约定</h3>
            </div>
          </div>
          <div className="two-column-layout overview-modules">
            <article className="stack-panel">
              <h3>首版页面</h3>
          <ul className="source-list">
            <li>
              <strong>首页</strong>
              <span>展示状态统计、最近导入记录和演示入口。</span>
            </li>
            <li>
              <strong>知识管理页</strong>
              <span>支持列表、关键词搜索、状态筛选、启停、删除和新建。</span>
            </li>
            <li>
              <strong>知识详情页</strong>
              <span>展示元数据、来源路径、完整正文和切片。</span>
            </li>
            <li>
              <strong>新增知识页</strong>
              <span>{knowledgeBase.syncRootPath ? "支持受控目录同步；请在同步源页扫描并同步。" : "支持手动录入、Markdown / Clipping 文件上传，以及 PDF、DOCX、PPTX、XLSX 和图片的 MinerU 解析导入。"}</span>
            </li>
            <li>
              <strong>知识问答页</strong>
              <span>检索 3 到 5 个切片，返回答案与引用来源。</span>
            </li>
          </ul>
        </article>

        <article className="stack-panel">
          <h3>状态约定</h3>
          <div className="pill-row">
            {Object.entries(statusLabels).map(([status, label]) => (
              <span key={status} className="status-badge" data-status={status}>
                {label}
              </span>
            ))}
          </div>
          <p className="muted-text">问答与默认搜索只面向启用中的知识条目，停用条目仍保留在管理端可见。</p>
        </article>
          </div>
        </section>
      </div>
    </div>
  );
}

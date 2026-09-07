import Link from "next/link";

import { createKnowledgeBaseAction, importBrowserDirectoryAction, importBrowserMultiFileAction } from "@/app/actions";
import { BrowserDirectoryImportForm } from "@/components/BrowserDirectoryImportForm";
import { BrowserMultiFileImportForm } from "@/components/BrowserMultiFileImportForm";
import { KnowledgeBaseDangerActions } from "@/components/KnowledgeBaseDangerActions";
import { getEmbeddingIndexStatus, type EmbeddingIndexStatus, type VectorIndexLifecycle } from "@/lib/embedding";
import { getKnowledgeStats } from "@/lib/knowledge";
import { DEFAULT_KNOWLEDGE_BASE_ID, DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID, listKnowledgeBases } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type KnowledgeBasesPageProps = { searchParams: Promise<{ cleared?: string; deleted?: string; directoryImported?: string; knowledgeBaseId?: string; imported?: string; unchanged?: string; skipped?: string; errors?: string }> };

function getEmbeddingStatusLabel(status: EmbeddingIndexStatus, chunkTotal: number): string {
  if (status.status === "PENDING") {
    return "构建中";
  }
  if (status.status === "FAILED") {
    return "构建失败";
  }
  if (chunkTotal === 0) {
    return "暂无切片";
  }
  if (status.status === "READY" && status.indexedCount === chunkTotal) {
    return "已完成";
  }
  if (status.indexedCount > 0) {
    return "需重建";
  }
  return "未构建";
}

function getEmbeddingStatusTone(status: EmbeddingIndexStatus, chunkTotal: number): VectorIndexLifecycle | "INCOMPLETE" {
  if (status.status === "READY" && status.indexedCount !== chunkTotal && chunkTotal > 0) {
    return "INCOMPLETE";
  }
  return status.status;
}

export default async function KnowledgeBasesPage({ searchParams }: KnowledgeBasesPageProps) {
  const params = await searchParams;
  const knowledgeBases = await listKnowledgeBases();
  const rows = await Promise.all(
    knowledgeBases.map(async (knowledgeBase) => {
      const [stats, embeddingStatus] = await Promise.all([getKnowledgeStats(knowledgeBase.id), Promise.resolve(getEmbeddingIndexStatus(knowledgeBase.id))]);
      return { knowledgeBase, stats, embeddingStatus };
    }),
  );

  return (
    <div className="workspace-page knowledge-bases-page">
      <header className="workspace-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">KNOWLEDGE BASES</p>
          <h2>知识库</h2>
          <p className="muted-text">每个知识库拥有独立的文档、切片、来源、受管对象和问答检索范围。快照知识库支持浏览器单文件或文件夹导入；同步知识库只接收同步根目录内的文件。</p>
        </div>
      </header>
      {params.cleared ? <section className="banner"><strong>知识库内容已清空。</strong><span>知识库配置已保留，原始导入文件未被修改。</span></section> : null}
      {params.deleted ? <section className="banner"><strong>知识库已删除。</strong><span>只清理了该知识库的数据库记录和库级受管目录。</span></section> : null}
      {params.directoryImported ? <section className="banner"><strong>目录快照导入完成。</strong><span>新增或更新 {params.imported ?? "0"} 项，未变更 {params.unchanged ?? "0"} 项，跳过 {params.skipped ?? "0"} 项，失败 {params.errors ?? "0"} 项。</span></section> : null}
      <section className="workspace-section knowledge-bases-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">LIBRARIES</p>
            <h3>知识库列表（{rows.length}）</h3>
          </div>
        </div>
        <div className="doc-list">
        {rows.map(({ knowledgeBase, stats, embeddingStatus }) => (
          <article key={knowledgeBase.id} className="doc-card">
            <header>
              <div>
                <h2>{knowledgeBase.name}</h2>
                <p className="muted-text">{knowledgeBase.description || "暂无描述"}</p>
                {knowledgeBase.id === DEFAULT_KNOWLEDGE_BASE_ID ? <p className="field-helper">内置收件箱 · 不参与目录同步</p> : null}
                {knowledgeBase.id === DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID ? <p className="field-helper">开发数据 · 仅由显式 seed 命令创建</p> : null}
                {knowledgeBase.syncRootPath ? <p className="field-helper">已绑定本机同步根目录；支持受控 Markdown 扫描、预览与手动同步。</p> : null}
              </div>
              <div className="inline-actions">
                <Link className="button primary" href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>打开</Link>
                <Link className="button secondary" href={`/qa?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>问答</Link>
                <Link className="button secondary" href={`/evaluations?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>评测</Link>
                <Link className="button secondary" href={`/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}/vector-index`}>语义索引</Link>
                {knowledgeBase.syncRootPath ? <Link className="button secondary" href={`/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}/sync`}>同步源</Link> : null}
                <KnowledgeBaseDangerActions
                  knowledgeBaseId={knowledgeBase.id}
                  knowledgeBaseName={knowledgeBase.name}
                  canClear={knowledgeBase.id !== DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID}
                  canDelete={knowledgeBase.id !== DEFAULT_KNOWLEDGE_BASE_ID && knowledgeBase.id !== DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID}
                />
              </div>
            </header>
            <div className="doc-meta">
              <span>语言：{knowledgeBase.defaultLanguage}</span>
              <span>文档：{stats.total}</span>
              <span>切片：{stats.chunkTotal}</span>
              <span className="embedding-status" data-status={getEmbeddingStatusTone(embeddingStatus, stats.chunkTotal)}>
                Embedding：{getEmbeddingStatusLabel(embeddingStatus, stats.chunkTotal)}（{embeddingStatus.indexedCount}/{stats.chunkTotal}）
              </span>
            </div>
          </article>
        ))}
        </div>
      </section>
      <section className="workspace-section create-knowledge-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">CREATE</p>
            <h3>新建知识库</h3>
            <p className="muted-text">此入口创建独立快照知识库。受控目录同步只能经本机 CLI 显式绑定根目录；下方可通过浏览器导入 Markdown、PDF、DOCX、PPTX、XLSX 和图片文件夹快照。</p>
          </div>
        </div>
        <form action={createKnowledgeBaseAction}>
          <label className="field"><span>名称</span><input className="input" name="name" required /></label>
          <label className="field"><span>描述</span><textarea className="textarea small-textarea" name="description" /></label>
          <label className="field"><span>默认语言</span><input className="input" name="defaultLanguage" defaultValue="zh-CN" /></label>
          <button type="submit" className="button primary">创建知识库</button>
        </form>
      </section>
      <section className="workspace-section import-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">INGEST</p>
            <h3>浏览器目录导入</h3>
            <p className="muted-text">浏览器只提交所选文件及相对路径；此入口创建复制快照，不能用于已绑定同步根目录的知识库。</p>
          </div>
        </div>
        <BrowserDirectoryImportForm
          action={importBrowserDirectoryAction}
          knowledgeBases={knowledgeBases
            .filter((knowledgeBase) => knowledgeBase.id !== DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID && !knowledgeBase.syncRootPath)
            .map((knowledgeBase) => ({ id: knowledgeBase.id, name: knowledgeBase.name }))}
        />
      </section>
      <section className="workspace-section import-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">INGEST</p>
            <h3>浏览器多文件导入</h3>
            <p className="muted-text">一次选择多份文件上传到快照知识库；Markdown 直接读取，其它格式交给 MinerU 解析，同名文件自动追加序号。</p>
          </div>
        </div>
        <BrowserMultiFileImportForm
          action={importBrowserMultiFileAction}
          knowledgeBases={knowledgeBases
            .filter((knowledgeBase) => knowledgeBase.id !== DEVELOPMENT_DEMO_KNOWLEDGE_BASE_ID && !knowledgeBase.syncRootPath)
            .map((knowledgeBase) => ({ id: knowledgeBase.id, name: knowledgeBase.name }))}
        />
      </section>
    </div>
  );
}
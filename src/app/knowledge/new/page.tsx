import Link from "next/link";

import { createKnowledgeAction, importBrowserMultiFileAction } from "@/app/actions";
import { BrowserMultiFileImportForm } from "@/components/BrowserMultiFileImportForm";
import { KnowledgeForm } from "@/components/KnowledgeForm";
import { WebClippingForm } from "@/components/WebClippingForm";
import { getAvailableTags } from "@/lib/knowledge";
import { DEFAULT_KNOWLEDGE_BASE_ID, requireKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type NewKnowledgePageProps = { searchParams: Promise<{ knowledgeBaseId?: string }> };

export default async function NewKnowledgePage({ searchParams }: NewKnowledgePageProps) {
  const { knowledgeBaseId } = await searchParams;
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const availableTags = await getAvailableTags(knowledgeBase.id);
  const allowFileUpload = !knowledgeBase.syncRootPath;

  return (
    <div className="workspace-page new-knowledge-page">
      <header className="workspace-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">NEW KNOWLEDGE</p>
          <h2>新增知识</h2>
          <p className="muted-text">
            {knowledgeBase.syncRootPath
              ? "当前知识库已绑定同步根目录。请将文件放入同步根目录后，在“同步源”页重新扫描并手动同步；浏览器上传不会写入同步库。"
              : "当前知识库支持手动录入和单文件快照上传；文件会复制到当前知识库，不建立目录同步。需要批量导入时，请返回知识管理页使用文件夹快照上传。"}
          </p>
        </div>
        <div className="workspace-toolbar-actions">
          <Link href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
            返回列表
          </Link>
        </div>
      </header>

      <section className="workspace-section knowledge-form-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">ENTRY</p>
            <h3>手动录入</h3>
            <p className="muted-text">填写标题、正文与元数据创建知识条目；提交后立即生成切片供检索使用。</p>
          </div>
        </div>
        <KnowledgeForm action={createKnowledgeAction} submitLabel="创建知识条目" knowledgeBaseId={knowledgeBase.id} availableTags={availableTags} mode="create" allowFileUpload={allowFileUpload} />
      </section>

      {!knowledgeBase.syncRootPath ? (
        <section className="workspace-section import-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">INGEST</p>
              <h3>多文件批量上传</h3>
              <p className="muted-text">一次选择多份文件（Markdown、PDF、DOCX、PPTX、XLSX 和常见图片），提交后在后台任务中解析导入，可到任务中心查看进度或重试失败项。</p>
            </div>
          </div>
          <BrowserMultiFileImportForm action={importBrowserMultiFileAction} knowledgeBaseId={knowledgeBase.id} />
        </section>
      ) : null}

      {!knowledgeBase.syncRootPath ? (
        <section className="workspace-section import-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">WEB CLIPPING</p>
              <h3>网页剪藏</h3>
              <p className="muted-text">输入公开页面 URL 自动抓取，或粘贴 HTML；经内置裁剪核心转 Markdown 后直接入库。抓取由受限客户端执行，本机 / 内网地址一律拒绝。</p>
            </div>
          </div>
          <WebClippingForm knowledgeBaseId={knowledgeBase.id} />
        </section>
      ) : null}

      {knowledgeBase.syncRootPath ? (
        <Link href={`/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}/sync`} className="button secondary">
          打开同步源
        </Link>
      ) : knowledgeBase.id === DEFAULT_KNOWLEDGE_BASE_ID ? (
        <Link href="/knowledge-bases" className="button secondary">
          去知识库页批量导入
        </Link>
      ) : (
        <Link href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`} className="button secondary">
          返回知识管理并批量导入
        </Link>
      )}
    </div>
  );
}

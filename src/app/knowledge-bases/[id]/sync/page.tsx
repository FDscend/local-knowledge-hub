import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { resolveSyncConflictAction, saveKnowledgeBaseIgnoreRulesAction, syncKnowledgeBaseAction } from "@/app/actions";
import { AppAuxiliaryPanel } from "@/components/AppAuxiliaryPanel";
import { SyncFileTree, type SyncScanItem } from "@/components/SyncFileTree";
import { VectorIndexPanel } from "@/components/VectorIndexPanel";
import { getDirectoryIgnoreRules, previewDirectoryScan, type DirectoryScanItem } from "@/lib/directory-sync";
import { getEmbeddingIndexStatus } from "@/lib/embedding";
import { getKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type SyncPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ imported?: string; unchanged?: string; missing?: string; skipped?: string; errors?: string; conflicts?: string; rulesSaved?: string; selected?: string }>;
};

function statusLabel(status: string): string {
  switch (status) {
    case "READY":
      return "待同步";
    case "SYNCED":
      return "已同步";
    case "CHANGED":
      return "内容已变化";
    case "CONFLICT":
      return "冲突";
    case "MISSING":
      return "源文件缺失";
    case "IGNORED":
      return "已忽略";
    case "UNSUPPORTED":
      return "暂不支持";
    case "OUTSIDE_ROOT":
      return "已拒绝";
    default:
      return status;
  }
}

function formatTimestamp(value: Date | null): string {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(value) : "未记录";
}

function formatFileSize(value: number | null): string {
  if (value === null) {
    return "未记录";
  }
  if (value < 1_024) {
    return `${value} B`;
  }
  if (value < 1_024 * 1_024) {
    return `${(value / 1_024).toFixed(1)} KB`;
  }
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatHash(value: string | null): ReactNode {
  if (!value) {
    return "未记录";
  }
  return <code className="sync-hash" title={value}>{value}</code>;
}

function ruleExplanation(item: DirectoryScanItem): string {
  if (!item.matchedRule) {
    return "未命中规则";
  }
  if (item.matchedRuleSource === "system") {
    return `系统安全规则：${item.matchedRule}`;
  }
  const source = item.matchedRuleSource === "global" ? "全局规则" : "知识库规则";
  const outcome = item.matchedRuleInclude ? "重新纳入" : "忽略";
  return `${source}第 ${item.matchedRuleLine ?? "?"} 行：${outcome} ${item.matchedRule}`;
}

export default async function KnowledgeBaseSyncPage({ params, searchParams }: SyncPageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const knowledgeBase = await getKnowledgeBase(id);
  if (!knowledgeBase?.syncRootPath) {
    notFound();
  }

  const [items, rules, embeddingStatus] = await Promise.all([
    previewDirectoryScan(knowledgeBase.id),
    getDirectoryIgnoreRules(knowledgeBase.id),
    getEmbeddingIndexStatus(knowledgeBase.id),
  ]);
  const readyCount = items.filter((item) => item.status === "READY" || item.status === "CHANGED" || item.status === "SYNCED").length;
  const conflictCount = items.filter((item) => item.status === "CONFLICT").length;
  const ignoredCount = items.filter((item) => item.status === "IGNORED").length;
  const unsupportedCount = items.filter((item) => item.status === "UNSUPPORTED").length;
  const missingCount = items.filter((item) => item.status === "MISSING").length;
  const hasResult = [query.imported, query.unchanged, query.missing, query.skipped, query.errors, query.conflicts].some((value) => value !== undefined);
  const selectableItems = items.filter((item) => item.status === "READY" || item.status === "CHANGED" || item.status === "SYNCED");
  const selectablePaths = new Set(selectableItems.map((item) => item.relativePath));
  const selectedItem = query.selected ? (items.find((item) => item.relativePath === query.selected) ?? null) : null;
  // 树点击只替换 selected 参数，其余查询参数（knowledgeBaseId 等）原样保留
  const baseQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key !== "selected" && value !== undefined) {
      baseQuery.set(key, value);
    }
  }
  const baseQueryString = baseQuery.toString();
  const serializedItems: SyncScanItem[] = items.map((item) => ({
    relativePath: item.relativePath,
    status: item.status,
    matchedRule: item.matchedRule,
    matchedRuleSource: item.matchedRuleSource,
    matchedRuleLine: item.matchedRuleLine,
    matchedRuleInclude: item.matchedRuleInclude,
    sourceType: item.sourceType,
    documentId: item.documentId,
    contentHash: item.contentHash,
    documentContentHash: item.documentContentHash,
    documentUpdatedAt: item.documentUpdatedAt?.toISOString() ?? null,
    sourceFileHash: item.sourceFileHash,
    lastSeenAt: item.lastSeenAt?.toISOString() ?? null,
    fileSize: item.fileSize,
    lastModifiedAt: item.lastModifiedAt?.toISOString() ?? null,
  }));

  return (
    <div className="workspace-page sync-page">
      <header className="workspace-toolbar sync-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">SYNC SOURCE</p>
          <h2>同步源</h2>
          <p className="muted-text">
            {knowledgeBase.name} 读取受控根目录中的 Markdown、PDF、DOCX、PPTX、XLSX 和图片。同步始终创建受管快照；源文件缺失只会标记为缺失，不会删除知识库内容。解析类文件通过 MinerU 转为 Markdown。
          </p>
          <p className="field-helper">同步根目录：{knowledgeBase.syncRootPath}</p>
        </div>
        <div className="workspace-toolbar-actions">
          <Link className="button secondary" href="/knowledge-bases">
            返回知识库
          </Link>
          <Link className="button secondary" href={`/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>
            打开文档
          </Link>
        </div>
      </header>

      <div className="sync-layout">
        <div className="sync-main-column">
          {hasResult ? (
            <section className="banner">
              <strong>同步完成</strong>
              <span>
                新增或更新 {query.imported ?? "0"} 项，未变更 {query.unchanged ?? "0"} 项，源文件缺失 {query.missing ?? "0"} 项，冲突 {query.conflicts ?? "0"} 项，跳过 {query.skipped ?? "0"} 项，失败 {query.errors ?? "0"} 项。
              </span>
            </section>
          ) : null}
      {query.rulesSaved ? (
        <section className="banner">
          <strong>忽略规则已保存。</strong>
          <span>规则只影响后续扫描与同步，不会删除已有文档。</span>
        </section>
      ) : null}

      <section className="card-grid">
        <article className="stat-card">
          <p className="stat-label">可同步文件</p>
          <p className="stat-value">{readyCount}</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">冲突</p>
          <p className="stat-value">{conflictCount}</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">源文件缺失</p>
          <p className="stat-value">{missingCount}</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">规则 / 安全排除</p>
          <p className="stat-value">{ignoredCount}</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">暂不支持格式</p>
          <p className="stat-value">{unsupportedCount}</p>
        </article>
      </section>

      <form id="sync-form" action={syncKnowledgeBaseAction} className="workspace-section sync-execute-section">
        <input type="hidden" name="knowledgeBaseId" value={knowledgeBase.id} />
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">SYNC</p>
            <h3>执行同步</h3>
            <p className="muted-text">默认同步全部可同步条目。勾选后仅同步选中路径；内容哈希不变的文件不会重建切片。解析类文件仅在源文件哈希变化时重新解析。</p>
          </div>
        </div>
        <div className="inline-actions evaluation-controls">
          <label className="field compact-field">
            <span>MinerU 解析模式</span>
            <select className="input" name="mineruMode" defaultValue="light">
              <option value="light">轻量 MinerU</option>
              <option value="precise">精准 MinerU</option>
            </select>
          </label>
          <button type="submit" className="button primary">
            同步全部变更
          </button>
        </div>
        <div className="sync-selected-block">
          <h4>仅同步选中条目</h4>
          <p className="muted-text">在下方文件树点击条目名称，可在右侧面板查看规则溯源与哈希；勾选条目后同步。</p>
          <SyncFileTree
            knowledgeBaseId={knowledgeBase.id}
            items={serializedItems}
            selectablePaths={selectablePaths}
            selectedPath={query.selected ?? null}
            baseQuery={baseQueryString}
          />
          <button type="submit" className="button secondary">
            同步选中条目
          </button>
        </div>
      </form>

      {conflictCount > 0 ? (
        <section className="workspace-section sync-conflict-section">
          <div className="workspace-section-heading">
            <div>
              <p className="section-kicker">CONFLICTS</p>
              <h3>冲突处理</h3>
              <p className="muted-text">当源文件与知识库正文均已变化时，系统不会静默覆盖。可选择保留源、保留知识库，或从源文件新建独立文档。</p>
            </div>
          </div>
          <ul className="source-list">
            {items
              .filter((item) => item.status === "CONFLICT")
              .map((item) => (
                <li key={`conflict-${item.relativePath}`} className="sync-source-item" data-state="CONFLICT">
                  <strong>{item.relativePath}</strong>
                  <div className="inline-actions">
                    <form action={resolveSyncConflictAction}>
                      <input type="hidden" name="knowledgeBaseId" value={knowledgeBase.id} />
                      <input type="hidden" name="relativePath" value={item.relativePath} />
                      <input type="hidden" name="resolution" value="keep-source" />
                      <input type="hidden" name="mineruMode" value="light" />
                      <button type="submit" className="button primary">
                        保留源文件
                      </button>
                    </form>
                    <form action={resolveSyncConflictAction}>
                      <input type="hidden" name="knowledgeBaseId" value={knowledgeBase.id} />
                      <input type="hidden" name="relativePath" value={item.relativePath} />
                      <input type="hidden" name="resolution" value="keep-knowledge" />
                      <button type="submit" className="button secondary">
                        保留知识库
                      </button>
                    </form>
                    <form action={resolveSyncConflictAction}>
                      <input type="hidden" name="knowledgeBaseId" value={knowledgeBase.id} />
                      <input type="hidden" name="relativePath" value={item.relativePath} />
                      <input type="hidden" name="resolution" value="create-new" />
                      <input type="hidden" name="mineruMode" value="light" />
                      <button type="submit" className="button secondary">
                        新建文档
                      </button>
                    </form>
                    {item.documentId ? (
                      <Link className="button secondary" href={`/knowledge/${item.documentId}?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>
                        查看文档
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

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

      <form action={saveKnowledgeBaseIgnoreRulesAction} className="workspace-section sync-rules-section">
        <input type="hidden" name="knowledgeBaseId" value={knowledgeBase.id} />
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">RULES</p>
            <h3>忽略规则</h3>
            <p className="muted-text">每行一个模式，支持 *、?、**、以 / 开头的根目录相对路径和 ! 重新纳入。安全硬排除与同步根边界不能被重新纳入。</p>
          </div>
        </div>
        <label className="field">
          <span>全局规则</span>
          <textarea className="textarea small-textarea" name="globalRules" defaultValue={rules.global} placeholder="node_modules/\n*.tmp" />
        </label>
        <label className="field">
          <span>{knowledgeBase.name} 规则</span>
          <textarea className="textarea small-textarea" name="knowledgeBaseRules" defaultValue={rules.knowledgeBase} placeholder="archive/**\n!archive/keep.md" />
        </label>
        <button type="submit" className="button secondary">
          保存规则并重新预览
        </button>
      </form>

      <section className="workspace-section sync-preview-section">
        <div className="workspace-section-heading">
          <div>
            <p className="section-kicker">PREVIEW</p>
            <h3>文件树与规则溯源</h3>
            <p className="muted-text">点击条目名称可在右侧面板查看最终扫描状态、命中的规则来源与行号，以及最近记录的哈希、同步时间和关联文档。</p>
          </div>
        </div>
        <SyncFileTree
          knowledgeBaseId={knowledgeBase.id}
          items={serializedItems}
          selectedPath={query.selected ?? null}
          baseQuery={baseQueryString}
        />
      </section>
        </div>
        {selectedItem ? (
          <AppAuxiliaryPanel kicker="FILE DETAIL" title={selectedItem.relativePath} note={statusLabel(selectedItem.status)}>
            <dl className="sync-detail-grid">
              <div><dt>最终状态</dt><dd>{statusLabel(selectedItem.status)}</dd></div>
              <div><dt>规则溯源</dt><dd>{ruleExplanation(selectedItem)}</dd></div>
              <div><dt>文件类型</dt><dd>{selectedItem.sourceType ?? "目录或不支持格式"}</dd></div>
              <div><dt>文件大小</dt><dd>{formatFileSize(selectedItem.fileSize)}</dd></div>
              <div><dt>文件修改时间</dt><dd>{formatTimestamp(selectedItem.lastModifiedAt)}</dd></div>
              <div><dt>扫描内容哈希</dt><dd>{formatHash(selectedItem.contentHash)}</dd></div>
              <div><dt>源文件哈希</dt><dd>{formatHash(selectedItem.sourceFileHash)}</dd></div>
              <div><dt>知识库正文哈希</dt><dd>{formatHash(selectedItem.documentContentHash)}</dd></div>
              <div><dt>最近同步时间</dt><dd>{formatTimestamp(selectedItem.lastSeenAt)}</dd></div>
              <div><dt>知识库版本时间</dt><dd>{formatTimestamp(selectedItem.documentUpdatedAt)}</dd></div>
            </dl>
            <div className="inline-actions">
              {selectablePaths.has(selectedItem.relativePath) ? (
                <label className="sync-select-control">
                  <input type="checkbox" name="selectedPaths" value={selectedItem.relativePath} form="sync-form" />
                  选中同步
                </label>
              ) : null}
              {selectedItem.documentId ? (
                <Link className="button secondary" href={`/knowledge/${selectedItem.documentId}?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>
                  查看关联文档
                </Link>
              ) : null}
            </div>
          </AppAuxiliaryPanel>
        ) : null}
      </div>
    </div>
  );
}

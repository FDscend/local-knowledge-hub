"use client";

import { DocumentStatus, IngestMode, SourceType } from "@prisma/client";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import { useApiKeySettings } from "@/components/ApiKeySettingsProvider";
import { sourceTypeLabels, statusLabels } from "@/lib/knowledge-ui";
import { RUNTIME_LLM_API_KEY_HEADER, RUNTIME_LLM_BASE_URL_HEADER, RUNTIME_LLM_MODEL_HEADER } from "@/lib/runtime-keys";

export type KnowledgeFormDefaults = {
  title: string;
  summary: string;
  tagsText: string;
  domain: string;
  sourceType: SourceType;
  sourcePath: string;
  sourceUrl: string;
  status: DocumentStatus;
  ingestMode: IngestMode;
  content: string;
};

type MetadataSuggestionResponse = {
  summary: string;
  frontmatterTags: string[];
  candidateTags: string[];
  existingTags: string[];
  mode: "llm" | "fallback";
  error?: string;
};

type KnowledgeFormClientProps = {
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  defaults: KnowledgeFormDefaults;
  availableTags: string[];
  autoSuggestOnMount?: boolean;
  mode: "create" | "edit";
  knowledgeBaseId: string;
  allowFileUpload: boolean;
};

type SuggestionRequestOptions = {
  mode: "auto" | "summary" | "tags";
  applySummary: boolean;
  applyTags: boolean;
};

function normalizeTags(tagsText: string): string[] {
  return Array.from(
    new Set(
      tagsText
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function formatTags(tags: string[]): string {
  return normalizeTags(tags.join(", ")).join(", ");
}

function getAutoTitleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim();
}

function getUploadSourcePath(fileName: string): string {
  return fileName ? `upload/${fileName}` : "";
}

function isMineruSourceType(sourceType: SourceType): boolean {
  const mineruSourceTypes: SourceType[] = [SourceType.PDF, SourceType.DOCX, SourceType.PPTX, SourceType.XLSX, SourceType.IMAGE];
  return mineruSourceTypes.includes(sourceType);
}

function getFileAccept(sourceType: SourceType): string | undefined {
  if (sourceType === SourceType.PDF) {
    return ".pdf,application/pdf";
  }
  if (sourceType === SourceType.DOCX) {
    return ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (sourceType === SourceType.PPTX) {
    return ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (sourceType === SourceType.XLSX) {
    return ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (sourceType === SourceType.IMAGE) {
    return ".png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp,image/png,image/jpeg,image/jp2,image/webp,image/gif,image/bmp";
  }

  if (sourceType === SourceType.MD || sourceType === SourceType.CLIPPING) {
    return ".md,.markdown,text/markdown,text/plain";
  }

  return undefined;
}

type SubmitButtonProps = {
  submitLabel: string;
  sourceType: SourceType;
  isPreciseMineruWithoutKey: boolean;
};

function SubmitButton({ submitLabel, sourceType, isPreciseMineruWithoutKey }: SubmitButtonProps) {
  const { pending } = useFormStatus();

  const pendingLabel = isMineruSourceType(sourceType) ? "正在调用 MinerU 解析，请稍候..." : "正在导入，请稍候...";

  return (
    <button type="submit" className="button primary" disabled={isPreciseMineruWithoutKey || pending}>
      {pending ? pendingLabel : submitLabel}
    </button>
  );
}

type ImportPendingOverlayProps = {
  isFileImportType: boolean;
  sourceType: SourceType;
};

function ImportPendingOverlay({ isFileImportType, sourceType }: ImportPendingOverlayProps) {
  const { pending } = useFormStatus();

  if (!pending || !isFileImportType) {
    return null;
  }

  return (
    <div className="import-pending-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="import-pending-card">
        <span className="import-spinner" aria-hidden="true" />
        <p>{isMineruSourceType(sourceType) ? "MinerU 正在解析文件并生成可检索正文..." : "正在读取文件并切片入库..."}</p>
      </div>
    </div>
  );
}

export function KnowledgeFormClient({
  action,
  submitLabel,
  defaults,
  availableTags,
  autoSuggestOnMount = false,
  mode,
  knowledgeBaseId,
  allowFileUpload,
}: KnowledgeFormClientProps) {
  const { llmApiKey, llmBaseURL, llmModel, mineruApiKey, hasMineruKey, openApiKeySettings } = useApiKeySettings();
  const [title, setTitle] = useState(defaults.title);
  const [domain, setDomain] = useState(defaults.domain);
  const [sourceType, setSourceType] = useState(allowFileUpload ? defaults.sourceType : SourceType.MANUAL);
  const [content, setContent] = useState(defaults.content);
  const [summary, setSummary] = useState(defaults.summary);
  const [tagsText, setTagsText] = useState(defaults.tagsText);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [mineruMode, setMineruMode] = useState<"light" | "precise">("light");
  const [frontmatterTags, setFrontmatterTags] = useState<string[]>([]);
  const [candidateTags, setCandidateTags] = useState<string[]>([]);
  const [suggestionMode, setSuggestionMode] = useState<"llm" | "fallback" | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [isSuggesting, startSuggestion] = useTransition();
  const [pendingTarget, setPendingTarget] = useState<"summary" | "tags" | null>(null);
  const [summaryTouched, setSummaryTouched] = useState(Boolean(defaults.summary.trim()));
  const requestCounterRef = useRef(0);
  const lastAutoKeyRef = useRef<string>("");
  const lastSuggestedSummaryRef = useRef(defaults.summary);
  const lastAutoTitleRef = useRef("");

  const isCreateMode = mode === "create";
  const isFileImportType = isCreateMode && (sourceType === SourceType.MD || sourceType === SourceType.CLIPPING || isMineruSourceType(sourceType));
  const fileAccept = getFileAccept(sourceType);
  const sourcePathPreview = selectedFileName ? getUploadSourcePath(selectedFileName) : defaults.sourcePath;
  const isPreciseMineruWithoutKey = isCreateMode && isMineruSourceType(sourceType) && mineruMode === "precise" && !hasMineruKey;
  const canUseMetadataAssist = !isFileImportType;

  const selectedTags = useMemo(() => new Set(normalizeTags(tagsText)), [tagsText]);
  const displayCandidateTags = useMemo(
    () => candidateTags.filter((tag) => !frontmatterTags.includes(tag)),
    [candidateTags, frontmatterTags],
  );

  const suggestionKey = `${title.trim()}::${domain.trim()}::${content.trim()}`;

  const applyTag = (tag: string) => {
    const nextTags = formatTags([...selectedTags, tag]);
    setTagsText(nextTags);
  };

  const requestSuggestions = (options: SuggestionRequestOptions) => {
    const trimmedContent = content.trim();
    if (trimmedContent.length < 80) {
      return;
    }

    const requestId = requestCounterRef.current + 1;
    requestCounterRef.current = requestId;
    setSuggestionError(null);
    setPendingTarget(options.mode === "auto" ? null : options.mode);

    startSuggestion(() => {
      void (async () => {
        try {
          const headers: HeadersInit = {
            "Content-Type": "application/json",
          };

          if (llmApiKey) {
            headers[RUNTIME_LLM_API_KEY_HEADER] = llmApiKey;
          }
          if (llmBaseURL) {
            headers[RUNTIME_LLM_BASE_URL_HEADER] = llmBaseURL;
          }
          if (llmModel) {
            headers[RUNTIME_LLM_MODEL_HEADER] = llmModel;
          }

          const response = await fetch("/api/knowledge-metadata", {
            method: "POST",
            headers,
            body: JSON.stringify({
              title,
              domain,
              content: trimmedContent,
            }),
          });

          const payload = (await response.json()) as MetadataSuggestionResponse;

          if (!response.ok) {
            throw new Error(payload.error || "元数据生成失败。");
          }

          if (requestCounterRef.current !== requestId) {
            return;
          }

          setFrontmatterTags(payload.frontmatterTags);
          setSuggestionMode(payload.mode);

          if (options.applyTags) {
            setCandidateTags(payload.candidateTags);
            if (payload.frontmatterTags.length > 0) {
              setTagsText((current) => formatTags([...normalizeTags(current), ...payload.frontmatterTags]));
            }
          }

          if (options.applySummary && (options.mode === "summary" || options.mode === "auto" || !summaryTouched || !summary.trim() || summary === lastSuggestedSummaryRef.current)) {
            setSummary(payload.summary);
            lastSuggestedSummaryRef.current = payload.summary;
            if (options.mode === "summary") {
              setSummaryTouched(false);
            }
          }
        } catch (error) {
          if (requestCounterRef.current !== requestId) {
            return;
          }

          setSuggestionError(error instanceof Error ? error.message : "元数据生成失败。");
        } finally {
          if (requestCounterRef.current === requestId) {
            setPendingTarget(null);
          }
        }
      })();
    });
  };

  const requestAutoSuggestions = useEffectEvent(() => {
    requestSuggestions({
      mode: "auto",
      applySummary: true,
      applyTags: true,
    });
  });

  useEffect(() => {
    if (!autoSuggestOnMount || !canUseMetadataAssist) {
      return;
    }

    if (content.trim().length < 80) {
      return;
    }

    if (lastAutoKeyRef.current === suggestionKey) {
      return;
    }

    const timer = window.setTimeout(() => {
      lastAutoKeyRef.current = suggestionKey;
      requestAutoSuggestions();
    }, 900);

    return () => {
      window.clearTimeout(timer);
    };
  }, [autoSuggestOnMount, canUseMetadataAssist, content, suggestionKey]);

  return (
    <form action={action} className="stack-panel form-panel form-with-pending-state">
      <div className="two-column-grid">
        <label className="field">
          <span>标题</span>
          <input className="input" name="title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        </label>

        <label className="field">
          <span>主题域</span>
          <input className="input" name="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="可选，例如 image-restoration" />
        </label>

        <label className="field">
          <span>来源类型</span>
          <select
            className="input"
            name="sourceType"
            value={sourceType}
            onChange={(event) => {
              const nextSourceType = event.target.value as SourceType;
              setSourceType(nextSourceType);

              if (mode === "edit" || (nextSourceType !== SourceType.MD && nextSourceType !== SourceType.CLIPPING && !isMineruSourceType(nextSourceType))) {
                setSelectedFileName("");
              }
            }}
          >
            {Object.entries(sourceTypeLabels).filter(([value]) => allowFileUpload || value === SourceType.MANUAL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>状态</span>
          <select className="input" name="status" defaultValue={defaults.status}>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="field field-full">
          <div className="field-header">
            <span>标签</span>
            {canUseMetadataAssist ? (
              <button
                type="button"
                className="field-button"
                onClick={() =>
                  requestSuggestions({
                    mode: "tags",
                    applySummary: false,
                    applyTags: true,
                  })
                }
                disabled={isSuggesting || content.trim().length < 80}
              >
                {pendingTarget === "tags" ? "生成中..." : "同步 YAML / 生成候选"}
              </button>
            ) : null}
          </div>
          <input className="input" name="tagsText" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="可选，多个标签用逗号分隔" />
          <p className="field-helper">
            {canUseMetadataAssist
              ? `当前标签词表：${availableTags.length} 个。摘要生成模式：${suggestionMode === "llm" ? "LLM" : suggestionMode === "fallback" ? "回退" : "未生成"}`
              : "文件导入时可手动补充标签；Markdown frontmatter tags 会在提交后自动并入。"}
          </p>
          {canUseMetadataAssist && frontmatterTags.length > 0 ? <p className="field-helper">已从 YAML 自动识别并写入：{frontmatterTags.join("、")}</p> : null}
          {suggestionError ? <p className="error-text">{suggestionError}</p> : null}
          {canUseMetadataAssist && displayCandidateTags.length > 0 ? (
            <div className="stack-panel compact-panel tag-suggestion-panel">
              <strong>候选标签</strong>
              <div className="pill-row">
                {displayCandidateTags.map((tag) => {
                  const isExisting = availableTags.includes(tag);
                  return (
                    <button key={`candidate-${tag}`} type="button" className="pill interactive-pill" onClick={() => applyTag(tag)} disabled={selectedTags.has(tag)}>
                      {selectedTags.has(tag) ? `${tag} · 已添加` : isExisting ? `${tag} · 复用现有` : tag}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </label>

        {isFileImportType ? (
          <label className="field field-full upload-field">
            <span>{isMineruSourceType(sourceType) ? "选择待解析文件" : "选择 Markdown / Clipping 文件"}</span>
            <input
              className="input"
              type="file"
              name="file"
              accept={fileAccept}
              required
              onChange={(event) => {
                const file = event.target.files?.[0];
                const nextFileName = file?.name || "";
                setSelectedFileName(nextFileName);

                if (!nextFileName) {
                  return;
                }

                const nextTitle = getAutoTitleFromFileName(nextFileName);
                setTitle((current) => {
                  if (!current.trim() || current === lastAutoTitleRef.current) {
                    lastAutoTitleRef.current = nextTitle;
                    return nextTitle;
                  }
                  return current;
                });
              }}
            />
            <p className="field-helper">当前只允许一次上传一份文件。来源路径会自动保存为 {sourcePathPreview || "upload/文件名"}。</p>
          </label>
        ) : (
          <label className="field field-full">
            <span>来源路径</span>
            <input className="input" name="sourcePath" defaultValue={defaults.sourcePath} required />
          </label>
        )}

        {isCreateMode && isMineruSourceType(sourceType) ? (
          <fieldset className="field field-full upload-mode-group">
            <legend>MinerU 解析方式</legend>
            <label className="choice-card">
              <input type="radio" name="mineruMode" value="light" checked={mineruMode === "light"} onChange={() => setMineruMode("light")} />
              <div>
                <strong>轻量 MinerU</strong>
                <p className="field-helper">默认模式，无需登录或 API Key，适合 10MB 以内、20 页以内的快速解析。</p>
              </div>
            </label>
            <label className="choice-card">
              <input
                type="radio"
                name="mineruMode"
                value="precise"
                checked={mineruMode === "precise"}
                onChange={() => {
                  if (!hasMineruKey) {
                    setMineruMode("light");
                    openApiKeySettings("mineru");
                    return;
                  }

                  setMineruMode("precise");
                }}
              />
              <div>
                <strong>精准 MinerU</strong>
                <p className="field-helper">使用官方精准解析 API，支持更复杂的 PDF、Office 文件和图片；需要先配置 MINERU_API_KEY。</p>
              </div>
            </label>
            {isPreciseMineruWithoutKey ? (
              <p className="error-text">
                当前尚未配置 MinerU API Key。请先在
                <button type="button" className="inline-link-button" onClick={() => openApiKeySettings("mineru")}>
                  API 设置
                </button>
                中补齐，再切换到精准模式。
              </p>
            ) : null}
          </fieldset>
        ) : null}

        <label className="field field-full">
          <span>来源链接</span>
          <input className="input" name="sourceUrl" defaultValue={defaults.sourceUrl} placeholder="可选" />
        </label>

        <label className="field field-full">
          <div className="field-header">
            <span>摘要</span>
            {canUseMetadataAssist ? (
              <button
                type="button"
                className="field-button"
                onClick={() =>
                  requestSuggestions({
                    mode: "summary",
                    applySummary: true,
                    applyTags: false,
                  })
                }
                disabled={isSuggesting || content.trim().length < 80}
              >
                {pendingTarget === "summary" ? "生成中..." : "重新生成摘要"}
              </button>
            ) : null}
          </div>
          <textarea
            className="textarea small-textarea"
            name="summary"
            value={summary}
            onChange={(event) => {
              setSummary(event.target.value);
              setSummaryTouched(true);
            }}
            placeholder={canUseMetadataAssist ? "将自动调用模型生成摘要，也可以手动覆盖。" : "可选。留空时会在导入完成后自动生成摘要。"}
          />
        </label>

        {!isFileImportType ? (
          <label className="field field-full">
            <span>正文</span>
            <textarea className="textarea large-textarea" name="content" value={content} onChange={(event) => setContent(event.target.value)} required />
          </label>
        ) : (
          <div className="field field-full upload-helper-card">
            <span>导入说明</span>
            <p className="field-helper">
              {isMineruSourceType(sourceType)
                ? "文件提交后会先交给 MinerU 转成 Markdown，再自动生成摘要并切片入库。"
                : "Markdown / Clipping 提交后会自动读取 frontmatter、正文与标题结构，并按标题切片入库。"}
            </p>
          </div>
        )}
      </div>

      {isFileImportType ? <input type="hidden" name="sourcePath" value={sourcePathPreview} /> : null}
      <input type="hidden" name="runtimeLlmApiKey" value={llmApiKey} />
      <input type="hidden" name="knowledgeBaseId" value={knowledgeBaseId} />
      <input type="hidden" name="runtimeLlmBaseUrl" value={llmBaseURL} />
      <input type="hidden" name="runtimeLlmModel" value={llmModel} />
      <input type="hidden" name="runtimeMineruApiKey" value={mineruApiKey} />
      <input type="hidden" name="ingestMode" value={isFileImportType ? IngestMode.HEADING_CHUNKS : defaults.ingestMode} />
      <SubmitButton submitLabel={submitLabel} sourceType={sourceType} isPreciseMineruWithoutKey={isPreciseMineruWithoutKey} />
      <ImportPendingOverlay isFileImportType={isFileImportType} sourceType={sourceType} />
    </form>
  );
}
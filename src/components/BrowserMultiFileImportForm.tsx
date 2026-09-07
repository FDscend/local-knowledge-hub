"use client";

import { useState } from "react";

import { useApiKeySettings } from "@/components/ApiKeySettingsProvider";

type BrowserMultiFileImportFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  /** 固定目标库（例如新增知识页按当前库导入）；不传时显示目标库下拉。 */
  knowledgeBaseId?: string;
  knowledgeBases?: Array<{ id: string; name: string }>;
};

export function BrowserMultiFileImportForm({ action, knowledgeBaseId, knowledgeBases = [] }: BrowserMultiFileImportFormProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [mineruMode, setMineruMode] = useState<"light" | "precise">("light");
  const { mineruApiKey, openApiKeySettings } = useApiKeySettings();

  const selectFiles = (files: FileList | null) => {
    setSelectedFiles(Array.from(files ?? []).slice(0, 200));
  };

  const duplicateNames = selectedFiles.length > 0 && new Set(selectedFiles.map((file) => file.name)).size !== selectedFiles.length;

  return (
    <form action={action} className="stack-panel form-panel">
      <h2>多文件批量上传</h2>
      <p className="muted-text">一次选择多份文件（Markdown、PDF、DOCX、PPTX、XLSX 和常见图片），无需整个文件夹；提交后在后台任务中解析导入，可随时到任务中心查看进度或重试失败项。</p>
      {knowledgeBaseId ? null : (
        <label className="field">
          <span>目标快照知识库</span>
          <select className="input" name="knowledgeBaseId" required>
            {knowledgeBases.map((knowledgeBase) => (
              <option key={knowledgeBase.id} value={knowledgeBase.id}>
                {knowledgeBase.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {knowledgeBaseId ? <input type="hidden" name="knowledgeBaseId" value={knowledgeBaseId} /> : null}
      <label className="field">
        <span>选择文件（可多选）</span>
        <input
          className="input"
          type="file"
          name="files"
          multiple
          accept=".md,.markdown,.pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
          onChange={(event) => selectFiles(event.target.files)}
        />
        <p className="field-helper">
          {selectedFiles.length > 0
            ? `已选择 ${selectedFiles.length} 份文件；单次上限为 200 份。${duplicateNames ? "存在同名文件，服务端会自动追加序号区分。" : ""}Markdown 直接读取，其它格式交给 MinerU。`
            : "单次上限为 200 份。Markdown 直接读取，其它格式交给 MinerU。"}
        </p>
      </label>
      <label className="field">
        <span>MinerU 解析模式</span>
        <select className="input" name="mineruMode" value={mineruMode} onChange={(event) => setMineruMode(event.target.value as "light" | "precise")}>
          <option value="light">轻量 MinerU（免登录，适合预览）</option>
          <option value="precise">精准 MinerU（extract + VLM，需 API Key）</option>
        </select>
      </label>
      {mineruMode === "precise" && !mineruApiKey ? (
        <p className="field-helper">
          精准模式需要 MinerU API Key：<button type="button" className="button secondary" onClick={() => openApiKeySettings("mineru")}>设置 MinerU Key</button>
        </p>
      ) : null}
      <button type="submit" className="button primary" disabled={selectedFiles.length === 0}>
        提交批量上传（{selectedFiles.length} 份）
      </button>
    </form>
  );
}

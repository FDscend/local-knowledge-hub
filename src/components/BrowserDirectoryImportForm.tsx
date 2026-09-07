"use client";

import { useState } from "react";

import { useApiKeySettings } from "@/components/ApiKeySettingsProvider";

type BrowserDirectoryImportFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  knowledgeBases: Array<{ id: string; name: string }>;
  returnTo?: "knowledge" | "knowledge-bases";
};

export function BrowserDirectoryImportForm({ action, knowledgeBases, returnTo = "knowledge-bases" }: BrowserDirectoryImportFormProps) {
  const [fileCount, setFileCount] = useState(0);
  const [relativePaths, setRelativePaths] = useState<string[]>([]);
  const [mineruMode, setMineruMode] = useState<"light" | "precise">("light");
  const { mineruApiKey, openApiKeySettings } = useApiKeySettings();

  if (knowledgeBases.length === 0) {
    return <p className="muted-text">请先创建一个独立快照知识库，再通过浏览器选择文件夹上传。</p>;
  }

  return (
    <form action={action} className="stack-panel form-panel">
      <h2>浏览器目录上传</h2>
      <p className="muted-text">浏览器只提交所选文件及相对路径；此入口创建复制快照，不能用于已绑定同步根目录的知识库。支持 Markdown、PDF、DOCX、PPTX、XLSX 和常见图片（MinerU 解析）。</p>
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
      <label className="field">
        <span>知识文件夹</span>
        <input
          className="input"
          name="files"
          type="file"
          accept=".md,.markdown,.pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
          multiple
          required
          // @ts-expect-error Chromium directory selection attributes are not yet in React's DOM typings.
          webkitdirectory=""
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            setFileCount(files.length);
            setRelativePaths(files.map((file) => file.webkitRelativePath || file.name));
          }}
        />
        <small className="field-helper">已选择 {fileCount} 份文件；单次上限为 200 份。Markdown 直接读取，其它格式交给 MinerU。</small>
      </label>
      <input type="hidden" name="returnTo" value={returnTo} />
      {relativePaths.map((relativePath, index) => (
        <input key={`${relativePath}-${index}`} type="hidden" name="relativePaths" value={relativePath} />
      ))}
      <label className="field">
        <span>MinerU 解析模式</span>
        <select className="input" name="mineruMode" value={mineruMode} onChange={(event) => setMineruMode(event.target.value as "light" | "precise")}>
          <option value="light">轻量 MinerU（免登录，适合预览）</option>
          <option value="precise">精准 MinerU（extract + VLM，需 API Key）</option>
        </select>
      </label>
      <input type="hidden" name="runtimeMineruApiKey" value={mineruApiKey} />
      {mineruMode === "precise" && !mineruApiKey ? (
        <p className="field-helper">
          精准模式需要 MinerU API Key。{" "}
          <button type="button" className="button secondary" onClick={() => openApiKeySettings("mineru")}>
            打开 API 设置
          </button>
        </p>
      ) : null}
      <button type="submit" className="button primary" disabled={mineruMode === "precise" && !mineruApiKey}>
        导入文件夹快照
      </button>
    </form>
  );
}

import { DocumentStatus, IngestMode, SourceType, type KnowledgeDocument } from "@prisma/client";

import { KnowledgeFormClient, type KnowledgeFormDefaults } from "@/components/KnowledgeFormClient";

export type KnowledgeFormMode = "create" | "edit";

type KnowledgeFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  document?: KnowledgeDocument | null;
  knowledgeBaseId: string;
  availableTags: string[];
  mode?: KnowledgeFormMode;
  allowFileUpload?: boolean;
};

export function KnowledgeForm({ action, submitLabel, document, knowledgeBaseId, availableTags, mode = "create", allowFileUpload = true }: KnowledgeFormProps) {
  const defaults: KnowledgeFormDefaults = {
    title: document?.title ?? "",
    summary: document?.summary ?? "",
    tagsText: document?.tagsText ?? "",
    domain: document?.domain ?? "",
    sourceType: document?.sourceType ?? SourceType.MANUAL,
    sourcePath: document?.sourcePath ?? "manual/new-entry.md",
    sourceUrl: document?.sourceUrl ?? "",
    status: document?.status ?? DocumentStatus.ACTIVE,
    ingestMode: document?.ingestMode ?? IngestMode.SMALL_NOTE,
    content: document?.content ?? "",
  };

  return (
    <KnowledgeFormClient
      action={action}
      submitLabel={submitLabel}
      defaults={defaults}
      availableTags={availableTags}
      autoSuggestOnMount={!document}
      mode={mode}
      knowledgeBaseId={knowledgeBaseId}
      allowFileUpload={allowFileUpload}
    />
  );
}

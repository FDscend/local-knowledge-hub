"use client";

import { useEffect, useRef, useState } from "react";

type KnowledgeBaseOption = {
  id: string;
  name: string;
  kind: "INBOX" | "DEVELOPMENT" | "SYNC" | "SNAPSHOT";
  documentCount: number;
};

function getKnowledgeBaseKindLabel(kind: KnowledgeBaseOption["kind"]): string {
  switch (kind) {
    case "INBOX":
      return "默认收件箱";
    case "DEVELOPMENT":
      return "开发数据";
    case "SYNC":
      return "同步库";
    default:
      return "快照库";
  }
}

// 自绘知识库切换器：原生 select 的弹出层无法定制样式，改为按钮 + 自绘列表，
// 切换仍通过现有 knowledgeBaseId URL 参数完成。
export function KnowledgeBaseSwitcher({
  knowledgeBases,
  currentId,
  disabled,
  onChange,
}: {
  knowledgeBases: KnowledgeBaseOption[];
  currentId: string;
  disabled: boolean;
  onChange: (knowledgeBaseId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = knowledgeBases.find((knowledgeBase) => knowledgeBase.id === currentId) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function select(knowledgeBaseId: string) {
    setOpen(false);
    if (knowledgeBaseId !== currentId) {
      onChange(knowledgeBaseId);
    }
  }

  return (
    <div className="knowledge-base-switcher" ref={rootRef}>
      <button
        type="button"
        className="knowledge-base-switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="切换当前知识库"
        title="切换当前知识库"
        disabled={disabled}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <span className="knowledge-base-switcher-value">
          {current?.name ?? (knowledgeBases.length === 0 ? "加载知识库…" : "选择知识库")}
        </span>
        <span className="knowledge-base-switcher-caret" aria-hidden="true">
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {open ? (
        <ul className="knowledge-base-switcher-menu" role="listbox" aria-label="知识库列表">
          {knowledgeBases.map((knowledgeBase) => (
            <li key={knowledgeBase.id} role="option" aria-selected={knowledgeBase.id === currentId}>
              <button
                type="button"
                className={`knowledge-base-switcher-option${knowledgeBase.id === currentId ? " is-active" : ""}`}
                onClick={() => select(knowledgeBase.id)}
              >
                <span className="knowledge-base-switcher-name">{knowledgeBase.name}</span>
                <span className="knowledge-base-switcher-kind">
                  {getKnowledgeBaseKindLabel(knowledgeBase.kind)} · {knowledgeBase.documentCount} 文档
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

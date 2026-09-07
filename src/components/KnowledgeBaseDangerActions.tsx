"use client";

import { useState } from "react";

import { clearKnowledgeBaseAction, deleteKnowledgeBaseAction } from "@/app/actions";

type KnowledgeBaseDangerActionsProps = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  canClear: boolean;
  canDelete: boolean;
};

type PendingAction = "clear" | "delete" | null;

export function KnowledgeBaseDangerActions({ knowledgeBaseId, knowledgeBaseName, canClear, canDelete }: KnowledgeBaseDangerActionsProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  if (!canClear && !canDelete) {
    return null;
  }

  const isDeleting = pendingAction === "delete";
  const actionLabel = isDeleting ? "删除知识库" : "清空内容";
  const description = isDeleting
    ? "将删除知识库记录及其库级受管目录。不会修改原始导入文件或同步根目录。"
    : "将删除此库的文档、切片、版本、来源、受管对象和导入记录，但保留知识库本身及其配置目录。不会修改原始导入文件或同步根目录。";

  return (
    <div className="knowledge-base-danger-actions">
      {canClear ? (
        <button type="button" className="button danger" onClick={() => setPendingAction("clear")}>
          清空内容
        </button>
      ) : null}
      {canDelete ? (
        <button type="button" className="button danger" onClick={() => setPendingAction("delete")}>
          删除知识库
        </button>
      ) : null}

      {pendingAction ? (
        <div className="danger-confirmation" role="alertdialog" aria-modal="true" aria-labelledby={`danger-title-${knowledgeBaseId}`}>
          <div className="danger-confirmation-content">
            <h3 id={`danger-title-${knowledgeBaseId}`}>确认{actionLabel}</h3>
            <p>{description}</p>
            <p>
              请输入 <strong>{knowledgeBaseName}</strong> 以确认。
            </p>
            <form action={isDeleting ? deleteKnowledgeBaseAction : clearKnowledgeBaseAction} className="stack-panel compact-panel">
              <input type="hidden" name="knowledgeBaseId" value={knowledgeBaseId} />
              <label className="field">
                <span>知识库名称</span>
                <input className="input" name="confirmationName" autoComplete="off" required />
              </label>
              <div className="inline-actions">
                <button type="submit" className="button danger">
                  确认{actionLabel}
                </button>
                <button type="button" className="button secondary" onClick={() => setPendingAction(null)}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

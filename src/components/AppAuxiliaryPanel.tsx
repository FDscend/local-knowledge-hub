import type { ReactNode } from "react";

// 右侧辅助面板插槽：只接收页面传入的内容，不自行猜测页面状态；
// 无内容时不渲染（由使用方在数据为空时收起）。
export function AppAuxiliaryPanel({
  kicker,
  title,
  note,
  children,
  className = "",
}: {
  kicker?: string;
  title: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside className={`auxiliary-panel${className ? ` ${className}` : ""}`} aria-label={title}>
      <header className="auxiliary-panel-heading">
        <div>
          {kicker ? <p className="section-kicker">{kicker}</p> : null}
          <h3>{title}</h3>
        </div>
        {note ? <span className="workspace-section-note">{note}</span> : null}
      </header>
      <div className="auxiliary-panel-body">{children}</div>
    </aside>
  );
}

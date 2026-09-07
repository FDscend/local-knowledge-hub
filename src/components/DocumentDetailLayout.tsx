"use client";

import { useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { documentPanelWidthStore } from "@/lib/panel-width";

// 文档详情页三栏布局：主列 + 可拖拽右侧辅助栏（元数据 + 切片预览）。
// 宽度变量设置在 grid 容器上，持久化到 localStorage。
export function DocumentDetailLayout({ main, side }: { main: ReactNode; side: ReactNode }) {
  const panelWidth = useSyncExternalStore(documentPanelWidthStore.subscribe, documentPanelWidthStore.read, documentPanelWidthStore.getServer);
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function handleResizeStart(event: React.PointerEvent<HTMLDivElement>): void {
    resizeStartRef.current = { startX: event.clientX, startWidth: panelWidth };
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizeMove(event: React.PointerEvent<HTMLDivElement>): void {
    const start = resizeStartRef.current;
    if (!start) {
      return;
    }
    // resizer 位于辅助栏左边缘：向右拖表示面板变窄
    documentPanelWidthStore.update(start.startWidth - (event.clientX - start.startX));
  }

  function handleResizeEnd(event: React.PointerEvent<HTMLDivElement>): void {
    if (resizeStartRef.current) {
      resizeStartRef.current = null;
      setResizing(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      documentPanelWidthStore.update(panelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      documentPanelWidthStore.update(panelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      documentPanelWidthStore.update(documentPanelWidthStore.max);
    } else if (event.key === "End") {
      event.preventDefault();
      documentPanelWidthStore.update(documentPanelWidthStore.min);
    }
  }

  return (
    <div
      className={`document-detail-layout${resizing ? " is-panel-resizing" : ""}`}
      style={{ "--auxiliary-panel-width": `${panelWidth}px` } as CSSProperties}
    >
      <div className="document-main-column">{main}</div>
      <div
        className={`document-panel-resizer${resizing ? " is-resizing" : ""}`}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="调整辅助面板宽度"
        aria-valuemin={documentPanelWidthStore.min}
        aria-valuemax={documentPanelWidthStore.max}
        aria-valuenow={panelWidth}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        onKeyDown={handleResizeKeyDown}
      />
      <aside className="document-side-column" aria-label="文档辅助信息">
        {side}
      </aside>
    </div>
  );
}

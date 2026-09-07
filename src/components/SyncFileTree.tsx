"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

// 与 server 端 DirectoryScanItem 对应的可序列化快照（日期已转为 ISO 字符串）。
// 树条目只负责选中交互；详情统一由右侧辅助面板（server 端）按 selected 参数渲染。
export type SyncScanItem = {
  relativePath: string;
  status: string;
  matchedRule: string | null;
  matchedRuleSource: "global" | "knowledgeBase" | "system" | null;
  matchedRuleLine: number | null;
  matchedRuleInclude: boolean | null;
  sourceType: string | null;
  documentId: string | null;
  contentHash: string | null;
  documentContentHash: string | null;
  documentUpdatedAt: string | null;
  sourceFileHash: string | null;
  lastSeenAt: string | null;
  fileSize: number | null;
  lastModifiedAt: string | null;
};

type SyncTreeNode = {
  children: Map<string, SyncTreeNode>;
  item: SyncScanItem | null;
  name: string;
  relativePath: string;
};

const STATUS_LABELS: Record<string, string> = {
  READY: "待同步",
  SYNCED: "已同步",
  CHANGED: "内容已变化",
  CONFLICT: "冲突",
  MISSING: "源文件缺失",
  IGNORED: "已忽略",
  UNSUPPORTED: "暂不支持",
  OUTSIDE_ROOT: "已拒绝",
};

function createDirectoryTree(items: SyncScanItem[]): SyncTreeNode[] {
  const root = new Map<string, SyncTreeNode>();

  for (const item of items) {
    let nodes = root;
    let relativePath = "";
    for (const [index, segment] of item.relativePath.split("/").filter(Boolean).entries()) {
      relativePath = relativePath ? `${relativePath}/${segment}` : segment;
      let node = nodes.get(segment);
      if (!node) {
        node = { children: new Map(), item: null, name: segment, relativePath };
        nodes.set(segment, node);
      }
      if (index === item.relativePath.split("/").filter(Boolean).length - 1) {
        node.item = item;
      }
      nodes = node.children;
    }
  }

  const sortNodes = (nodes: Map<string, SyncTreeNode>): SyncTreeNode[] =>
    Array.from(nodes.values()).sort((left, right) => {
      const leftDirectory = left.children.size > 0;
      const rightDirectory = right.children.size > 0;
      if (leftDirectory !== rightDirectory) {
        return leftDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });

  return sortNodes(root);
}

// 文件树：目录用 details 折叠；条目名称点击后通过 URL selected 参数
// 切换选中（刷新保持），右侧辅助面板按该参数服务端渲染条目详情。
export function SyncFileTree({
  knowledgeBaseId,
  items,
  selectablePaths,
  selectedPath,
  baseQuery,
}: {
  knowledgeBaseId: string;
  items: SyncScanItem[];
  selectablePaths?: ReadonlySet<string>;
  selectedPath: string | null;
  baseQuery: string;
}) {
  const router = useRouter();
  const tree = createDirectoryTree(items);

  function toggleSelect(relativePath: string): void {
    const params = new URLSearchParams(baseQuery);
    if (selectedPath === relativePath) {
      params.delete("selected");
    } else {
      params.set("selected", relativePath);
    }
    const queryString = params.toString();
    router.replace(queryString ? `?${queryString}` : `/knowledge-bases/${knowledgeBaseId}/sync`, { scroll: false });
  }

  function renderNodes(nodes: SyncTreeNode[], ancestorPaths: ReadonlySet<string>): ReactNode {
    return (
      <ul className="sync-tree-list">
        {nodes.map((node) => {
          const item = node.item;
          const isSelected = item !== null && item.relativePath === selectedPath;
          const isAncestor = ancestorPaths.has(node.relativePath);
          return (
            <li key={node.relativePath} className={`sync-tree-node${isSelected ? " is-selected" : ""}`}>
              <details className="sync-tree-entry" data-state={item?.status} open={isSelected || isAncestor}>
                <summary>
                  {item && selectablePaths?.has(item.relativePath) ? (
                    <label className="sync-select-control" onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" name="selectedPaths" value={item.relativePath} />
                    </label>
                  ) : null}
                  {item ? (
                    <button
                      type="button"
                      className="sync-tree-name-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleSelect(item.relativePath);
                      }}
                    >
                      {node.name}
                    </button>
                  ) : (
                    <span className="sync-tree-name">{node.name}</span>
                  )}
                  {item ? (
                    <span className="sync-tree-status">{STATUS_LABELS[item.status] ?? item.status}</span>
                  ) : (
                    <span className="sync-tree-status">目录</span>
                  )}
                </summary>
                {node.children.size > 0
                  ? renderNodes(
                      Array.from(node.children.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
                      new Set([...ancestorPaths, node.relativePath]),
                    )
                  : null}
              </details>
            </li>
          );
        })}
      </ul>
    );
  }

  const ancestorPaths = new Set<string>();
  if (selectedPath) {
    const segments = selectedPath.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      ancestorPaths.add(segments.slice(0, index).join("/"));
    }
  }

  return renderNodes(tree, ancestorPaths);
}

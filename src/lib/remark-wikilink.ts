import { visit } from "unist-util-visit";
import type { Image, Link, Root, Text } from "mdast";
import type { Plugin } from "unified";

// 图片形式：![[target|width]]，width 参数忽略
const IMAGE_PATTERN = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
// 文本形式：[[target|label]] 或 [[target]]（无 label 时显示 target）
const TEXT_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const COMBINED_PATTERN = new RegExp(`(${IMAGE_PATTERN.source})|(${TEXT_PATTERN.source})`, "g");

type WikilinkPart =
  | { kind: "text"; value: string }
  | { kind: "link"; target: string; label: string }
  | { kind: "image"; target: string };

export function parseWikilinks(value: string): WikilinkPart[] {
  const parts: WikilinkPart[] = [];
  let cursor = 0;

  for (const match of value.matchAll(COMBINED_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const before = value.slice(cursor, match.index);
    if (before) {
      parts.push({ kind: "text", value: before });
    }
    if (match[1] !== undefined) {
      parts.push({ kind: "image", target: match[2] });
    } else {
      parts.push({
        kind: "link",
        target: match[4],
        label: (match[5]?.trim() || match[4]).replace(/[\[\]]/g, ""),
      });
    }
    cursor = match.index + match[0].length;
  }

  const tail = value.slice(cursor);
  if (tail) {
    parts.push({ kind: "text", value: tail });
  }
  return parts;
}

// 将 wikilink 转换为带 wikilink: 前缀目标的标准 link / image 节点，
// 渲染层负责把该前缀渲染为不可跳转的占位（文档依赖由系统维护，不依赖链接）。
export const remarkWikilink: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node: Text, index: number | undefined, parent) => {
    if (!parent || index === undefined) {
      return;
    }
    const parts = parseWikilinks(node.value);
    if (parts.length === 1 && parts[0].kind === "text") {
      return;
    }

    const children = parts.map((part): Text | Link | Image => {
      if (part.kind === "text") {
        return { type: "text", value: part.value };
      }
      if (part.kind === "image") {
        return { type: "image", url: `wikilink:${part.target}`, alt: "图片占位" };
      }
      return {
        type: "link",
        url: `wikilink:${part.target}`,
        children: [{ type: "text", value: part.label }],
      };
    });

    parent.children.splice(index, 1, ...children);
    return index + children.length - 1;
  });
};

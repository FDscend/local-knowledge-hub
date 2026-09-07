import { visit } from "unist-util-visit";
import type { ListItem, Root, Text } from "mdast";
import type { Plugin } from "unified";

// Obsidian 风格任务标记：`- [X]` 中的 X 为任意状态字符（! ? * > 等）。
// GFM 只识别 [ ] / [x]（布尔），其余符号由本插件提取为 listItem.data，
// 并注入 `data-task` 属性供渲染层使用；同时清空 checked，
// 阻止 react-markdown 渲染原生 checkbox input。
const TASK_PREFIX = /^\[([^\s\]])\]\s*/;

export const remarkCheckbox: Plugin<[], Root> = () => (tree) => {
  visit(tree, "listItem", (item: ListItem) => {
    if (typeof item.checked === "boolean") {
      // GFM 已解析 [ ] / [x]，统一转为符号
      item.data = {
        ...(item.data ?? {}),
        hProperties: { ...((item.data?.hProperties as Record<string, string> | undefined) ?? {}), "data-task": item.checked ? "x" : " " },
      };
      item.checked = undefined;
      return;
    }

    const paragraph = item.children[0];
    if (!paragraph || paragraph.type !== "paragraph") {
      return;
    }
    const textNode = paragraph.children[0];
    if (!textNode || textNode.type !== "text") {
      return;
    }
    const match = textNode.value.match(TASK_PREFIX);
    if (!match) {
      return;
    }
    (textNode as Text).value = textNode.value.slice(match[0].length);
    item.data = {
      ...(item.data ?? {}),
      hProperties: { ...((item.data?.hProperties as Record<string, string> | undefined) ?? {}), "data-task": match[1] },
    };
  });
};

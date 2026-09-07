/**
 * remark plugin: parse `==highlighted text==` as `<mark>` elements.
 *
 * Transforms inline text containing `==…==` into a custom `mark` node.
 * Uses `data.hName` to tell react-markdown to render as `<mark>`.
 */

import { visit } from "unist-util-visit";
import type { Root, Text } from "mdast";

export default function remarkHighlight() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index: number | undefined, parent: any | undefined) => {
      if (index === undefined || !parent || !parent.children) return;
      if (!/==.+?==/.test(node.value)) return;

      const parts = node.value.split(/(==.+?==)/g);
      if (parts.length <= 1) return;

      const children: any[] = [];

      for (const part of parts) {
        if (part.startsWith("==") && part.endsWith("==")) {
          const inner = part.slice(2, -2);
          if (!inner) continue;
          children.push({
            type: "text",
            value: inner,
            data: {
              hName: "mark",
              hProperties: { className: ["hl-mark"] },
            },
          });
        } else if (part) {
          children.push({ type: "text", value: part });
        }
      }

      parent.children.splice(index, 1, ...children);
    });
  };
}

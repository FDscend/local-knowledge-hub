import React, { useId } from "react";
import matter from "gray-matter";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkGemoji from "remark-gemoji";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";

import remarkHighlight from "@/lib/remark-highlight";
import remarkCallout, {
  getCalloutIcon,
  getCalloutDefaultTitle,
  getCalloutStyle,
  getCalloutColor,
  hexToRgbTuple,
  isTheoremKeyword,
  isSpecialCallout,
  isBlankVariant,
  normalizeIconSvg,
  CALLOUT_FOLD_ICON,
} from "@/lib/remark-callout";
import { parseWikilinks, remarkWikilink } from "@/lib/remark-wikilink";
import { remarkCheckbox } from "@/lib/remark-checkbox";

import { HighlightThemeProvider } from "./HighlightThemeContext";
import { CodeBlock } from "./CodeBlock";

type MarkdownArticleProps = {
  content: string;
  frontmatter?: string | null;
  knowledgeBaseId?: string;
};

function formatFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.map(String).join(", ");
    return JSON.stringify(value);
  }
  return String(value);
}

function isSimpleFrontmatterValue(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.every((v) => typeof v === "string"))
  );
}

const WIKILINK_SCHEME = "wikilink:";

// 将纯文本中的 wikilink 分段渲染；用于 callout 标题等不经 remark 解析的文本。
function renderWikilinkText(value: string): React.ReactNode[] {
  const parts = value.split(/(!?\[\[[^\]]*\]\])/g);
  return parts.map((part, index) => {
    if (part.startsWith("![[")) {
      const match = part.match(/^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
      if (match) {
        return (
          <span key={index} className="wikilink-image" title={match[1]} data-wikilink={match[1]} role="img" aria-label={`图片：${match[1]}`}>
            <span className="wikilink-image-glyph" aria-hidden="true">▦</span>
          </span>
        );
      }
    }
    if (part.startsWith("[[")) {
      const match = part.match(/^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/);
      if (match) {
        const target = match[1];
        const label = (match[2]?.trim() || target).replace(/[\[\]]/g, "");
        return (
          <span key={index} className="wikilink" title={target} data-wikilink={target}>
            {label}
          </span>
        );
      }
    }
    return part;
  });
}

// callout 标题中的 wikilink 由标题属性字符串承载，渲染时同样替换为不可跳转占位。
function WikilinkTitleText({ value }: { value: string }) {
  return <>{renderWikilinkText(value)}</>;
}

function FrontmatterTable({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(
    ([, value]) => isSimpleFrontmatterValue(value),
  );

  if (entries.length === 0) return null;

  return (
    <table className="frontmatter-table">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}>
            <th>{key}</th>
            <td>{formatFrontmatterValue(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CalloutBlock({ children, ...props }: any) {
  const calloutType: string = props["data-callout"] || "note";
  const keyword = calloutType.toUpperCase();
  const metadataOption: string = props["data-callout-metadata"] || "";
  const collapseFlag: string = props["data-callout-fold"] || "";
  const customTitle: string = props["data-callout-title"] || "";
  const numberAttr: string | undefined = props["data-callout-number"];

  const icon = normalizeIconSvg(getCalloutIcon(keyword));
  const defaultTitle = getCalloutDefaultTitle(keyword);
  const colorHex = getCalloutColor(keyword, metadataOption);
  const isTheorem = isTheoremKeyword(keyword);
  const isSpecial = isSpecialCallout(keyword);
  const blank = isBlankVariant(keyword);
  const isCollapsible = collapseFlag === "+" || collapseFlag === "-";
  const isOpen = collapseFlag === "+";

  // Use custom title if provided, otherwise fall back to default
  const titleText = customTitle || defaultTitle;

  // For folding: generate a unique toggle id
  const foldId = `callout-fold-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // ── Theorem blocks ──────────────────────────────────────────────
  if (isTheorem) {
    const hasNumber = numberAttr !== undefined && numberAttr !== "none";
    const numberLabel = hasNumber ? `${numberAttr}.` : "";

    if (isCollapsible) {
      // Use <details>/<summary> for collapsible theorems (matching reference)
      return (
        <details
          className="thm-block"
          data-callout={calloutType}
          open={isOpen}
        >
          <summary className="thm-summary" role="button">
            <span className="thm-title-inner">{defaultTitle} {numberLabel}</span>
            {customTitle && (
              <span className="thm-custom-title">({customTitle})</span>
            )}
            <span className="callout-fold" aria-hidden="true" dangerouslySetInnerHTML={{ __html: CALLOUT_FOLD_ICON }} />
          </summary>
          <div className="thm-body">{children}</div>
        </details>
      );
    }

    return (
      <div className="thm-block" data-callout={calloutType}>
        <div className="thm-title">
          <span className="thm-title-inner">{defaultTitle} {numberLabel}</span>
          {customTitle && (
            <span className="thm-custom-title">({customTitle})</span>
          )}
        </div>
        <div className="thm-body">{children}</div>
      </div>
    );
  }

  // ── MULTI-COLUMN layout ─────────────────────────────────────────
  if (calloutType === "multi-column") {
    return (
      <div
        className="callout"
        data-callout="multi-column"
        data-callout-metadata={metadataOption}
        data-callout-title={customTitle || undefined}
      >
        <div className="callout-content">{children}</div>
      </div>
    );
  }

  // ── BORDER callout ──────────────────────────────────────────────
  if (calloutType === "border") {
    return (
      <div className="callout" data-callout="border" data-callout-title={customTitle || undefined}>
        <div className="callout-title">
          <span className="callout-title-inner"><WikilinkTitleText value={titleText} /></span>
        </div>
        <div className="callout-content">{children}</div>
      </div>
    );
  }

  // ── Regular callout (with folding & custom title support) ───────
  const styleProps = {
    "--callout-color": hexToRgbTuple(colorHex),
  } as React.CSSProperties;

  const baseClasses = ["callout"];
  if (isCollapsible) baseClasses.push("is-collapsible");
  if (collapseFlag === "-") baseClasses.push("is-collapsed");

  const titleTag = isCollapsible ? "label" : "div";
  const titleAttrs: Record<string, string> = { className: "callout-title", dir: "auto" };
  if (isCollapsible) titleAttrs.htmlFor = foldId;

  return (
    <div
      className={baseClasses.join(" ")}
      data-callout={calloutType}
      data-callout-metadata={metadataOption}
      data-callout-fold={collapseFlag}
      data-callout-title={customTitle || undefined}
      style={styleProps}
    >
      {isCollapsible && (
        <input
          className="callout-fold-toggle"
          type="checkbox"
          id={foldId}
          defaultChecked={isOpen}
          aria-hidden="true"
        />
      )}
      {React.createElement(
        titleTag,
        titleAttrs,
        icon ? <span className="callout-icon" dangerouslySetInnerHTML={{ __html: icon }} /> : null,
        <span className="callout-title-inner"><WikilinkTitleText value={titleText} /></span>,
        isCollapsible ? (
          <span className="callout-fold" aria-hidden="true" dangerouslySetInnerHTML={{ __html: CALLOUT_FOLD_ICON }} />
        ) : null,
      )}
      <div className="callout-content">{children}</div>
    </div>
  );
}

function KnowledgeMarkdown({ body }: { body: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkGemoji, remarkMath, remarkHighlight, remarkCallout, remarkWikilink, remarkCheckbox]}
      rehypePlugins={[rehypeSlug, rehypeKatex]}
      // react-markdown 默认会清除 wikilink: 这类非标准协议的 URL（图片 src 会被置空），
      // 这里只放行 wikilink: 协议，其余仍走默认安全过滤（防 javascript: 等注入）。
      urlTransform={(url) => (url.startsWith(WIKILINK_SCHEME) ? url : defaultUrlTransform(url))}
      components={{
        code({ className, children, ...props }) {
          // Block-level code: has a language class, or spans multiple lines
          const codeText = typeof children === "string"
            ? children
            : Array.isArray(children)
              ? children.map((c) => (typeof c === "string" ? c : "")).join("")
              : "";
          const hasLang = className?.startsWith("language-");
          const isInline = !hasLang && !codeText.includes("\n");
          return (
            <CodeBlock className={className} inline={isInline}>
              {children}
            </CodeBlock>
          );
        },
        // Strip react-markdown's outer <pre> when CodeBlock already handles wrapping
        pre({ children, node, ...props }: any) {
          const child = children as React.ReactElement | undefined;
          if (child?.type === CodeBlock || (child?.props as any)?.className?.startsWith?.("language-")) {
            return <>{children}</>;
          }
          return <pre {...props}>{children}</pre>;
        },
        mark({ children, ...props }) {
          return <mark className="hl-mark">{children}</mark>;
        },
        // Obsidian 风格任务项：状态字符由 remark-checkbox 注入 data-task，
        // 图标样式由 CSS 按 data-task 渲染
        li({ node, children, ...props }: any) {
          const task = node?.properties?.["data-task"];
          if (typeof task !== "string") {
            return <li {...props}>{children}</li>;
          }
          return (
            <li className="task-item" data-task={task}>
              <span className="task-item-content">{children}</span>
            </li>
          );
        },
        // Render callout divs with title bar and icon
        div({ className, ...props }: any) {
          if (className?.includes("callout")) {
            return <CalloutBlock {...props} />;
          }
          return <div className={className} {...props} />;
        },
        // wikilink 文本形式：渲染为不可跳转的链接样式，悬浮显示目标
        a({ href, children, ...props }: any) {
          if (typeof href === "string" && href.startsWith(WIKILINK_SCHEME)) {
            const target = href.slice(WIKILINK_SCHEME.length);
            return (
              <span className="wikilink" title={target} data-wikilink={target}>
                {children}
              </span>
            );
          }
          return <a href={href} {...props}>{children}</a>;
        },
        // wikilink 图片形式：渲染为空图片占位（忽略 width 参数），悬浮显示目标
        img({ src, alt, ...props }: any) {
          if (typeof src === "string" && src.startsWith(WIKILINK_SCHEME)) {
            const target = src.slice(WIKILINK_SCHEME.length);
            return (
              <span className="wikilink-image" title={target} data-wikilink={target} role="img" aria-label={`图片：${target}`}>
                <span className="wikilink-image-glyph" aria-hidden="true">▦</span>
              </span>
            );
          }
          // 文档正文中的图片来自本机附件接口，无需 Next 图片优化
          // eslint-disable-next-line @next/next/no-img-element
          return <img src={src} alt={alt ?? ""} {...props} />;
        },
      }}
    >
      {body}
    </ReactMarkdown>
  );
}

export function MarkdownArticle({ content, frontmatter, knowledgeBaseId }: MarkdownArticleProps) {
  // 1) Try explicit frontmatter JSON prop (new docs)
  let tableData: Record<string, unknown> | null = null;
  let body = content;

  if (frontmatter) {
    try {
      tableData = JSON.parse(frontmatter);
    } catch {
      // ignore invalid JSON
    }
  }

  // 2) Fallback: parse YAML from content directly (old docs where
  //    frontmatter was stored inline before the field existed)
  if (!tableData) {
    const parsed = matter(content);
    if (Object.keys(parsed.data).length > 0) {
      tableData = parsed.data as Record<string, unknown>;
      body = parsed.content.trim() || content;
    }
  }

  if (knowledgeBaseId) {
    body = body.replace(
      /knowledge-asset:\/\/([a-zA-Z0-9_-]{1,64})/g,
      (_match, assetId: string) =>
        `/api/knowledge-assets/${assetId}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`,
    );
  }

  return (
    <HighlightThemeProvider>
      <div className="markdown-body">
        {tableData && Object.keys(tableData).length > 0 && (
          <FrontmatterTable data={tableData} />
        )}
        <KnowledgeMarkdown body={body} />
      </div>
    </HighlightThemeProvider>
  );
}

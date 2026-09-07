"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import hljs from "highlight.js/lib/core";
import mermaid from "mermaid";
import { useHighlightTheme, HIGHLIGHT_THEMES, type HighlightThemeId } from "./HighlightThemeContext";

// ── Register common languages ──────────────────────────────────────────
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import rust from "highlight.js/lib/languages/rust";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import java from "highlight.js/lib/languages/java";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import plaintext from "highlight.js/lib/languages/plaintext";
import matlab from "highlight.js/lib/languages/matlab";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", c);
hljs.registerLanguage("java", java);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("", plaintext);
hljs.registerLanguage("matlab", matlab);

// ── Theme CSS loader ───────────────────────────────────────────────────

// 主题 CSS 本地化到 public/vendor/hljs/（离线优先，不依赖公网 CDN）。
const THEME_BASE_URL = "/vendor/hljs";

const THEME_CSS_MAP: Record<HighlightThemeId, string> = {
  "github": `${THEME_BASE_URL}/github.min.css`,
  "github-dark": `${THEME_BASE_URL}/github-dark.min.css`,
  "atom-one-light": `${THEME_BASE_URL}/atom-one-light.min.css`,
  "atom-one-dark": `${THEME_BASE_URL}/atom-one-dark.min.css`,
  "vs2015": `${THEME_BASE_URL}/vs2015.min.css`,
  "stackoverflow-light": `${THEME_BASE_URL}/stackoverflow-light.min.css`,
  "stackoverflow-dark": `${THEME_BASE_URL}/stackoverflow-dark.min.css`,
};

function useHighlightThemeLoader(theme: HighlightThemeId) {
  useEffect(() => {
    const id = "hljs-theme-link";
    let link = document.getElementById(id) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    link.href = THEME_CSS_MAP[theme];
  }, [theme]);
}

// ── Component ──────────────────────────────────────────────────────────

type CodeBlockProps = {
  className?: string;
  children?: React.ReactNode;
  /** react-markdown passes inline=false for fenced blocks */
  inline?: boolean;
};

export function CodeBlock({ className, children, inline }: CodeBlockProps) {
  const codeRef = useRef<HTMLElement>(null);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [mermaidSvg, setMermaidSvg] = useState<string | null>(null);
  const { theme, setTheme } = useHighlightTheme();

  useHighlightThemeLoader(theme);

  // Initialize mermaid once
  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
  }, []);

  // Extract language from className like "language-ts"
  const lang = className?.startsWith("language-") ? className.slice(9) : "";

  // Extract code text from children
  const codeText = typeof children === "string"
    ? children
    : Array.isArray(children)
      ? children.map((c) => (typeof c === "string" ? c : "")).join("")
      : "";

  // Apply highlight.js after mount (skip for mermaid / unregistered languages)
  useEffect(() => {
    if (codeRef.current && !inline && lang !== "mermaid" && hljs.getLanguage(lang)) {
      try {
        hljs.highlightElement(codeRef.current);
      } catch {
        // 未注册语言保持纯文本，不破坏代码块渲染
      }
    }
  }, [codeText, lang, inline]);

  // Render Mermaid diagram
  useEffect(() => {
    if (lang === "mermaid" && codeText && !inline) {
      const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
      mermaid.render(id, codeText)
        .then(({ svg }) => setMermaidSvg(svg))
        .catch(() => setMermaidSvg(null));
    }
  }, [codeText, lang, inline]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // fallback for non-https contexts
      const ta = document.createElement("textarea");
      ta.value = codeText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }, [codeText]);

  // Inline code: render as simple <code>
  if (inline) {
    return <code className={className}>{children}</code>;
  }

  // Mermaid diagram: render SVG directly without code-block chrome
  if (lang === "mermaid" && !inline && mermaidSvg) {
    return (
      <div
        ref={mermaidRef}
        className="mermaid-container"
        dangerouslySetInnerHTML={{ __html: mermaidSvg }}
      />
    );
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-block-toolbar">
        <div className="code-block-actions">
          <select
            className="code-block-theme-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as HighlightThemeId)}
            aria-label="选择高亮主题"
          >
            {HIGHLIGHT_THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            className="code-block-copy-btn"
            onClick={handleCopy}
            aria-label={copied ? "已复制" : "复制代码"}
          >
            {copied ? "✅" : "📋"}
          </button>
        </div>
      </div>
      <pre>
        <code ref={codeRef} className={className}>
          {codeText}
        </code>
      </pre>
    </div>
  );
}

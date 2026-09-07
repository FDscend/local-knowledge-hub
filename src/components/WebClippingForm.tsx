"use client";

import Link from "next/link";
import { useState } from "react";

type WebClippingFormProps = {
  knowledgeBaseId: string;
};

type ClippingResult = {
  documentId: string;
  title: string;
  markdown: string;
  imported: boolean;
};

type FetchedClippingResult = ClippingResult & {
  fetched?: { finalUrl: string; redirectCount: number; fetchedAt: string };
};

export function WebClippingForm({ knowledgeBaseId }: WebClippingFormProps) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [html, setHtml] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [result, setResult] = useState<ClippingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitClipping = async (payload: { url: string; html?: string }) => {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/clippings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId, title: title.trim() || undefined, ...payload }),
      });
      const body = (await response.json()) as ClippingResult & { error?: string };
      if (!response.ok || body.error) {
        setError(body.error ?? "网页剪藏导入失败。");
        return;
      }
      setResult(body);
      setHtml("");
    } catch {
      setError("网络请求失败。");
    } finally {
      setSubmitting(false);
    }
  };

  const submitPastedHtml = () => void submitClipping({ url, html });

  const submitFetchUrl = async () => {
    if (!url.trim() || fetching) {
      return;
    }
    setFetching(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/clippings/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId, url, title: title.trim() || undefined }),
      });
      const body = (await response.json()) as FetchedClippingResult & { error?: string };
      if (!response.ok || body.error) {
        setError(body.error ?? "网页抓取失败。");
        return;
      }
      setResult(body);
      setHtml("");
    } catch {
      setError("网络请求失败。");
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="stack-panel form-panel">
      <h2>网页剪藏（输入 URL 或粘贴 HTML）</h2>
      <p className="muted-text">
        输入 URL 后点击“抓取并导入”自动下载页面（仅限公开静态页面，本机 / 内网地址一律拒绝），或直接粘贴 HTML
        转 Markdown 后入库。远程图片默认保留原始 URL，不下载；请只剪藏你已合法获取的页面内容。
      </p>
      <label className="field">
        <span>来源 URL</span>
        <input className="input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/article.html" required />
        <p className="field-helper">支持 http / https；服务端会拦截回环、私网、云元数据等地址，并限制重定向与页面大小。</p>
      </label>
      <label className="field">
        <span>标题（可选，留空取页面标题）</span>
        <input className="input" type="text" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="剪藏文档标题" />
      </label>
      <label className="field">
        <span>页面 HTML（可选，与 URL 抓取二选一）</span>
        <textarea
          className="input textarea-code"
          value={html}
          onChange={(event) => setHtml(event.target.value)}
          placeholder="&lt;!DOCTYPE html&gt;&#10;&lt;html&gt;&#10;...（完整页面源码）"
          rows={10}
        />
        <p className="field-helper">上限约 2MB 字符；填写后提交即解析，不经过后台任务队列。</p>
      </label>
      <div className="form-actions">
        <button type="button" className="button primary" onClick={() => void submitFetchUrl()} disabled={fetching || submitting || !url.trim()}>
          {fetching ? "正在抓取并导入…" : "抓取并导入"}
        </button>
        <button type="button" className="button secondary" onClick={submitPastedHtml} disabled={submitting || fetching || !html.trim()}>
          {submitting ? "正在剪藏…" : "粘贴 HTML 剪藏"}
        </button>
      </div>
      {result ? (
        <p className="field-helper">
          剪藏成功：{result.title}
          {result.imported ? "（新增）" : "（内容未变化，已去重）"}。{" "}
          <Link href={`/knowledge/${result.documentId}?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`}>查看文档</Link>
        </p>
      ) : null}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

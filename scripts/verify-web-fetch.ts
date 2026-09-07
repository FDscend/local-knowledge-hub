import "dotenv/config";

import { fetchWebPageHtml } from "../src/lib/web-fetch";

const REJECTED_URLS: Array<{ url: string; reason: string }> = [
  { url: "http://127.0.0.1:3000/", reason: "回环地址" },
  { url: "http://localhost:3000/", reason: "localhost" },
  { url: "http://[::1]:3000/", reason: "IPv6 回环" },
  { url: "http://169.254.169.254/latest/meta-data/", reason: "云元数据地址" },
  { url: "http://10.0.0.1/", reason: "私网 A 段" },
  { url: "http://172.16.0.1/", reason: "私网 B 段" },
  { url: "http://192.168.1.1/", reason: "私网 C 段" },
  { url: "http://100.64.0.1/", reason: "CGNAT 地址" },
  { url: "http://0.0.0.0/", reason: "未指定地址" },
  { url: "http://[fe80::1]/", reason: "IPv6 链路本地" },
  { url: "http://[fc00::1]/", reason: "IPv6 ULA" },
  { url: "file:///etc/passwd", reason: "file 协议" },
  { url: "ftp://example.com/", reason: "ftp 协议" },
  { url: "javascript:alert(1)", reason: "javascript 协议" },
];

function fail(message: string): never {
  throw new Error(`抓取防护验证失败：${message}`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

async function main(): Promise<void> {
  // 1. 内网 / 回环 / 云元数据 / 非 http(s) URL 一律拒绝。
  let rejectedCount = 0;
  for (const { url, reason } of REJECTED_URLS) {
    let blocked = false;
    try {
      await fetchWebPageHtml(url);
    } catch {
      blocked = true;
    }
    expect(blocked, `应拒绝 ${reason}：${url}`);
    rejectedCount += 1;
  }
  console.log(`[1] ${rejectedCount} 类内网 / 非 http(s) 目标全部被拒。`);

  // 2. 空 URL 与超长 URL 拒绝。
  let emptyBlocked = false;
  try {
    await fetchWebPageHtml("   ");
  } catch {
    emptyBlocked = true;
  }
  expect(emptyBlocked, "空 URL 未被拒绝。");
  let longBlocked = false;
  try {
    await fetchWebPageHtml(`https://example.com/${"a".repeat(2100)}`);
  } catch {
    longBlocked = true;
  }
  expect(longBlocked, "超长 URL 未被拒绝。");
  console.log(`[2] 空 URL 与超长 URL 均被拒绝。`);

  // 3. 公网静态页面抓取（依赖外网；不可用时跳过而不是失败）。
  try {
    const page = await fetchWebPageHtml("https://example.com/");
    expect(page.html.length > 0, "公网页面抓取结果为空。");
    expect(page.finalUrl.startsWith("https://"), "最终 URL 异常。");
    console.log(`[3] 公网抓取成功（${page.html.length} 字符，跳转 ${page.redirectCount} 次）。`);
  } catch (error) {
    console.warn(`[3] 公网抓取不可用，跳过（${error instanceof Error ? error.message : String(error)}）。`);
  }

  console.log("URL 抓取 SSRF 防护验证完成。");
}

void main();

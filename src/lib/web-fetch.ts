import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * 公开静态网页抓取（文档 11.3 URL 抓取安全要求）。
 *
 * 在受限 HTTP 客户端中实施 SSRF 防护：
 * - 只接受 http / https；
 * - 每次请求和每次重定向后解析 DNS，拒绝 localhost、回环、私网、链路本地、
 *   云元数据（169.254.169.254）、CGNAT 与内网 IPv6；
 * - 限制重定向次数、响应体大小、下载时间与内容类型；
 * - 独立、无登录态，不转发用户 Cookie / Authorization。
 */

export const WEB_FETCH_LIMITS = {
  /** 最大重定向跳数。 */
  maxRedirects: 5,
  /** 单次下载超时（毫秒）。 */
  timeoutMs: 15_000,
  /** 响应体大小上限（字节，约 2MB）。 */
  maxBodyBytes: 2_000_000,
  /** URL 长度上限。 */
  maxUrlLength: 2000,
} as const;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10) return true; // 0.0.0.0/8, 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地 + 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // 多播与保留
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // 回环 / 未指定
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // 链路本地 fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("ff")) return true; // 多播
  // IPv4 映射 ::ffff:a.b.c.d 解包后再按 IPv4 判断
  const ipv4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) {
    return isPrivateIpv4(ipv4Mapped[1]);
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  return net.isIP(ip) === 4 ? isPrivateIpv4(ip) : net.isIP(ip) === 6 ? isPrivateIpv6(ip) : false;
}

/** 对 hostname 做 DNS 解析并拒绝任何解析结果为内网 / 回环地址的请求。 */
async function assertPublicHost(hostname: string): Promise<void> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`无法解析主机 ${hostname}。`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`目标地址 ${hostname}（${address}）属于本机或内网地址，已拒绝抓取。`);
    }
  }
}

function assertPublicUrl(url: URL): void {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error("只允许抓取 http 或 https 页面。");
  }
  if (url.username || url.password) {
    throw new Error("目标 URL 不能包含用户名或密码。");
  }
}

async function fetchOnce(url: URL, signal: AbortSignal): Promise<Response> {
  assertPublicUrl(url);
  // 拒绝 literal 内网主机名（localhost、回环 IP 等），再走 DNS 校验。
  const literalHost = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literalHost) && isPrivateIp(literalHost)) {
    throw new Error(`目标地址 ${url.host} 属于本机或内网地址，已拒绝抓取。`);
  }
  await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ""));

  // 独立、无登录态的抓取客户端：不转发任何 Cookie / Authorization / 自定义头。
  return fetch(url, {
    redirect: "manual",
    signal,
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; AIKnowledgeBase/1.0; localhost)",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
  });
}

async function readBodyLimited(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType) && !contentType.startsWith("text/plain")) {
    throw new Error(`目标返回的内容类型 ${contentType || "未知"} 不是网页，已跳过。`);
  }
  if (response.body === null) {
    throw new Error("目标页面没有响应体。");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > WEB_FETCH_LIMITS.maxBodyBytes) {
      await reader.cancel();
      throw new Error(`目标页面超过 ${WEB_FETCH_LIMITS.maxBodyBytes / 1_000_000}MB 上限，已中止下载。`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type FetchedWebPage = {
  html: string;
  finalUrl: string;
  /** 实际跳转次数（0 表示未跳转）。 */
  redirectCount: number;
  fetchedAt: string;
};

/**
 * 抓取公开静态网页 HTML。逐跳校验目标（含重定向后的主机），
 * 任何一跳命中本机 / 内网 / 云元数据地址都会中止。
 */
export async function fetchWebPageHtml(inputUrl: string): Promise<FetchedWebPage> {
  const trimmed = inputUrl.trim();
  if (!trimmed) {
    throw new Error("抓取 URL 不能为空。");
  }
  if (trimmed.length > WEB_FETCH_LIMITS.maxUrlLength) {
    throw new Error("抓取 URL 过长。");
  }
  let currentUrl: URL;
  try {
    currentUrl = new URL(trimmed);
  } catch {
    throw new Error("抓取 URL 格式无效。");
  }
  assertPublicUrl(currentUrl);

  let redirectCount = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_FETCH_LIMITS.timeoutMs);
    try {
      const response = await fetchOnce(currentUrl, controller.signal);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`目标返回重定向但缺少 Location（${response.status}）。`);
        }
        redirectCount += 1;
        if (redirectCount > WEB_FETCH_LIMITS.maxRedirects) {
          throw new Error(`目标重定向超过 ${WEB_FETCH_LIMITS.maxRedirects} 次，已中止。`);
        }
        currentUrl = new URL(location, currentUrl);
        assertPublicUrl(currentUrl);
        continue;
      }

      if (!response.ok) {
        throw new Error(`目标返回 HTTP ${response.status}，抓取失败。`);
      }

      const html = await readBodyLimited(response);
      if (!html.trim()) {
        throw new Error("目标页面内容为空。");
      }
      return {
        html,
        finalUrl: currentUrl.href,
        redirectCount,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`抓取超时（超过 ${WEB_FETCH_LIMITS.timeoutMs / 1000}s）。`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

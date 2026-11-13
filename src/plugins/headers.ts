/**
 * 安全响应头（计划 §7.4）。
 *
 * | 头 | 值 |
 * | --- | --- |
 * | `Content-Security-Policy` | `default-src 'none'; style-src 'self' 'sha256-…'; script-src 'self' 'sha256-…'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'` |
 * | `X-Content-Type-Options` | `nosniff` |
 * | `Referrer-Policy` | `no-referrer` |
 * | `Cache-Control` | `no-store` |
 * | `X-Robots-Tag` | `noindex` |
 *
 * 用 `onSend` 而不是 `onRequest`：这样 403 / 404 / 413 这些由框架或 errorHandler
 * 产生的响应同样带上这组头，不给扫描器留下「换个路径就没防护」的错觉。
 */

import type { FastifyInstance } from 'fastify';

/**
 * 内联资源的 CSP 哈希（base64 sha256）。
 *
 * 页面里的 CSS/JS 是**内联**的（见 src/render/page.ts：边缘层会拦掉子资源请求），
 * 所以 CSP 要额外放行这两段内容的 sha256 哈希；`'self'` 保留，
 * `/_assets/app.css` / `/_assets/app.js` 仍可直接访问。
 */
export interface CspHashes {
  /** 内联 `<style>` 内容的 sha256（base64） */
  style?: string | null;
  /** 内联 `<script>` 内容的 sha256（base64） */
  script?: string | null;
}

/**
 * 计划 §7.4 的 CSP：不允许任何外部来源；
 * 样式与脚本允许同源 + 内联资源各自的 sha256 哈希。
 */
export function buildContentSecurityPolicy(hashes: CspHashes = {}): string {
  const styleSources = ["'self'"];
  const scriptSources = ["'self'"];
  if (hashes.style) styleSources.push(`'sha256-${hashes.style}'`);
  if (hashes.script) scriptSources.push(`'sha256-${hashes.script}'`);
  return [
    "default-src 'none'",
    `style-src ${styleSources.join(' ')}`,
    `script-src ${scriptSources.join(' ')}`,
    "img-src 'self' data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** 计划 §7.4 的完整响应头清单（CSP 单独按运行时哈希生成，见 `registerSecurityHeaders`） */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
};

/**
 * 注册响应头钩子。
 *
 * @param hashes 内联资源的 CSP 哈希（启动时读入 public/app.css|app.js 后算好）
 */
export function registerSecurityHeaders(app: FastifyInstance, hashes: CspHashes = {}): void {
  const csp = buildContentSecurityPolicy(hashes);
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', csp);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    return payload;
  });
}

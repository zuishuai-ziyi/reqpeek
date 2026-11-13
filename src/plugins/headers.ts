/**
 * 安全响应头（计划 §7.4）。
 *
 * | 头 | 值 |
 * | --- | --- |
 * | `Content-Security-Policy` | `default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'` |
 * | `X-Content-Type-Options` | `nosniff` |
 * | `Referrer-Policy` | `no-referrer` |
 * | `Cache-Control` | `no-store` |
 * | `X-Robots-Tag` | `noindex` |
 *
 * 用 `onSend` 而不是 `onRequest`：这样 403 / 404 / 413 这些由框架或 errorHandler
 * 产生的响应同样带上这组头，不给扫描器留下「换个路径就没防护」的错觉。
 */

import type { FastifyInstance } from 'fastify';

/** 计划 §7.4 的 CSP：不允许任何外部来源，样式与脚本只允许同源 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** 计划 §7.4 的完整响应头清单（`onSend` 里逐条设置） */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
};

/** 注册响应头钩子。 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    return payload;
  });
}

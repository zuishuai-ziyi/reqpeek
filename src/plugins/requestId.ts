/**
 * 请求 id（计划 §4 的 `meta.id`、页面顶行的 `id 3f9a01c2`）。
 *
 * - 每个请求生成一个 8 位十六进制 id（4 字节随机）；
 * - 回写到响应头 `x-request-id`，方便在 CDN 日志与页面之间对账；
 * - **不接受**客户端传入的 id（避免被伪造 / 注入超长值）。
 *
 * 与 timing.ts 一样用 WeakMap 存，不污染 request 的公开形状。
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** 响应头名（回写请求 id） */
export const REQUEST_ID_HEADER = 'x-request-id';

/** request → 请求 id */
const ids = new WeakMap<FastifyRequest, string>();

/** 注册请求 id 钩子。 */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const id = randomBytes(4).toString('hex');
    ids.set(request, id);
    reply.header(REQUEST_ID_HEADER, id);
  });
}

/** 取当前请求的 id（没注册插件时返回空串）。 */
export function requestIdOf(request: FastifyRequest): string {
  return ids.get(request) ?? '';
}

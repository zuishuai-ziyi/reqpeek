/**
 * 公网 origin 的护栏（计划 §7.1 / §6.6）。
 *
 * 两件事：
 *
 * 1. **回源 token 门禁**：`ORIGIN_TOKEN` 非空时，`onRequest` 校验 `x-origin-token`，
 *    用 `crypto.timingSafeEqual` 比较（先比长度再比内容）；不匹配 → 极简 403，
 *    **不展示任何请求信息**（避免对扫描器暴露「这台机器能转储请求」的能力）。
 *    豁免路径：`/healthz`（探活）与 `/_assets/*`（静态资源回源）。
 * 2. **body 上限**：`Content-Length` 超限直接 413，不给把大 body 读进内存的机会；
 *    真读流时超限由 Fastify 抛 `FST_ERR_CTP_BODY_TOO_LARGE`（见 `app.ts` 的 errorHandler）。
 *    两条路径抛的是同一种错误，所以 413 的响应是同一张转储页：
 *    header / 连接 / 链路照常展示，body 区块标注「超限未读取」（计划 §5.1 / §6.6）。
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

/** 回源 token 的请求头名（计划 §7.1 / §13） */
export const ORIGIN_TOKEN_HEADER = 'x-origin-token';

/** 免 token 的路径（探活不带自定义头） */
export const TOKEN_EXEMPT_PATHS: readonly string[] = ['/healthz'];

/** 免 token 的路径前缀（静态资源目录） */
export const TOKEN_EXEMPT_PREFIXES: readonly string[] = ['/_assets/'];

/** 该路径是否豁免 token 校验。 */
export function isTokenExempt(pathname: string): boolean {
  if (TOKEN_EXEMPT_PATHS.includes(pathname)) return true;
  return TOKEN_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** 取请求的 pathname（去掉 query）；`raw.url` 可能是 absolute-form，这里只取 path 部分。 */
export function pathnameOf(request: FastifyRequest): string {
  const raw = request.raw.url ?? '/';
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  if (!path.startsWith('/')) {
    // absolute-form（`http://host/path`）：退化成 URL 解析
    try {
      return new URL(raw).pathname;
    } catch {
      return '/';
    }
  }
  return path;
}

/**
 * 常量时间比较 token。
 *
 * `timingSafeEqual` 要求两侧等长，所以先比长度（长度本身不是秘密）再比内容。
 * `expected` 为空串 = 门禁关闭，一律放行。
 */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (expected.length === 0) return true;
  if (provided === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 是否是 Fastify 的「body 超限」错误。 */
export function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  );
}

/** 注册全部护栏。 */
export function registerGuards(app: FastifyInstance, config: Config): void {
  registerTokenGate(app, config);
  registerBodyLimit(app, config);
}

/** 回源 token 门禁（计划 §7.1）。 */
function registerTokenGate(app: FastifyInstance, config: Config): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!config.tokenGate) return;
    if (isTokenExempt(pathnameOf(request))) return;

    const raw = request.headers[ORIGIN_TOKEN_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (tokenMatches(config.originToken, provided)) return;

    // 极简 403：只说「不许」，不回显任何请求信息
    return reply
      .code(403)
      .header('content-type', 'text/plain; charset=utf-8')
      .send('403 Forbidden');
  });
}

/** body 上限（计划 §6.6：接收上限 1 MiB，超限 413）。 */
function registerBodyLimit(app: FastifyInstance, config: Config): void {
  app.addHook('onRequest', async (request) => {
    const raw = request.headers['content-length'];
    if (raw === undefined) return;
    const length = Number.parseInt(raw, 10);
    if (!Number.isFinite(length) || length <= config.bodyLimit) return;

    // 声明的 Content-Length 就超限 → 根本不给读 body 的机会。
    // 抛 Fastify 解析器同款的错误（code 一致），交给 app.ts 的 errorHandler
    // 统一转成 413 转储页（计划 §5.1：header / 连接 / 链路照常展示，body 标「超限未读取」）。
    const error = new Error('Payload Too Large') as FastifyError;
    error.code = 'FST_ERR_CTP_BODY_TOO_LARGE';
    error.statusCode = 413;
    throw error;
  });
}

/**
 * 耗时统计（计划 §5.10）。
 *
 * `onRequest` 记 `process.hrtime.bigint()`，渲染前求差 → `meta.durationMs`，
 * 语义是「服务端处理耗时（接收→渲染）」，**不含**网络传输时间。
 *
 * 记录方式用 WeakMap，而不是往 request 上挂属性：
 * - 不污染 Fastify request 的公开形状（不用 `decorateRequest`，也就不必 module augmentation）；
 * - request 被回收时条目自动消失，不会有内存泄漏。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

/** request → 起始时刻（`process.hrtime.bigint()` 的纳秒读数） */
const starts = new WeakMap<FastifyRequest, bigint>();

/** 注册 onRequest 计时钩子。 */
export function registerTiming(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    starts.set(request, process.hrtime.bigint());
  });
}

/**
 * 从 onRequest 起算的耗时（毫秒，保留 2 位小数，例如 `3.24`）。
 *
 * 没记录过（例如绕过插件直接调 handler）时返回 0，不抛错。
 */
export function elapsedMs(request: FastifyRequest): number {
  const start = starts.get(request);
  if (start === undefined) return 0;
  const ns = process.hrtime.bigint() - start;
  // ns → ms（保留 2 位小数）
  return Math.round(Number(ns) / 1e4) / 100;
}

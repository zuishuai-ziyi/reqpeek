/**
 * 应用装配（计划 §3 / §8）。
 *
 * `buildApp()` 一次性装好：插件 → 路由 → 错误处理。
 * `main.ts` 只负责「读配置 + listen」，集成测试也能直接
 * `buildApp(config)` 之后 `app.inject()`，不必真的监听端口。
 *
 * 路由表（计划 §3.1）：
 *
 * | 方法 | 路径 | 行为 |
 * | --- | --- | --- |
 * | ALL | `/` | 转储页 |
 * | ALL | `/*` | 同页（find-my-way 不保证 `/*` 匹配空段，故两个都注册） |
 * | ALL | `/api/echo` | 强制 JSON |
 * | GET | `/healthz` | `{"ok":true}`，不参与展示 |
 * | GET | `/_assets/app.css` `/_assets/app.js` | 启动时读入内存直接 send |
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Config } from './config.js';
import { collectRequestDump } from './core/collect.js';
import { type Masker, createMasker } from './core/mask.js';
import { isPayloadTooLarge, pathnameOf, registerGuards } from './plugins/guards.js';
import { registerSecurityHeaders } from './plugins/headers.js';
import { registerRawBody } from './plugins/rawBody.js';
import { registerRequestId, requestIdOf } from './plugins/requestId.js';
import { elapsedMs, registerTiming } from './plugins/timing.js';
import { renderJson } from './render/json.js';
import { renderPage } from './render/page.js';

/** 启动时读进内存的静态资源（读不到就是 null，路由给 404 兜底） */
export interface AssetBundle {
  css: string | null;
  js: string | null;
}

export interface BuildAppOptions {
  /** 覆盖 public 目录（测试用） */
  publicDir?: string;
}

/** 候选 public 目录：先按模块位置找（src/ 与 dist/src/ 都能落到项目根的 public/），再按 cwd 找。 */
function publicDirCandidates(options: BuildAppOptions): string[] {
  if (options.publicDir) return [options.publicDir];
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, '..', '..', 'public'), path.resolve(process.cwd(), 'public')];
}

/** 读一个资源文件；不存在就返回 null（不抛错，assets 还没构建时要能起得来）。 */
function readAsset(candidates: readonly string[], name: string): string | null {
  for (const dir of candidates) {
    try {
      return readFileSync(path.join(dir, name), 'utf8');
    } catch {
      // 试下一个候选目录
    }
  }
  return null;
}

/** Accept 里是否点名要 JSON。 */
function acceptsJson(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  if (!accept) return false;
  return accept.toLowerCase().includes('application/json');
}

/**
 * 建一个装配好的 Fastify 实例。
 */
export function buildApp(config: Config, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimit,
    // 计划 §7.3：不写请求日志（只保留启动与错误）
    logController: new LogController({ disableRequestLogging: true }),
    logger: { level: config.logLevel },
  });

  // ---- 插件 ----
  registerRawBody(app, config);
  registerTiming(app);
  registerRequestId(app);
  registerSecurityHeaders(app);
  registerGuards(app, config);

  // 脱敏器整个进程复用一份（纯函数，无状态）
  const masker: Masker = createMasker(config.maskMode);

  // ---- 静态资源（启动时读入内存）----
  const dirs = publicDirCandidates(options);
  const assets: AssetBundle = {
    css: readAsset(dirs, 'app.css'),
    js: readAsset(dirs, 'app.js'),
  };

  // ---- 路由 ----
  app.get('/healthz', async (_request, reply) => reply.code(200).send({ ok: true }));

  app.get('/_assets/app.css', async (_request, reply) => {
    if (assets.css === null) {
      return reply.code(404).type('text/plain; charset=utf-8').send('404 Not Found');
    }
    return reply.code(200).type('text/css; charset=utf-8').send(assets.css);
  });

  app.get('/_assets/app.js', async (_request, reply) => {
    if (assets.js === null) {
      return reply.code(404).type('text/plain; charset=utf-8').send('404 Not Found');
    }
    return reply.code(200).type('text/javascript; charset=utf-8').send(assets.js);
  });

  /** 转储 handler：`/`、`/*`、`/api/echo` 共用同一个（计划 §3.1）。 */
  const handleDump = async (request: FastifyRequest, reply: FastifyReply) => {
    const dump = collectRequestDump({
      request: request.raw,
      rawBody: request.rawBody,
      masker,
      maskMode: config.maskMode,
      requestId: requestIdOf(request),
    });
    // 渲染前求差（计划 §5.10）
    dump.meta.durationMs = elapsedMs(request);

    const wantsJson = pathnameOf(request) === '/api/echo' || acceptsJson(request);
    if (wantsJson) {
      // /api/echo 与 Accept: application/json 共用同一个渲染出口（计划 §3.1 / §11.10）：
      // 同一份 RequestDump → 同一份 JSON，strict 模式下同样走 sanitizeDump，不含明文。
      return reply.code(200).type('application/json; charset=utf-8').send(renderJson(dump));
    }
    return reply.code(200).type('text/html; charset=utf-8').send(renderPage(dump));
  };

  // 先注册具体路径，再注册通配（find-my-way 静态优先，但顺序上也不留坑）
  app.all('/api/echo', handleDump);
  app.all('/', handleDump);
  app.all('/*', handleDump);

  // ---- 错误处理 ----
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (isPayloadTooLarge(error)) {
      // 计划 §5.1：413 仍展示 header / 连接 / 链路，body 标「超限未读取」
      const dump = collectRequestDump({
        request: request.raw,
        rawBody: request.rawBody,
        masker,
        maskMode: config.maskMode,
        requestId: requestIdOf(request),
      });
      dump.meta.durationMs = elapsedMs(request);
      dump.body.present = false;
      dump.body.kind = 'empty';
      dump.body.truncated = true;
      dump.body.text = 'body 超限未读取（已收到的字节未保留）';
      return reply.code(413).type('text/html; charset=utf-8').send(renderPage(dump));
    }

    request.log.error({ err: error }, 'request failed');
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    // 不回显错误细节（计划 §7.3：错误信息本身也脱敏）
    return reply
      .code(status)
      .type('text/plain; charset=utf-8')
      .send(status === 500 ? '500 Internal Server Error' : 'Request Error');
  });

  // `/*` 已经覆盖了几乎所有路径，这里只是兜底：仍然给转储页而不是框架默认 JSON
  app.setNotFoundHandler((request, reply) => {
    const dump = collectRequestDump({
      request: request.raw,
      rawBody: request.rawBody,
      masker,
      maskMode: config.maskMode,
      requestId: requestIdOf(request),
    });
    dump.meta.durationMs = elapsedMs(request);
    return reply.code(404).type('text/html; charset=utf-8').send(renderPage(dump));
  });

  return app;
}

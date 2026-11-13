/**
 * 集成测试（`fastify.inject()`）—— 覆盖计划 §3.1 路由表与 §7 护栏。
 *
 * 与 `test/*.test.ts` 的单测互补：单测只测 core 层的纯函数，
 * 本文件测的是**装配**（插件 → 路由 → 错误处理 → 护栏）是否真的按计划接上了。
 *
 * 全部用例都不监听真实端口：`buildApp(config)` 之后直接 `app.inject()`。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestDump } from '../shared/types.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/** 本文件打开的 app，统一在 afterEach 里关掉（避免句柄泄漏）。 */
const opened: FastifyInstance[] = [];

/** 造一个 app；`publicDir` 省略时用默认候选目录。 */
function open(env: NodeJS.ProcessEnv = {}, publicDir?: string): FastifyInstance {
  const app = buildApp(loadConfig(env), publicDir === undefined ? {} : { publicDir });
  opened.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

/** 解析 JSON 出口的 dump。 */
function dumpOf(body: string): RequestDump {
  return JSON.parse(body) as RequestDump;
}

describe('路由表 §3.1', () => {
  it('GET / 返回 200 与 HTML 转储页骨架', async () => {
    const app = open();
    const res = await app.inject({ method: 'GET', url: '/dump-skeleton-check' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // HTML 骨架
    expect(res.body.toLowerCase()).toContain('<!doctype html>');
    expect(res.body.toLowerCase()).toContain('</html>');
    // 页面里能看到这一跳的请求目标（headline 的请求行与 url 行都带 target）
    expect(res.body).toContain('/dump-skeleton-check');
  });

  it('任意路径任意方法都走转储 handler', async () => {
    const app = open();

    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const) {
      const res = await app.inject({ method, url: '/foo/bar?q=1' });
      expect(res.statusCode, method).toBe(200);
      expect(res.headers['content-type'], method).toMatch(/text\/html/);
      expect(res.body, method).toContain('/foo/bar');
    }

    // HEAD 也要有响应（body 为空是 HTTP 语义，不是 404）
    const head = await app.inject({ method: 'HEAD', url: '/foo/bar' });
    expect(head.statusCode).toBe(200);
  });

  it('/api/echo 在 Accept: application/json 时返回 JSON', async () => {
    const app = open();
    const res = await app.inject({
      method: 'GET',
      url: '/api/echo',
      headers: { accept: 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);

    const dump = dumpOf(res.body);
    expect(dump.line.method).toBe('GET');
    expect(dump.url.pathname).toBe('/api/echo');
    expect(typeof dump.meta.id).toBe('string');
  });

  it('/api/echo 强制 JSON（即使 Accept 是 text/html）', async () => {
    const app = open();
    const res = await app.inject({
      method: 'GET',
      url: '/api/echo',
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(() => dumpOf(res.body)).not.toThrow();
    expect(dumpOf(res.body).url.pathname).toBe('/api/echo');
  });

  it('重复 header 原样保留（x-test: a + x-test: b）', async () => {
    const app = open();
    const res = await app.inject({
      method: 'GET',
      url: '/api/echo',
      headers: { 'x-test': ['a', 'b'] },
    });

    const dump = dumpOf(res.body);
    const repeated = dump.headers.filter((header) => header.lower === 'x-test');
    expect(repeated.map((header) => header.value)).toEqual(['a', 'b']);
    // 第二条指回第一条（UI 打 ×N 角标用）
    expect(repeated[1]?.dupOf).toBe(repeated[0]?.index);
    expect(dump.headerIndex['x-test']).toEqual(['a', 'b']);
  });

  it('/healthz 返回 {"ok":true} 且不含请求信息', async () => {
    const app = open();
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toBe('{"ok":true}');
    expect(res.body).not.toContain('headers');
  });

  it('/_assets 缺文件时 404 兜底', async () => {
    // 指向一个不存在的目录 → 两个资源都读不到
    const app = open({}, path.resolve(import.meta.dirname, '..', 'tmp', 'no-such-assets'));

    const css = await app.inject({ method: 'GET', url: '/_assets/app.css' });
    expect(css.statusCode).toBe(404);

    const js = await app.inject({ method: 'GET', url: '/_assets/app.js' });
    expect(js.statusCode).toBe(404);
  });

  it('/_assets 有文件时 200 直接 send', async () => {
    const dir = mkdtempSync(path.resolve(import.meta.dirname, '..', 'tmp', 'assets-'));
    try {
      writeFileSync(path.join(dir, 'app.css'), 'body { color: red; }', 'utf8');
      writeFileSync(path.join(dir, 'app.js'), 'console.log("hi");', 'utf8');

      const app = open({}, dir);

      const css = await app.inject({ method: 'GET', url: '/_assets/app.css' });
      expect(css.statusCode).toBe(200);
      expect(css.headers['content-type']).toMatch(/text\/css/);
      expect(css.body).toContain('color: red');

      const js = await app.inject({ method: 'GET', url: '/_assets/app.js' });
      expect(js.statusCode).toBe(200);
      expect(js.headers['content-type']).toMatch(/text\/javascript/);
      expect(js.body).toContain('hi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('护栏 §7.1 / §6.6', () => {
  it('未配置 ORIGIN_TOKEN 时不拦任何请求', async () => {
    const app = open();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
  });

  it('配置 ORIGIN_TOKEN 后：缺 token → 403，且不泄漏请求信息', async () => {
    const app = open({ ORIGIN_TOKEN: 'secret' });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-foo': 'bar' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('x-foo');
    expect(res.body).not.toContain('GET');
  });

  it('配置 ORIGIN_TOKEN 后：带 x-origin-token 头放行', async () => {
    const app = open({ ORIGIN_TOKEN: 'secret' });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-origin-token': 'secret' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<!doctype html>');
  });

  it('配置 ORIGIN_TOKEN 后：错误 token → 403', async () => {
    const app = open({ ORIGIN_TOKEN: 'secret' });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-origin-token': 'wrong' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('/healthz 与 /_assets/* 豁免 token 校验', async () => {
    const app = open({ ORIGIN_TOKEN: 'secret' });

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);

    const asset = await app.inject({ method: 'GET', url: '/_assets/app.css' });
    expect(asset.statusCode).not.toBe(403);
  });

  it('body 超限 → 413', async () => {
    const app = open({ BODY_LIMIT: '100b' });
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'text/plain' },
      payload: 'x'.repeat(5000),
    });

    expect(res.statusCode).toBe(413);
  });
});

describe('TRUST_PROXY 与转发链 §5.7', () => {
  it('dump 的 client ip 用 XFF，socket 对端单列', async () => {
    const app = open({ TRUST_PROXY: '1' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/echo',
      remoteAddress: '198.51.100.9',
      headers: { 'x-forwarded-for': '203.0.113.7, 172.70.1.4' },
    });

    expect(res.statusCode).toBe(200);
    const dump = dumpOf(res.body);

    // 声明值：XFF 最左值
    expect(dump.client.declaredClient).toBe('203.0.113.7');
    expect(dump.client.declaredSource).toBe('x-forwarded-for');
    // 事实：socket 对端（与声明值分开展示）
    expect(dump.client.socketPeer).toBe('198.51.100.9');

    // 链路：client → 中间跳 → 本机对端
    expect(dump.chain.hops[0]?.ip).toBe('203.0.113.7');
    expect(dump.chain.hops[0]?.kind).toBe('client');
    expect(dump.chain.hopCount).toBe(3);
  });
});

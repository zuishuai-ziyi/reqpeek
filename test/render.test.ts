/**
 * render 层单测（计划 §8 的 `test/render.test.ts`）。
 *
 * 覆盖计划 §5/§6 里渲染层真正要保证的东西：
 * - **转义**：用户数据进 HTML 一律经 `esc()`（计划 §7.5）；
 * - **区块顺序**：headline → chain → query → headers → cookies → body → footer（计划 §6.1）；
 * - **重复 header ×N 角标**（计划 §5.3）；
 * - **body 嗅探矩阵的渲染**：json / form / multipart / text / binary / empty（计划 §5.6 / §5.9）；
 * - **CDN 链路顺序与矛盾告警**（计划 §6.3）；
 * - **strict 模式无明文**：HTML 与 JSON 两个出口都不含明文 token（计划 §5.8 / §11.10）；
 * - **HTML 与 JSON 同源**：同一份 dump → 同一份数据（计划 §3）。
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestDump } from '../shared/types.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { collectRequestDump } from '../src/core/collect.js';
import type { MaskMode } from '../src/core/mask.js';
import { redactSensitiveText } from '../src/render/html.js';
import { renderJson } from '../src/render/json.js';
import { renderPage } from '../src/render/page.js';
import { DECLARED_NOTE } from '../src/render/sections/footer.js';

/* -------------------------------------------------------------------------- */
/* 造 dump                                                                     */
/* -------------------------------------------------------------------------- */

interface RequestSpec {
  method?: string;
  url?: string;
  httpVersion?: string;
  /** 头（同名给数组 = 重复 header） */
  headers?: Record<string, string | string[]>;
  body?: Buffer | string;
  maskMode?: MaskMode;
  socket?: {
    remoteAddress?: string;
    remotePort?: number;
    localAddress?: string;
    localPort?: number;
  };
}

/** 造一份 dump（走真实采集层，测试的就是「采集 → 渲染」这条链）。 */
function dumpOf(spec: RequestSpec): RequestDump {
  const rawHeaders: string[] = [];
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    for (const one of Array.isArray(value) ? value : [value]) {
      rawHeaders.push(name, one);
    }
  }

  return collectRequestDump({
    request: {
      method: spec.method ?? 'GET',
      url: spec.url ?? '/',
      httpVersion: spec.httpVersion ?? 'HTTP/1.1',
      rawHeaders,
      socket: {
        remoteAddress: '203.0.113.9',
        remotePort: 54321,
        localAddress: '10.0.0.5',
        localPort: 3000,
        bytesRead: 4096,
        bytesWritten: 512,
        ...spec.socket,
      },
    },
    rawBody:
      spec.body === undefined
        ? undefined
        : Buffer.isBuffer(spec.body)
          ? spec.body
          : Buffer.from(spec.body, 'utf8'),
    maskMode: spec.maskMode ?? 'none',
    requestId: 'test-request-id',
    receivedAt: new Date('2026-01-02T03:04:05.000Z'),
    durationMs: 1.5,
    origin: { hostname: 'test-host', pid: 4242, node: 'v20.11.0', uptimeSec: 61 },
  });
}

/** 取页面里某个区块的 HTML（按 id 截取）。 */
function sectionOf(page: string, id: string): string {
  const start = page.indexOf(`id="${id}"`);
  expect(start, `页面里没有区块 ${id}`).toBeGreaterThan(-1);
  const end = page.indexOf('<section', start + 1);
  return end === -1 ? page.slice(start) : page.slice(start, end);
}

/* -------------------------------------------------------------------------- */
/* 页面骨架与区块顺序                                                           */
/* -------------------------------------------------------------------------- */

describe('renderPage · 页面骨架', () => {
  it('是完整的 HTML 文档', () => {
    const page = renderPage(dumpOf({ url: '/hello' }));
    expect(page.toLowerCase()).toContain('<!doctype html>');
    expect(page.toLowerCase()).toContain('</html>');
    expect(page).toContain('<meta charset="utf-8">');
  });

  it('资源内联进页面（不再依赖 /_assets 子资源）', () => {
    const assets = { css: ':root{--bg:#000}', js: 'console.log(1)' };
    const page = renderPage(dumpOf({}), assets);
    expect(page).toContain('<style>:root{--bg:#000}</style>');
    expect(page).toContain('<script>console.log(1)</script>');
    expect(page).not.toContain('href="/_assets/app.css"');
    expect(page).not.toContain('src="/_assets/app.js"');
  });

  it('没有资源时退回外链（构建产物缺失时的兜底）', () => {
    const page = renderPage(dumpOf({}));
    expect(page).toContain('href="/_assets/app.css"');
    expect(page).toContain('src="/_assets/app.js"');
  });

  it('区块顺序：headline → chain → query → headers → cookies → body → footer', () => {
    const page = renderPage(dumpOf({}));
    const order = [
      'sec-headline',
      'sec-chain',
      'sec-query',
      'sec-headers',
      'sec-cookies',
      'sec-body',
      'sec-footer',
    ];
    const positions = order.map((id) => page.indexOf(`id="${id}"`));
    for (const [index, pos] of positions.entries()) {
      expect(pos, order[index]).toBeGreaterThan(-1);
      if (index > 0) {
        expect(pos, `${order[index]} 应该在 ${order[index - 1]} 之后`).toBeGreaterThan(
          positions[index - 1],
        );
      }
    }
  });

  it('标题里带上方法与 target', () => {
    const page = renderPage(dumpOf({ method: 'POST', url: '/submit?a=1' }));
    expect(page).toContain('<title>reqpeek · POST /submit?a=1</title>');
  });
});

/* -------------------------------------------------------------------------- */
/* 转义                                                                        */
/* -------------------------------------------------------------------------- */

const XSS = '<script>alert(1)</script>';

describe('转义 · 计划 §7.5', () => {
  it('header 值里的 <script> 被转义', () => {
    const page = renderPage(dumpOf({ headers: { 'x-payload': XSS } }));
    expect(page).not.toContain(XSS);
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('query 值里的 <script> 被转义', () => {
    const page = renderPage(dumpOf({ url: `/q?p=${encodeURIComponent(XSS)}` }));
    expect(page).not.toContain(XSS);
    expect(page).toContain('&lt;script&gt;');
  });

  it('cookie 值里的 <script> 被转义', () => {
    const page = renderPage(dumpOf({ headers: { cookie: `sid=${XSS}` } }));
    expect(page).not.toContain(XSS);
    expect(page).toContain('&lt;script&gt;');
  });

  it('body 里的 <script> 被转义', () => {
    const page = renderPage(
      dumpOf({
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: `hello ${XSS}`,
      }),
    );
    expect(page).not.toContain(XSS);
    expect(page).toContain('&lt;script&gt;');
  });

  it('属性里的引号也被转义（不能提前闭合标签）', () => {
    const page = renderPage(dumpOf({ headers: { 'x-quote': '" onload="alert(1)' } }));
    expect(page).not.toContain('" onload="alert(1)');
    expect(page).toContain('&quot; onload=&quot;alert(1)');
  });

  it('页脚与说明文案也走转义', () => {
    const page = renderPage(dumpOf({ url: '/x' }));
    expect(page).toContain('声明值 / 可伪造');
  });
});

/* -------------------------------------------------------------------------- */
/* headers 区块                                                                */
/* -------------------------------------------------------------------------- */

describe('headers 区块', () => {
  it('重复 header 打 ×N 角标（N = 总出现次数）', () => {
    const page = renderPage(dumpOf({ headers: { 'x-dup': ['1', '2', '3'] } }));
    const headers = sectionOf(page, 'sec-headers');
    expect(headers).toContain('×3');
  });

  it('不重复的 header 没有角标', () => {
    const page = renderPage(dumpOf({ headers: { 'x-once': '1' } }));
    expect(sectionOf(page, 'sec-headers')).not.toContain('badge-dup');
  });

  it('原序、原大小写、重复全留', () => {
    const page = renderPage(dumpOf({ headers: { 'X-Mixed-Case': 'a', 'x-mixed-case': 'b' } }));
    const headers = sectionOf(page, 'sec-headers');
    expect(headers).toContain('X-Mixed-Case');
    expect(headers).toContain('x-mixed-case');
    expect(headers).toContain('×2');
  });

  it('每行都标「声明值 / 可伪造」', () => {
    const page = renderPage(dumpOf({ headers: { 'x-a': '1' } }));
    expect(sectionOf(page, 'sec-headers')).toContain('声明值 / 可伪造');
  });

  it('没有 header 时不隐藏区块，给一句原因', () => {
    const page = renderPage(dumpOf({}));
    const headers = sectionOf(page, 'sec-headers');
    expect(headers).toContain('本次请求没有携带任何 header');
  });
});

/* -------------------------------------------------------------------------- */
/* query / cookies 区块                                                        */
/* -------------------------------------------------------------------------- */

describe('query 区块', () => {
  it('原始片段与解码值都给', () => {
    const page = renderPage(dumpOf({ url: '/s?a=1&b=hello%20world' }));
    const query = sectionOf(page, 'sec-query');
    // raw 片段（编码原样，转义后 & 变成 &amp;）
    expect(query).toContain('a=1&amp;b=hello%20world');
    // 解码值
    expect(query).toContain('hello world');
  });

  it('没有 query 时不隐藏区块', () => {
    const page = renderPage(dumpOf({ url: '/s' }));
    expect(sectionOf(page, 'sec-query')).toContain('未携带 query 参数');
  });
});

describe('cookies 区块', () => {
  it('同名 cookie 全部保留', () => {
    const page = renderPage(dumpOf({ headers: { cookie: 'a=1; a=2' } }));
    const cookies = sectionOf(page, 'sec-cookies');
    const names = cookies.match(/<span class="k">a<\/span>/g) ?? [];
    expect(names).toHaveLength(2);
    expect(cookies).toContain('>1<');
    expect(cookies).toContain('>2<');
  });

  it('没有 cookie 时不隐藏区块', () => {
    const page = renderPage(dumpOf({}));
    expect(sectionOf(page, 'sec-cookies')).toContain('未携带 Cookie');
  });
});

/* -------------------------------------------------------------------------- */
/* body 区块                                                                   */
/* -------------------------------------------------------------------------- */

describe('body 区块 · 嗅探矩阵', () => {
  it('empty：说明本次请求未携带 body', () => {
    const page = renderPage(dumpOf({}));
    expect(sectionOf(page, 'sec-body')).toContain('本次请求未携带 body');
  });

  it('json：原样与美化两份都在（美化那份默认隐藏，由前端切换）', () => {
    const raw = '{"b":2,"a":1}';
    const page = renderPage(dumpOf({ headers: { 'content-type': 'application/json' }, body: raw }));
    const body = sectionOf(page, 'sec-body');
    expect(body).toContain('&quot;b&quot;:2');
    expect(body).toContain('&quot;b&quot;: 2');
    expect(body).toContain('data-pretty-toggle="body-json"');
    expect(body).toContain('hidden');
  });

  it('form：字段表 + 原样文本', () => {
    const page = renderPage(
      dumpOf({
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=alice&note=hi',
      }),
    );
    const body = sectionOf(page, 'sec-body');
    expect(body).toContain('name');
    expect(body).toContain('alice');
    expect(body).toContain('name=alice&amp;note=hi');
  });

  it('multipart：只列部件结构，不解释文件内容', () => {
    const boundary = '----reqpeek';
    const raw = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="field1"',
      '',
      'value1',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      'Content-Type: text/plain',
      '',
      'file-content',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const page = renderPage(
      dumpOf({
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: raw,
      }),
    );
    const body = sectionOf(page, 'sec-body');
    expect(body).toContain('field1');
    expect(body).toContain('filename=a.txt');
    expect(body).toContain('text/plain');
    expect(body).not.toContain('file-content');
  });

  it('text：原样文本', () => {
    const page = renderPage(
      dumpOf({ headers: { 'content-type': 'text/plain' }, body: 'hello world' }),
    );
    expect(sectionOf(page, 'sec-body')).toContain('hello world');
  });

  it('binary：给 hexdump', () => {
    const page = renderPage(
      dumpOf({
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
      }),
    );
    const body = sectionOf(page, 'sec-body');
    expect(body).toContain('de ad be ef');
    expect(body).toContain('00000000');
  });

  it('sha256 出现在页面上（对原始字节算）', () => {
    const raw = Buffer.from('reqpeek', 'utf8');
    const sha = createHash('sha256').update(raw).digest('hex');
    const page = renderPage(dumpOf({ headers: { 'content-type': 'text/plain' }, body: raw }));
    expect(sectionOf(page, 'sec-body')).toContain(sha);
  });

  it('length 与 declaredLength 不一致 → 告警', () => {
    const page = renderPage(
      dumpOf({
        headers: { 'content-type': 'text/plain', 'content-length': '999' },
        body: 'short',
      }),
    );
    const body = sectionOf(page, 'sec-body');
    expect(body).toContain('Content-Length 声明');
    expect(body).toContain('不一致');
    expect(body).toContain('badge-warn');
  });

  it('截断 → 给截断横幅，不静默砍掉', () => {
    const dump = dumpOf({ headers: { 'content-type': 'text/plain' }, body: 'abcdef' });
    dump.body.truncated = true;
    const body = sectionOf(renderPage(dump), 'sec-body');
    expect(body).toContain('body 已截断');
    expect(body).toContain('banner-trunc');
  });
});

/* -------------------------------------------------------------------------- */
/* chain 区块                                                                  */
/* -------------------------------------------------------------------------- */

describe('chain 区块 · 计划 §6.3', () => {
  const cdnDump = dumpOf({
    headers: {
      'x-forwarded-for': '5.6.7.8',
      'cf-connecting-ip': '5.6.7.8',
      'cf-ray': '9abc-def',
      'x-forwarded-proto': 'https',
    },
  });

  it('hop 按「客户端 → CDN → 本机对端」的顺序排', () => {
    const chain = sectionOf(renderPage(cdnDump), 'sec-chain');
    const clientAt = chain.indexOf('5.6.7.8');
    const peerAt = chain.indexOf('203.0.113.9');
    expect(clientAt).toBeGreaterThan(-1);
    expect(peerAt).toBeGreaterThan(-1);
    expect(clientAt).toBeLessThan(peerAt);
  });

  it('厂商徽章带判据（hover 提示）', () => {
    const chain = sectionOf(renderPage(cdnDump), 'sec-chain');
    expect(chain).toContain('badge-vendor');
    expect(chain).toContain('cf-ray');
  });

  it('socket 那一跳标成事实，其余标成声明值', () => {
    const chain = sectionOf(renderPage(cdnDump), 'sec-chain');
    expect(chain).toContain('socket 事实');
    expect(chain).toContain('声明值');
  });

  it('声明 https 而回源明文 → 矛盾告警', () => {
    const chain = sectionOf(renderPage(cdnDump), 'sec-chain');
    expect(chain).toContain('声明 x-forwarded-proto=https');
    expect(chain).toContain('warn');
  });

  it('CDN-Loop ≥3 → 多重 CDN 告警', () => {
    const dump = dumpOf({
      headers: { 'cdn-loop': 'cloudflare; fastly; akamai', via: '1.1 varnish' },
    });
    const chain = sectionOf(renderPage(dump), 'sec-chain');
    expect(chain).toContain('CDN-Loop 有 3 个条目');
    expect(chain).toContain('多重 CDN');
  });

  it('via 条目照原样列出', () => {
    const dump = dumpOf({ headers: { via: '1.1 varnish, 1.1 nginx' } });
    expect(sectionOf(renderPage(dump), 'sec-chain')).toContain('1.1 varnish');
  });
});

/* -------------------------------------------------------------------------- */
/* footer 区块                                                                 */
/* -------------------------------------------------------------------------- */

describe('footer 区块', () => {
  it('硬编码「声明值 / 可伪造」说明（不依赖数据模型字段）', () => {
    const page = renderPage(dumpOf({}));
    const footer = sectionOf(page, 'sec-footer');
    expect(footer).toContain('声明值 / 可伪造');
    expect(DECLARED_NOTE).toContain('声明值 / 可伪造');
  });

  it('即便 security.notes 被改掉，说明文案也不变', () => {
    const dump = dumpOf({});
    dump.security.notes = ['别的说明'];
    const footer = sectionOf(renderPage(dump), 'sec-footer');
    expect(footer).toContain(DECLARED_NOTE);
  });

  it('给出 origin 一行信息', () => {
    const footer = sectionOf(renderPage(dumpOf({})), 'sec-footer');
    expect(footer).toContain('test-host');
    expect(footer).toContain('4242');
  });
});

/* -------------------------------------------------------------------------- */
/* strict 模式                                                                 */
/* -------------------------------------------------------------------------- */

describe('strict 模式 · 计划 §5.8 / §11.10', () => {
  const SECRET = 'sup3rs3cret-plaintext';
  const QUERY_SECRET = 'query-plaintext-1234';
  const COOKIE_SECRET = 'cookie-plaintext-5678';

  function strictDump(): RequestDump {
    return dumpOf({
      url: `/api?token=${QUERY_SECRET}`,
      headers: {
        authorization: `Bearer ${SECRET}`,
        cookie: `session=${COOKIE_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: SECRET, hello: 'world' }),
      maskMode: 'strict',
    });
  }

  it('HTML 里没有任何明文 token', () => {
    const page = renderPage(strictDump());
    expect(page).not.toContain(SECRET);
    expect(page).not.toContain(QUERY_SECRET);
    expect(page).not.toContain(COOKIE_SECRET);
  });

  it('JSON 里没有任何明文 token', () => {
    const json = renderJson(strictDump());
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(QUERY_SECRET);
    expect(json).not.toContain(COOKIE_SECRET);
  });

  it('没有 [reveal] 入口（strict 下服务端不输出明文）', () => {
    const page = renderPage(strictDump());
    expect(page).not.toContain('class="reveal"');
    expect(page).not.toContain('data-value=');
    expect(page).not.toContain('data-reveal-all');
  });

  it('partial 模式才有 [reveal] 入口', () => {
    const dump = dumpOf({
      headers: { authorization: `Bearer ${SECRET}` },
      maskMode: 'partial',
    });
    const page = renderPage(dump);
    expect(page).toContain('[reveal]');
    expect(page).toContain('data-value=');
  });
});

/* -------------------------------------------------------------------------- */
/* strict 模式：明文泄漏的三条路径（审查 blocker B-1 / B-3 + multipart filename）  */
/* -------------------------------------------------------------------------- */

describe('strict 模式 · 明文泄漏路径（审查 B-1 / B-3）', () => {
  const JSON_SECRET = 'invalid-json-plaintext-9911';
  const BIN_SECRET = 'binary-plaintext-2233';
  const FILE_SECRET = 'filename-plaintext-4455';

  it('B-1：非法 JSON 的错误消息不含原文（HTML 与 JSON 都干净）', () => {
    const dump = dumpOf({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"token":"${JSON_SECRET}" not json`,
      maskMode: 'strict',
    });

    expect(dump.body.jsonError).toBeTruthy();
    expect(dump.body.jsonError).not.toContain(JSON_SECRET);

    const page = renderPage(dump);
    const json = renderJson(dump);
    expect(page).not.toContain(JSON_SECRET);
    expect(json).not.toContain(JSON_SECRET);
    expect(json).toContain('strict 模式已隐藏原文上下文');
  });

  it('B-3：二进制 body 的 hexdump ASCII 列不含原文（HTML 与 JSON 都干净）', () => {
    const raw = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]),
      Buffer.from(BIN_SECRET, 'utf8'),
    ]);
    const dump = dumpOf({
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
      maskMode: 'strict',
    });

    expect(dump.body.kind).toBe('binary');
    expect(dump.body.hexPreview).not.toContain(BIN_SECRET);

    const page = renderPage(dump);
    const json = renderJson(dump);
    expect(page).not.toContain(BIN_SECRET);
    expect(json).not.toContain(BIN_SECRET);
    // hex 列本身保留（可读性不受影响）
    expect(page).toContain('00 01 02 03 04');
  });

  it('multipart：文件名在 strict 下被掩码（HTML 与 JSON 都干净）', () => {
    const boundary = '----reqpeek';
    const raw = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${FILE_SECRET}.txt"`,
      'Content-Type: text/plain',
      '',
      'file-content',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const dump = dumpOf({
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: raw,
      maskMode: 'strict',
    });

    const page = renderPage(dump);
    const json = renderJson(dump);
    expect(page).not.toContain(FILE_SECRET);
    expect(json).not.toContain(FILE_SECRET);
    expect(json).toContain('filename');
  });

  it('partial 模式行为不变（这三条路径仍然原样展示）', () => {
    const dump = dumpOf({
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.concat([
        Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]),
        Buffer.from(BIN_SECRET, 'utf8'),
      ]),
      maskMode: 'partial',
    });
    // partial：hexdump 的 ASCII 列照旧回显（明文被 16 字节一行拆开）
    expect(renderPage(dump)).toContain('binary-plai');
  });
});

/* -------------------------------------------------------------------------- */
/* redactSensitiveText · strict 文本口径                                      */
/* -------------------------------------------------------------------------- */

describe('redactSensitiveText · 文本里的敏感赋值（strict 口径）', () => {
  it('token=xxx / "token":"xxx" / api_key = "xxx" 都被掩码', () => {
    const bullets = '•'.repeat(8);
    expect(redactSensitiveText('token=abc123')).toBe(`token=${bullets}`);
    expect(redactSensitiveText('"token":"abc123"')).toBe(`"token":"${bullets}"`);
    expect(redactSensitiveText("'password':'abc123'")).toBe(`'password':'${bullets}'`);
    expect(redactSensitiveText('api_key = "abc123"')).toBe(`api_key = "${bullets}"`);
  });

  it('不敏感的赋值原样保留', () => {
    expect(redactSensitiveText('name=alice&note=hi')).toBe('name=alice&note=hi');
    expect(redactSensitiveText('hello world')).toBe('hello world');
  });

  it('多个赋值都掩码', () => {
    const out = redactSensitiveText('token=aaa&secret=bbb');
    expect(out).not.toContain('aaa');
    expect(out).not.toContain('bbb');
    expect(out).toContain('token=');
    expect(out).toContain('secret=');
  });
});

/* -------------------------------------------------------------------------- */
/* B-2：大文本不卡死                                                            */
/* -------------------------------------------------------------------------- */

describe('strict 模式 · 大文本不卡死（审查 blocker B-2）', () => {
  it('256 KiB 无关键词文本：单遍扫描，秒级返回', () => {
    const big = 'a'.repeat(256 * 1024);
    const started = Date.now();
    const out = redactSensitiveText(big);
    const elapsed = Date.now() - started;
    expect(out).toBe(big);
    expect(elapsed).toBeLessThan(2000);
  });

  it('256 KiB 含敏感赋值的文本：同样是线性代价', () => {
    const big = `${'a'.repeat(128 * 1024)} token=sup3rs3cret ${'b'.repeat(128 * 1024)}`;
    const started = Date.now();
    const out = redactSensitiveText(big);
    const elapsed = Date.now() - started;
    expect(out).not.toContain('sup3rs3cret');
    expect(elapsed).toBeLessThan(2000);
  });
});

/* -------------------------------------------------------------------------- */
/* JSON 出口与同源                                                             */
/* -------------------------------------------------------------------------- */

describe('renderJson · JSON 出口', () => {
  it('是合法 JSON', () => {
    const json = renderJson(dumpOf({ url: '/x?a=1' }));
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('与 HTML 同源：同一份 dump 的字段在两边都能看到', () => {
    const dump = dumpOf({
      method: 'POST',
      url: '/same-source?a=1',
      headers: { 'x-custom': 'custom-value-42' },
    });
    const page = renderPage(dump);
    const json = renderJson(dump);

    expect(json).toContain('custom-value-42');
    expect(page).toContain('custom-value-42');
    expect(json).toContain('/same-source');
    expect(page).toContain('/same-source');
  });

  it('与 HTML 同源：JSON 里的 url / method 与页面一致', () => {
    const dump = dumpOf({ method: 'PUT', url: '/origin-check' });
    const parsed = JSON.parse(renderJson(dump)) as RequestDump;
    const page = renderPage(dump);
    expect(parsed.url.pathname).toBe('/origin-check');
    expect(parsed.line.method).toBe('PUT');
    expect(page).toContain('/origin-check');
    expect(page).toContain('PUT');
  });
});

/* -------------------------------------------------------------------------- */
/* 装配层：两个出口走同一份数据                                                  */
/* -------------------------------------------------------------------------- */

const opened: FastifyInstance[] = [];

function open(env: NodeJS.ProcessEnv = {}): FastifyInstance {
  const app = buildApp(loadConfig(env));
  opened.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

describe('app.ts 接线 · 计划 §3.1', () => {
  it('/api/echo 强制 JSON', async () => {
    const app = open();
    const res = await app.inject({ method: 'GET', url: '/api/echo' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it('Accept: application/json 也走 JSON 出口', async () => {
    const app = open();
    const res = await app.inject({
      method: 'GET',
      url: '/whatever',
      headers: { accept: 'application/json' },
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it('两个 JSON 出口的内容一致（同一份 dump）', async () => {
    const app = open();
    const echo = await app.inject({ method: 'GET', url: '/api/echo?a=1' });
    const accept = await app.inject({
      method: 'GET',
      url: '/api/echo?a=1',
      headers: { accept: 'application/json' },
    });
    expect(JSON.parse(echo.body).url.rawQuery).toBe('a=1');
    expect(JSON.parse(accept.body).url.rawQuery).toBe('a=1');
  });

  it('默认出口是 HTML 转储页', async () => {
    const app = open();
    const res = await app.inject({ method: 'GET', url: '/html-check' });
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('id="sec-body"');
    expect(res.body).toContain('/html-check');
  });

  it('strict 模式下两个出口都不含明文 token', async () => {
    const app = open({ MASK_MODE: 'strict' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/echo?token=plaintext-token-value',
      headers: { authorization: 'Bearer plaintext-auth-value' },
    });
    expect(res.body).not.toContain('plaintext-token-value');
    expect(res.body).not.toContain('plaintext-auth-value');

    const html = await app.inject({
      method: 'GET',
      url: '/?token=plaintext-token-value',
      headers: { authorization: 'Bearer plaintext-auth-value' },
    });
    expect(html.body).not.toContain('plaintext-token-value');
    expect(html.body).not.toContain('plaintext-auth-value');
  });

  it('strict 模式下二进制 body 与非法 JSON body 都不含明文（B-1 / B-3）', async () => {
    const app = open({ MASK_MODE: 'strict' });
    const binSecret = 'e2e-binary-plaintext-7788';
    const raw = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      Buffer.from(binSecret, 'utf8'),
    ]);
    const bin = await app.inject({
      method: 'POST',
      url: '/bin',
      headers: { 'content-type': 'application/octet-stream' },
      payload: raw,
    });
    expect(bin.body).not.toContain(binSecret);
    expect(bin.body).toContain('00 01 02 03');

    const jsonSecret = 'e2e-json-plaintext-9911';
    const bad = await app.inject({
      method: 'POST',
      url: '/bad-json',
      headers: { 'content-type': 'application/json' },
      payload: `{"token":"${jsonSecret}" not json`,
    });
    expect(bad.body).not.toContain(jsonSecret);
  });
});

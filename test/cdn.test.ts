/**
 * cdn.ts 单测（计划 §6.3：厂商识别 / CDN-Loop / 矛盾告警 / 链路推断）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildChain,
  detectReverseProxy,
  detectVendors,
  headerVendor,
  isUnknownIp,
  parseCdnLoop,
  parseVia,
  vendorFromToken,
} from '../src/core/cdn.js';
import { collectChains } from '../src/core/forwarded.js';

const idx = (o: Record<string, string[]>): Record<string, string[] | undefined> => o;

describe('vendorFromToken', () => {
  it('从 Via / CDN-Loop 文本里认厂商', () => {
    expect(vendorFromToken('1.1 varnish')).toBe('fastly');
    expect(vendorFromToken('1.1 cloudfront')).toBe('cloudfront');
    expect(vendorFromToken('cloudflare')).toBe('cloudflare');
    expect(vendorFromToken('akamai')).toBe('akamai');
    expect(vendorFromToken('nginx/1.25.3')).toBe('nginx');
    expect(vendorFromToken('Caddy')).toBe('caddy');
    expect(vendorFromToken('traefik')).toBe('traefik');
    expect(vendorFromToken('bunnycdn')).toBe('bunny');
    expect(vendorFromToken('unknown')).toBeNull();
  });

  it('Akamai 的 ECS token 不认：计划 §6.3 只给了头名判据', () => {
    // 计划 §6.3（plans/request-inspector-plan.md:333）：Akamai 的判据是
    // `akamai-*` / `true-client-ip` / `x-akamai-*` 三个**头名**，
    // 没有把 Via / CDN-Loop 里的 'ECS (dcb/xxxx)' 纳入 token 检测，
    // 所以这里不引入计划外规则（Akamai 走 detectVendors 的头名判定）。
    expect(vendorFromToken('ECS (dcb/7F84)')).toBeNull();
  });
});

describe('parseVia / parseCdnLoop', () => {
  it('Via 支持逗号与多行', () => {
    expect(parseVia(idx({ via: ['1.1 varnish, 1.1 cloudfront'] }))).toEqual([
      '1.1 varnish',
      '1.1 cloudfront',
    ]);
    expect(parseVia(idx({ via: ['1.1 varnish', '1.1 nginx'] }))).toEqual([
      '1.1 varnish',
      '1.1 nginx',
    ]);
    expect(parseVia({})).toEqual([]);
  });

  it('CDN-Loop 逗号与分号都当分隔符（计划 §11.4 样例）', () => {
    expect(parseCdnLoop(idx({ 'cdn-loop': ['cloudflare; fastly'] }))).toEqual([
      'cloudflare',
      'fastly',
    ]);
    expect(parseCdnLoop(idx({ 'cdn-loop': ['cloudflare,fastly'] }))).toEqual([
      'cloudflare',
      'fastly',
    ]);
    expect(parseCdnLoop({})).toEqual([]);
  });
});

describe('detectVendors · 厂商识别', () => {
  const cases: [string, Record<string, string[]>, string][] = [
    ['cloudflare', { 'cf-ray': ['1'], 'cf-connecting-ip': ['2.2.2.2'] }, 'cloudflare'],
    ['fastly', { 'fastly-client-ip': ['2.2.2.2'] }, 'fastly'],
    ['fastly(x-served-by)', { 'x-served-by': ['cache'] }, 'fastly'],
    ['fastly(via varnish)', { via: ['1.1 varnish'] }, 'fastly'],
    ['cloudfront', { 'x-amz-cf-id': ['abc'] }, 'cloudfront'],
    ['akamai', { 'akamai-origin-hop': ['1'] }, 'akamai'],
    ['akamai(true-client-ip)', { 'true-client-ip': ['2.2.2.2'] }, 'akamai'],
    ['vercel', { 'x-vercel-id': ['abc'] }, 'vercel'],
    ['bunny(cdn-loop)', { 'cdn-loop': ['bunny'] }, 'bunny'],
    ['bunny(server)', { server: ['bunnycdn'] }, 'bunny'],
    ['aliyun', { 'ali-cdn-pv': ['1'] }, 'aliyun'],
    ['aliyun(x-cache)', { 'x-cache': ['HIT from aliyun'] }, 'aliyun'],
    ['tencent', { 'x-nws-log-uuid': ['abc'] }, 'tencent'],
    ['tencent(x-cache-lookup)', { 'x-cache-lookup': ['1'] }, 'tencent'],
  ];

  for (const [label, headers, expected] of cases) {
    it(`识别 ${label}`, () => {
      const vendors = detectVendors(idx(headers)).map((h) => h.vendor);
      expect(vendors).toContain(expected);
    });
  }

  it('命中时给出证据头名', () => {
    const hit = detectVendors(idx({ 'cf-ray': ['1'] }))[0];
    expect(hit?.evidence).toContain('cf-ray');
  });

  it('普通请求识别不到任何 CDN', () => {
    expect(detectVendors(idx({ host: ['example.com'], 'user-agent': ['curl/8'] }))).toEqual([]);
  });
});

describe('detectReverseProxy', () => {
  it('server 命中 nginx / caddy / traefik', () => {
    expect(detectReverseProxy(idx({ server: ['nginx/1.25'] }))?.vendor).toBe('nginx');
    expect(detectReverseProxy(idx({ server: ['Caddy'] }))?.vendor).toBe('caddy');
    expect(detectReverseProxy(idx({ server: ['traefik'] }))?.vendor).toBe('traefik');
  });

  it('x-real-ip 单独出现也判为 nginx', () => {
    const hit = detectReverseProxy(idx({ 'x-real-ip': ['1.2.3.4'] }));
    expect(hit?.vendor).toBe('nginx');
    expect(hit?.evidence).toContain('x-real-ip');
  });

  it('没有命中返回 null', () => {
    expect(detectReverseProxy(idx({ server: ['Apache'] }))).toBeNull();
  });
});

describe('headerVendor', () => {
  it('按头名给厂商徽章', () => {
    expect(headerVendor('CF-Ray', 'x')).toBe('cloudflare');
    expect(headerVendor('x-amz-cf-id', 'x')).toBe('cloudfront');
    expect(headerVendor('x-vercel-id', 'x')).toBe('vercel');
    expect(headerVendor('x-nws-log-uuid', 'x')).toBe('tencent');
    expect(headerVendor('cdn-loop', 'bunny')).toBe('bunny');
    expect(headerVendor('server', 'bunnycdn')).toBe('bunny');
  });

  it('无关头不给徽章', () => {
    expect(headerVendor('host', 'example.com')).toBeNull();
    expect(headerVendor('x-custom', 'v')).toBeNull();
  });
});

describe('buildChain · 链路', () => {
  it('hop 顺序 = 客户端 → 中间跳 → 本机对端', () => {
    const headers = idx({
      'x-forwarded-for': ['1.1.1.1, 2.2.2.2'],
      'cf-ray': ['8a1b-SIN'],
    });
    const selection = collectChains(headers, '3.3.3.3');
    const chain = buildChain({
      headers,
      socketPeer: '3.3.3.3',
      encrypted: false,
      selection,
    });

    expect(chain.hops.map((h) => h.ip)).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
    expect(chain.hops.map((h) => h.kind)).toEqual(['client', 'proxy', 'origin']);
    expect(chain.hops[1]?.vendor).toBe('cloudflare');
    expect(chain.hopCount).toBe(3);
    expect(chain.vendors).toContain('cloudflare');
  });

  it('私网地址标记 private', () => {
    const headers = idx({ 'x-forwarded-for': ['10.0.0.1'] });
    const chain = buildChain({
      headers,
      socketPeer: '10.0.0.2',
      encrypted: false,
      selection: collectChains(headers, '10.0.0.2'),
    });
    expect(chain.hops[0]?.private).toBe(true);
  });

  it('unknown 占位值的 hop kind 是 unknown', () => {
    const headers = idx({ 'x-forwarded-for': ['unknown'] });
    const chain = buildChain({
      headers,
      socketPeer: '10.0.0.2',
      encrypted: false,
      selection: collectChains(headers, '10.0.0.2'),
    });
    expect(chain.hops[0]?.kind).toBe('unknown');
    expect(isUnknownIp('_hidden')).toBe(true);
  });

  it('没有中间跳时本机对端带 CDN 徽章', () => {
    const headers = idx({ 'cf-ray': ['1'], 'cf-connecting-ip': ['1.1.1.1'] });
    const chain = buildChain({
      headers,
      socketPeer: '2.2.2.2',
      encrypted: false,
      selection: collectChains(headers, '2.2.2.2'),
    });
    const last = chain.hops[chain.hops.length - 1];
    expect(last?.ip).toBe('2.2.2.2');
    expect(last?.vendor).toBe('cloudflare');
  });
});

describe('buildChain · 矛盾告警', () => {
  it('CDN-Loop ≥3 条目 → 疑似多重 CDN 串联', () => {
    const headers = idx({ 'cdn-loop': ['cloudflare,fastly,akamai'] });
    const chain = buildChain({
      headers,
      socketPeer: '10.0.0.1',
      encrypted: false,
      selection: collectChains(headers, '10.0.0.1'),
    });
    expect(chain.cdnLoop).toHaveLength(3);
    expect(chain.warnings.join(' ')).toContain('CDN-Loop');
  });

  it('Via 厂商与 CDN-Loop 厂商不一致 → 告警', () => {
    const headers = idx({ via: ['1.1 varnish'], 'cdn-loop': ['cloudflare'] });
    const chain = buildChain({
      headers,
      socketPeer: '10.0.0.1',
      encrypted: false,
      selection: collectChains(headers, '10.0.0.1'),
    });
    expect(chain.warnings.join(' ')).toContain('不一致');
  });

  it('Via 与 CDN-Loop 厂商一致 → 不告警', () => {
    const headers = idx({ via: ['1.1 cloudflare'], 'cdn-loop': ['cloudflare'] });
    const chain = buildChain({
      headers,
      socketPeer: '10.0.0.1',
      encrypted: false,
      selection: collectChains(headers, '10.0.0.1'),
    });
    expect(chain.warnings.join(' ')).not.toContain('不一致');
  });

  it('XFF 最左值是私网 → 告警', () => {
    const headers = idx({ 'x-forwarded-for': ['10.0.0.9'] });
    const chain = buildChain({
      headers,
      socketPeer: '10.0.0.1',
      encrypted: false,
      selection: collectChains(headers, '10.0.0.1'),
    });
    expect(chain.warnings.join(' ')).toContain('私网');
  });

  it('声明 https 但到本机是明文 → 告警（只有 x-forwarded-proto、没有 XFF 也要触发）', () => {
    const headers = idx({ 'x-forwarded-proto': ['https'] });
    const chain = buildChain({
      headers,
      socketPeer: '10.0.0.1',
      encrypted: false,
      selection: collectChains(headers, '10.0.0.1'),
    });
    // 声明值来自 x-forwarded-proto 头，不依赖 IP 链主候选
    expect(chain.forwardedProto).toBe('https');
    expect(chain.warnings.join(' ')).toContain('https');
  });

  it('正常请求没有告警', () => {
    const headers = idx({ host: ['example.com'], 'x-forwarded-for': ['1.1.1.1'] });
    const chain = buildChain({
      headers,
      socketPeer: '10.0.0.1',
      encrypted: false,
      selection: collectChains(headers, '10.0.0.1'),
    });
    expect(chain.warnings).toEqual([]);
  });
});

/**
 * forwarded.ts 单测（计划 §5.7：候选链优先级 / 清洗 / 私网判定）。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_HOPS,
  SINGLE_IP_HEADERS,
  cleanIpToken,
  collectChains,
  firstHeader,
  isPrivateIp,
  normalizeIp,
  parseForwardedHeader,
  parseForwardedParams,
  parseXForwardedFor,
  pickForwardedProto,
  splitHostPort,
} from '../src/core/forwarded.js';

const idx = (o: Record<string, string[]>): Record<string, string[] | undefined> => o;

describe('cleanIpToken', () => {
  it('去掉引号与端口', () => {
    expect(cleanIpToken('"1.2.3.4"')).toBe('1.2.3.4');
    expect(cleanIpToken('1.2.3.4:5678')).toBe('1.2.3.4');
    expect(cleanIpToken('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(cleanIpToken('  1.2.3.4  ')).toBe('1.2.3.4');
  });

  it('unknown / _hidden 原样保留（不丢弃）', () => {
    expect(cleanIpToken('unknown')).toBe('unknown');
    expect(cleanIpToken('_hidden')).toBe('_hidden');
  });
});

describe('normalizeIp / isPrivateIp', () => {
  it('::ffff: 前缀归一化为 IPv4', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp(' 1.2.3.4 ')).toBe('1.2.3.4');
  });

  it('私网 / 环回 / CGNAT 判定', () => {
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp(null)).toBe(false);
    expect(isPrivateIp('')).toBe(false);
  });
});

describe('parseXForwardedFor', () => {
  it('逗号分隔，左边是最早/最像客户端', () => {
    expect(parseXForwardedFor('1.1.1.1, 2.2.2.2, 3.3.3.3')).toEqual([
      '1.1.1.1',
      '2.2.2.2',
      '3.3.3.3',
    ]);
  });

  it('带端口/引号/空片段也清洗干净', () => {
    expect(parseXForwardedFor('"1.1.1.1:123", , 2.2.2.2')).toEqual(['1.1.1.1', '2.2.2.2']);
  });
});

describe('Forwarded 头解析', () => {
  it('解析 for/proto/host', () => {
    const parsed = parseForwardedHeader('for=1.2.3.4;proto=https;host=example.com');
    expect(parsed?.source).toBe('forwarded');
    expect(parsed?.ips).toEqual(['1.2.3.4']);
    expect(parsed?.proto).toBe('https');
    expect(parsed?.host).toBe('example.com');
  });

  it('多段按出现顺序累积 for', () => {
    const parsed = parseForwardedHeader('for=1.2.3.4, for=5.6.7.8;proto=https');
    expect(parsed?.ips).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(parsed?.proto).toBe('https');
  });

  it('host 带端口时拆开', () => {
    const parsed = parseForwardedHeader('for=1.2.3.4;host=example.com:8443');
    expect(parsed?.host).toBe('example.com');
    expect(parsed?.port).toBe('8443');
  });

  it('host 带 v6 时拆开', () => {
    const parsed = parseForwardedHeader('for="[2001:db8::1]";host="[2001:db8::2]:443"');
    expect(parsed?.ips).toEqual(['2001:db8::1']);
    expect(parsed?.host).toBe('2001:db8::2');
    expect(parsed?.port).toBe('443');
  });

  it('无法解析时返回 null', () => {
    expect(parseForwardedHeader('')).toBeNull();
    expect(parseForwardedHeader('   ')).toBeNull();
  });

  it('parseForwardedParams 拆参数', () => {
    expect(parseForwardedParams('for=1.2.3.4;proto=https')).toEqual({
      for: '1.2.3.4',
      proto: 'https',
    });
  });

  it('splitHostPort 处理普通 host / 带端口 / v6', () => {
    expect(splitHostPort('example.com')).toEqual({ host: 'example.com', port: null });
    expect(splitHostPort('example.com:8080')).toEqual({ host: 'example.com', port: '8080' });
    expect(splitHostPort('[::1]:8080')).toEqual({ host: '::1', port: '8080' });
  });
});

describe('pickForwardedProto', () => {
  it('x-forwarded-proto 优先', () => {
    expect(pickForwardedProto(idx({ 'x-forwarded-proto': ['https'] }))).toBe('https');
    expect(pickForwardedProto(idx({ 'x-forwarded-proto': ['HTTPS, http'] }))).toBe('https');
  });

  it('x-forwarded-protocol 次之', () => {
    expect(pickForwardedProto(idx({ 'x-forwarded-protocol': ['https'] }))).toBe('https');
  });

  it('x-forwarded-ssl on/off 映射', () => {
    expect(pickForwardedProto(idx({ 'x-forwarded-ssl': ['on'] }))).toBe('https');
    expect(pickForwardedProto(idx({ 'x-forwarded-ssl': ['off'] }))).toBe('http');
  });

  it('都没有时返回 null', () => {
    expect(pickForwardedProto({})).toBeNull();
  });
});

describe('collectChains', () => {
  it('Forwarded 优先于 XFF', () => {
    const selection = collectChains(
      idx({ forwarded: ['for=1.1.1.1;proto=https'], 'x-forwarded-for': ['2.2.2.2'] }),
    );
    expect(selection.primary.source).toBe('forwarded');
    expect(selection.primary.ips).toEqual(['1.1.1.1']);
    expect(selection.candidates.map((c) => c.source)).toContain('x-forwarded-for');
  });

  it('XFF 优先于单值头', () => {
    const selection = collectChains(
      idx({ 'x-forwarded-for': ['2.2.2.2'], 'cf-connecting-ip': ['3.3.3.3'] }),
    );
    expect(selection.primary.source).toBe('x-forwarded-for');
  });

  it('socket 是最后兜底', () => {
    const selection = collectChains({}, '10.0.0.5');
    expect(selection.primary.source).toBe('socket');
    expect(selection.primary.ips).toEqual(['10.0.0.5']);
    expect(selection.declaredClient).toBe('10.0.0.5');
    expect(selection.declaredSource).toBe('socket');
  });

  it('declaredClient 取 Forwarded[0] → XFF[0] → 单值头', () => {
    const a = collectChains(idx({ forwarded: ['for=1.1.1.1'], 'x-forwarded-for': ['2.2.2.2'] }));
    expect(a.declaredClient).toBe('1.1.1.1');
    expect(a.declaredSource).toBe('forwarded');

    const b = collectChains(idx({ 'x-forwarded-for': ['2.2.2.2'], 'true-client-ip': ['3.3.3.3'] }));
    expect(b.declaredClient).toBe('2.2.2.2');
    expect(b.declaredSource).toBe('x-forwarded-for');

    const c = collectChains(idx({ 'true-client-ip': ['3.3.3.3'] }));
    expect(c.declaredClient).toBe('3.3.3.3');
    expect(c.declaredSource).toBe('true-client-ip');
  });

  it('超过 20 跳被截断并给出告警', () => {
    const many = Array.from({ length: 25 }, (_, i) => `10.0.0.${i}`).join(', ');
    const selection = collectChains(idx({ 'x-forwarded-for': [many] }));
    expect(selection.truncated).toBe(true);
    expect(selection.primary.ips).toHaveLength(MAX_HOPS);
    expect(selection.warnings.join(' ')).toContain('20');
  });

  it('proto / host / port 贯穿到候选链', () => {
    const selection = collectChains(
      idx({
        'x-forwarded-for': ['1.1.1.1'],
        'x-forwarded-proto': ['https'],
        'x-forwarded-host': ['example.com'],
        'x-forwarded-port': ['443'],
      }),
    );
    expect(selection.primary.proto).toBe('https');
    expect(selection.primary.host).toBe('example.com');
    expect(selection.primary.port).toBe('443');
  });

  it('只有 x-forwarded-proto（无 XFF）时 declared proto 仍然拿到', () => {
    const selection = collectChains(idx({ 'x-forwarded-proto': ['https'] }), '10.0.0.5');
    // 主链只能落到 socket 候选（proto = null = socket 层事实：明文）
    expect(selection.primary.source).toBe('socket');
    expect(selection.primary.proto).toBeNull();
    // 但「声明的协议」与 IP 链正交，必须拿到（计划 §6.3 的明文回源告警靠它触发）
    expect(selection.forwardedProto).toBe('https');
  });

  it('Forwarded 的 proto= 优先于 x-forwarded-proto', () => {
    const selection = collectChains(
      idx({ forwarded: ['for=1.1.1.1;proto=https'], 'x-forwarded-proto': ['http'] }),
    );
    expect(selection.forwardedProto).toBe('https');
    expect(selection.primary.proto).toBe('https');
  });

  it('没有任何 proto 头时 declared proto 为 null', () => {
    const selection = collectChains(idx({ 'x-forwarded-for': ['1.1.1.1'] }), '10.0.0.5');
    expect(selection.forwardedProto).toBeNull();
  });

  it('单值头顺序固定为 CF → True-Client-IP → …', () => {
    expect(SINGLE_IP_HEADERS[0]).toBe('cf-connecting-ip');
    expect(SINGLE_IP_HEADERS[1]).toBe('true-client-ip');
    expect(SINGLE_IP_HEADERS).toContain('x-real-ip');
  });

  it('firstHeader 取第一个值', () => {
    expect(firstHeader(idx({ via: ['a', 'b'] }), 'via')).toBe('a');
    expect(firstHeader({}, 'via')).toBeUndefined();
  });
});

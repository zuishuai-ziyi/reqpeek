/**
 * headers.ts 单测（计划 §8 的 test/headers.test.ts：顺序 / 大小写 / 重复）。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_HEADER_VALUE,
  duplicateCount,
  duplicateCounts,
  parseHeaders,
  rootIndex,
  truncateMiddle,
} from '../src/core/headers.js';
import { createMasker } from '../src/core/mask.js';

const none = createMasker('none');
const partial = createMasker('partial');

describe('parseHeaders', () => {
  it('保留原始顺序与原始大小写', () => {
    const raw = ['Host', 'example.com', 'X-Foo', 'Bar', 'User-Agent', 'curl/8.0'];
    const { entries } = parseHeaders(raw, none);

    expect(entries.map((e) => e.name)).toEqual(['Host', 'X-Foo', 'User-Agent']);
    expect(entries.map((e) => e.lower)).toEqual(['host', 'x-foo', 'user-agent']);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(entries.map((e) => e.value)).toEqual(['example.com', 'Bar', 'curl/8.0']);
  });

  it('重复 header 全部保留，并用 dupOf 串成链（×N 角标用）', () => {
    const raw = ['X-Foo', 'a', 'x-foo', 'b', 'X-FOO', 'c'];
    const { entries } = parseHeaders(raw, none);

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.value)).toEqual(['a', 'b', 'c']);
    expect(entries.map((e) => e.name)).toEqual(['X-Foo', 'x-foo', 'X-FOO']);
    expect(entries[0]?.dupOf).toBeNull();
    expect(entries[1]?.dupOf).toBe(0);
    expect(entries[2]?.dupOf).toBe(1);
  });

  it('headerIndex 按小写名归并重复键', () => {
    const raw = ['X-Foo', 'a', 'X-Foo', 'b', 'Host', 'example.com'];
    const { index } = parseHeaders(raw, none);

    expect(index['x-foo']).toEqual(['a', 'b']);
    expect(index.host).toEqual(['example.com']);
    expect(index['not-there']).toBeUndefined();
  });

  it('同名不同大小写算重复（大小写不敏感）', () => {
    const { index } = parseHeaders(['Set-Cookie', 'a=1', 'set-cookie', 'b=2'], none);
    expect(index['set-cookie']).toEqual(['a=1', 'b=2']);
  });

  it('敏感头在 partial 模式下标记为 masked，明文仍在 value 里', () => {
    const { entries } = parseHeaders(
      ['Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9abcdef'],
      partial,
    );
    const auth = entries[0];

    expect(auth?.sensitive).toBe(true);
    expect(auth?.masked).toBe(true);
    expect(auth?.value).toBe('Bearer eyJhbGciOiJIUzI1NiJ9abcdef');
  });

  it('整活要看的头保持明文', () => {
    const { entries } = parseHeaders(
      ['CF-Connecting-IP', '203.0.113.7', 'Via', '1.1 varnish'],
      partial,
    );
    expect(entries.every((e) => e.masked === false)).toBe(true);
  });

  it('给厂商徽章（cf-* → cloudflare）', () => {
    const { entries } = parseHeaders(['CF-Ray', '8a1b-SIN'], none);
    expect(entries[0]?.vendor).toBe('cloudflare');
  });

  it('空名字的头被忽略', () => {
    const { entries } = parseHeaders(['', 'x', 'Host', 'h'], none);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('Host');
  });
});

describe('重复计数', () => {
  const { entries } = parseHeaders(['X-Foo', 'a', 'X-Foo', 'b', 'Host', 'h'], none);

  it('duplicateCounts 统计同名出现次数', () => {
    const counts = duplicateCounts(entries);
    expect(counts.get('x-foo')).toBe(2);
    expect(counts.get('host')).toBe(1);
  });

  it('duplicateCount 返回单个名字的次数', () => {
    expect(duplicateCount(entries, 'x-foo')).toBe(2);
    expect(duplicateCount(entries, 'host')).toBe(1);
    expect(duplicateCount(entries, 'nope')).toBe(0);
  });

  it('rootIndex 找到重复组的根', () => {
    expect(rootIndex(entries, 1)).toBe(0);
    expect(rootIndex(entries, 2)).toBe(2);
  });
});

describe('truncateMiddle', () => {
  it('不超过上限时原样返回', () => {
    expect(truncateMiddle('short', 100)).toBe('short');
  });

  it('超限时中间省略并标出丢了多少', () => {
    const long = 'a'.repeat(500);
    const out = truncateMiddle(long, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain('已截断');
  });

  it('header 单值上限是 8 KiB（计划 §6.6）', () => {
    expect(MAX_HEADER_VALUE).toBe(8 * 1024);
    const { entries } = parseHeaders(['X-Big', 'b'.repeat(MAX_HEADER_VALUE + 100)], none);
    expect(entries[0]?.value.length).toBeLessThanOrEqual(MAX_HEADER_VALUE);
    expect(entries[0]?.value).toContain('已截断');
  });
});

/**
 * query.ts 单测（计划 §5.4：重复键保留 + 原始编码保留）。
 */

import { describe, expect, it } from 'vitest';
import { createMasker } from '../src/core/mask.js';
import { parseQuery, queryKeys } from '../src/core/query.js';

const none = createMasker('none');
const partial = createMasker('partial');

describe('parseQuery', () => {
  it('重复键全部保留，顺序不变', () => {
    const entries = parseQuery('x=1&x=2&x=3', none);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.value)).toEqual(['1', '2', '3']);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(entries.every((e) => e.key === 'x')).toBe(true);
  });

  it('raw 保留原始编码，key/value 是解码后的', () => {
    const entries = parseQuery('q=%E4%B8%AD%E6%96%87&space=a%20b', none);
    expect(entries[0]?.key).toBe('q');
    expect(entries[0]?.value).toBe('中文');
    expect(entries[0]?.raw).toBe('q=%E4%B8%AD%E6%96%87');
    expect(entries[1]?.value).toBe('a b');
    expect(entries[1]?.raw).toBe('space=a%20b');
  });

  it('没有值的键（?flag）也保留', () => {
    const entries = parseQuery('flag', none);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe('flag');
    expect(entries[0]?.value).toBe('');
    expect(entries[0]?.raw).toBe('flag');
  });

  it('敏感键名被标记为 masked（token / secret / code…）', () => {
    const entries = parseQuery('token=abc&ok=1&password=hunter2', partial);
    expect(entries[0]?.sensitive).toBe(true);
    expect(entries[0]?.masked).toBe(true);
    expect(entries[1]?.masked).toBe(false);
    expect(entries[2]?.masked).toBe(true);
  });

  it('空 query 返回空数组', () => {
    expect(parseQuery('', none)).toEqual([]);
    expect(parseQuery('?', none)).toEqual([]);
  });

  it('容忍前导的 ?', () => {
    const entries = parseQuery('?a=1', none);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe('a');
  });

  it('queryKeys 去重并保持首次出现顺序', () => {
    const entries = parseQuery('b=1&a=2&b=3', none);
    expect(queryKeys(entries)).toEqual(['b', 'a']);
  });
});

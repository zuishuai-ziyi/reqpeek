/**
 * cookies.ts 单测（计划 §5.5：切分不解码，另给解码副本）。
 */

import { describe, expect, it } from 'vitest';
import { decodeCookieValue, findCookie, parseCookieHeader } from '../src/core/cookies.js';
import { createMasker } from '../src/core/mask.js';

const none = createMasker('none');
const partial = createMasker('partial');

describe('parseCookieHeader', () => {
  it('按 ; 切分，值保持原样（不解码）', () => {
    const entries = parseCookieHeader(['a=1; b=2'], none);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: 'a', value: '1', masked: false });
    expect(entries[1]).toMatchObject({ name: 'b', value: '2', masked: false });
  });

  it('另给解码副本（decodeURIComponent）', () => {
    const entries = parseCookieHeader(['g=%E4%B8%AD%E6%96%87'], none);
    expect(entries[0]?.value).toBe('%E4%B8%AD%E6%96%87');
    expect(entries[0]?.decoded).toBe('中文');
  });

  it('解码失败时保留原值', () => {
    const entries = parseCookieHeader(['bad=%E0%A4%A'], none);
    expect(entries[0]?.value).toBe('%E0%A4%A');
    expect(entries[0]?.decoded).toBe('%E0%A4%A');
  });

  it('decodeCookieValue 直接可用', () => {
    expect(decodeCookieValue('a%20b')).toBe('a b');
    expect(decodeCookieValue('100%')).toBe('100%');
  });

  it('敏感名（session/token/auth/jwt/sid/csrf）被标记 masked', () => {
    const entries = parseCookieHeader(['sid=xyz; theme=dark'], partial);
    expect(entries[0]?.masked).toBe(true);
    expect(entries[1]?.masked).toBe(false);
  });

  it('同名 cookie 出现多次全部保留', () => {
    const entries = parseCookieHeader(['a=1; a=2'], none);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.value)).toEqual(['1', '2']);
  });

  it('多个 cookie 头都会解析', () => {
    const entries = parseCookieHeader(['a=1', 'b=2'], none);
    expect(entries.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('没有 = 的片段当成空值 cookie', () => {
    const entries = parseCookieHeader(['flag; a=1'], none);
    expect(entries[0]).toMatchObject({ name: 'flag', value: '' });
    expect(entries).toHaveLength(2);
  });

  it('空片段被忽略', () => {
    expect(parseCookieHeader(['; ; a=1;'], none)).toHaveLength(1);
  });

  it('没有 cookie 头时返回空数组', () => {
    expect(parseCookieHeader(undefined, none)).toEqual([]);
    expect(parseCookieHeader([], none)).toEqual([]);
  });

  it('strict 模式下解码副本也不含明文', () => {
    const strict = createMasker('strict');
    const entries = parseCookieHeader(['sid=supersecret'], strict);
    expect(entries[0]?.masked).toBe(true);
    expect(entries[0]?.value).not.toContain('supersecret');
    expect(entries[0]?.decoded ?? '').not.toContain('supersecret');
  });

  it('findCookie 按名字（忽略大小写）查找', () => {
    const entries = parseCookieHeader(['Sid=xyz'], none);
    expect(findCookie(entries, 'sid')?.value).toBe('xyz');
    expect(findCookie(entries, 'nope')).toBeNull();
  });
});

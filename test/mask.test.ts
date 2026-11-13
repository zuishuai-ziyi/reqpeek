/**
 * mask.ts 单测（计划 §8 的 test/mask.test.ts：partial / none / strict 三模式）。
 *
 * 规则全部来自计划 §5.8「部分脱敏」：
 * - 敏感项掩码，保留 `Bearer ` 之类的 scheme 前缀与末 4 位；
 * - `cf-connecting-ip` / `x-forwarded-for` / `true-client-ip` / `via` / `x-cache` / `cdn-loop` 明文；
 * - query 键名命中 `token|key|secret|password|passwd|sig|signature|code` 即掩码；
 * - cookie 名称命中 `session|token|auth|jwt|sid|csrf` 即掩码；
 * - `MASK_MODE=none` 全明文；`strict` 服务端不输出明文（也没有 [reveal]）。
 */

import { describe, expect, it } from 'vitest';
import { hexdump } from '../src/core/body.js';
import {
  PLAINTEXT_HEADERS,
  SENSITIVE_HEADERS,
  createMasker,
  displayValue,
  isPlaintextHeaderName,
  isSensitiveCookieName,
  isSensitiveHeaderName,
  isSensitiveQueryKey,
  maskHexAsciiColumn,
  maskJsonError,
  maskSecret,
  maskSecretStrict,
  renderMaskedValue,
  revealValue,
} from '../src/core/mask.js';

/** 统计掩码串里的 `•` 个数 */
const bullets = (s: string): number => (s.match(/•/g) ?? []).length;

describe('maskSecret · partial 掩码（计划 §5.8）', () => {
  it('保留 scheme 前缀与末 4 位', () => {
    const masked = maskSecret('Bearer eyJhbGciOiJIUzI1NiJ9abcdef');
    expect(masked).toBe(`Bearer ${'•'.repeat(12)}cdef`);
    expect(masked.startsWith('Bearer ')).toBe(true);
    expect(masked.endsWith('cdef')).toBe(true);
  });

  it('bullet 数上限 12（不外泄真实长度）', () => {
    const secret = 'x'.repeat(64);
    const masked = maskSecret(secret);
    expect(bullets(masked)).toBe(12);
    expect(masked.endsWith('xxxx')).toBe(true);
  });

  it('不超过 4 位时全部打点，不留尾巴', () => {
    expect(maskSecret('abc')).toBe('•••');
    expect(maskSecret('abcd')).toBe('••••');
    expect(maskSecret('')).toBe('');
  });

  it('超过 4 位时保留末 4 位', () => {
    expect(maskSecret('abcde')).toBe('•bcde');
  });

  it('已知 scheme 保留前缀（Token / Basic …）', () => {
    expect(maskSecret('Token abcdefgh')).toBe(`Token ${'•'.repeat(4)}efgh`);
  });

  it('未知 scheme 不保留前缀（避免把前缀当可信结构泄露）', () => {
    const masked = maskSecret('Weird abcdefghij');
    expect(masked.startsWith('Weird')).toBe(false);
    expect(masked.endsWith('ghij')).toBe(true);
  });
});

describe('maskSecretStrict · strict 掩码（不可逆）', () => {
  it('不含明文任何片段（连末 4 位也不给）', () => {
    const strict = maskSecretStrict('Bearer supersecret1234');
    expect(strict.startsWith('Bearer ')).toBe(true);
    expect(strict).not.toContain('supersecret');
    expect(strict).not.toContain('1234');
    expect(bullets(strict)).toBe(8);
  });

  it('无 scheme 的值也只给固定长度掩码', () => {
    const strict = maskSecretStrict('abcdefghijkl');
    expect(strict).toBe('•'.repeat(8));
    expect(strict).not.toContain('abcdefghijkl');
  });
});

describe('maskJsonError · strict 下抹掉 JSON 解析错误的原文（审查 B-1）', () => {
  it('Node 错误消息里内嵌的原文前缀被抹掉', () => {
    const raw = `Unexpected token 'p', "password=sup3rs3cret"... is not valid JSON`;
    const masked = maskJsonError(raw);
    expect(masked).not.toContain('sup3rs3cret');
    expect(masked).not.toContain('password');
    expect(masked).toContain('strict 模式已隐藏原文上下文');
  });

  it('位置信息保留（便于定位）', () => {
    const masked = maskJsonError(
      "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    );
    expect(masked).toContain('position 1');
    expect(masked).toContain('line 1 column 2');
    expect(masked).not.toContain('}');
  });

  it('幂等（strict 下重复过一遍不变）', () => {
    const once = maskJsonError(`Unexpected token 'p', "password=sup3rs3cret"... is not valid JSON`);
    expect(maskJsonError(once)).toBe(once);
  });
});

describe('maskHexAsciiColumn · strict 下把 hexdump 的 ASCII 列整列置点（审查 B-3）', () => {
  it('ASCII 列不再回显原始字节，hex 列保留', () => {
    const masked = maskHexAsciiColumn(hexdump(Buffer.from('secret123', 'utf8')));
    expect(masked).not.toContain('secret123');
    expect(masked).toContain('73 65 63 72');
  });

  it('ASCII 列里出现 | 也不会漏', () => {
    const masked = maskHexAsciiColumn(hexdump(Buffer.from('a|b', 'utf8')));
    expect(masked).not.toContain('a|b');
  });

  it('幂等', () => {
    const once = maskHexAsciiColumn(hexdump(Buffer.from('secret123', 'utf8')));
    expect(maskHexAsciiColumn(once)).toBe(once);
  });
});

describe('敏感项判定（计划 §5.8）', () => {
  it('isSensitiveHeaderName 命中计划列出的头名（大小写不敏感）', () => {
    for (const name of SENSITIVE_HEADERS) {
      expect(isSensitiveHeaderName(name)).toBe(true);
      expect(isSensitiveHeaderName(name.toUpperCase())).toBe(true);
    }
    expect(isSensitiveHeaderName('authorization')).toBe(true);
    expect(isSensitiveHeaderName('proxy-authorization')).toBe(true);
    expect(isSensitiveHeaderName('cookie')).toBe(true);
    expect(isSensitiveHeaderName('set-cookie')).toBe(true);
    expect(isSensitiveHeaderName('x-api-key')).toBe(true);
    expect(isSensitiveHeaderName('x-auth-token')).toBe(true);
  });

  it('isSensitiveHeaderName 不误伤普通头', () => {
    expect(isSensitiveHeaderName('host')).toBe(false);
    expect(isSensitiveHeaderName('x-forwarded-for')).toBe(false);
    expect(isSensitiveHeaderName('cf-ray')).toBe(false);
    expect(isSensitiveHeaderName('authorizationx')).toBe(false);
  });

  it('isPlaintextHeaderName 覆盖计划里的明文白名单', () => {
    for (const name of PLAINTEXT_HEADERS) {
      expect(isPlaintextHeaderName(name)).toBe(true);
      expect(isPlaintextHeaderName(name.toUpperCase())).toBe(true);
    }
    expect(isPlaintextHeaderName('cf-connecting-ip')).toBe(true);
    expect(isPlaintextHeaderName('x-forwarded-for')).toBe(true);
    expect(isPlaintextHeaderName('true-client-ip')).toBe(true);
    expect(isPlaintextHeaderName('via')).toBe(true);
    expect(isPlaintextHeaderName('x-cache')).toBe(true);
    expect(isPlaintextHeaderName('cdn-loop')).toBe(true);
    expect(isPlaintextHeaderName('authorization')).toBe(false);
  });

  it('isSensitiveQueryKey 命中 token|key|secret|password|passwd|sig|signature|code', () => {
    for (const key of [
      'token',
      'access_token',
      'apikey',
      'secret',
      'password',
      'passwd',
      'sig',
      'signature',
      'code',
    ]) {
      expect(isSensitiveQueryKey(key)).toBe(true);
    }
    expect(isSensitiveQueryKey('a')).toBe(false);
    expect(isSensitiveQueryKey('page')).toBe(false);
    expect(isSensitiveQueryKey('name')).toBe(false);
  });

  it('isSensitiveCookieName 命中 session|token|auth|jwt|sid|csrf', () => {
    for (const name of ['session', 'sessionid', 'token', 'auth', 'jwt', 'sid', 'csrf']) {
      expect(isSensitiveCookieName(name)).toBe(true);
    }
    expect(isSensitiveCookieName('theme')).toBe(false);
    expect(isSensitiveCookieName('lang')).toBe(false);
  });
});

describe('createMasker · 三种模式', () => {
  it('none：全明文，不掩码', () => {
    const masker = createMasker('none');
    const r = masker.header('authorization', 'Bearer abcdefgh');
    expect(r.sensitive).toBe(true);
    expect(r.masked).toBe(false);
    expect(r.value).toBe('Bearer abcdefgh');
    expect(masker.revealable).toBe(false);
    expect(masker.notes.join(' ')).toContain('MASK_MODE=none');
  });

  it('partial：标了 masked，但明文仍在（[reveal] 零往返）', () => {
    const masker = createMasker('partial');
    const r = masker.header('authorization', 'Bearer abcdefgh');
    expect(r.sensitive).toBe(true);
    expect(r.masked).toBe(true);
    expect(r.value).toBe('Bearer abcdefgh');
    expect(masker.revealable).toBe(true);
    expect(masker.notes.join(' ')).toContain('MASK_MODE=partial');
  });

  it('strict：服务端不输出明文，也没有 [reveal]', () => {
    const masker = createMasker('strict');
    const r = masker.header('authorization', 'Bearer abcdefgh');
    expect(r.sensitive).toBe(true);
    expect(r.masked).toBe(true);
    expect(r.value).not.toContain('abcdefgh');
    expect(r.value).not.toContain('gh');
    expect(masker.revealable).toBe(false);
    expect(masker.notes.join(' ')).toContain('MASK_MODE=strict');
  });

  it('明文白名单头在三种模式下都不掩码', () => {
    for (const mode of ['none', 'partial', 'strict'] as const) {
      const masker = createMasker(mode);
      for (const name of PLAINTEXT_HEADERS) {
        const r = masker.header(name, '203.0.113.7');
        expect(r.sensitive).toBe(false);
        expect(r.masked).toBe(false);
        expect(r.value).toBe('203.0.113.7');
      }
    }
  });

  it('query / cookie 走同一套判定', () => {
    const masker = createMasker('partial');
    expect(masker.query('token', 'abcdef').sensitive).toBe(true);
    expect(masker.query('token', 'abcdef').masked).toBe(true);
    expect(masker.query('page', '1').sensitive).toBe(false);
    expect(masker.query('page', '1').masked).toBe(false);
    expect(masker.cookie('sid', 'xyz').sensitive).toBe(true);
    expect(masker.cookie('theme', 'dark').sensitive).toBe(false);
  });

  it('strict 下 query / cookie 的值也不再是明文', () => {
    const masker = createMasker('strict');
    expect(masker.query('token', 'abcdefgh').value).not.toContain('abcdefgh');
    expect(masker.cookie('sid', 'xyz123').value).not.toContain('xyz123');
  });
});

describe('渲染层入口（displayValue / renderMaskedValue / revealValue）', () => {
  it('displayValue 按类别套用掩码，不敏感项原样', () => {
    expect(displayValue('header', 'authorization', 'Bearer secret1234')).toBe(
      `Bearer ${'•'.repeat(6)}1234`,
    );
    expect(displayValue('header', 'x-forwarded-for', '1.2.3.4')).toBe('1.2.3.4');
    expect(displayValue('query', 'token', 'abcdef')).toBe('••cdef');
    expect(displayValue('cookie', 'sid', 'abcdef')).toBe('••cdef');
  });

  it('renderMaskedValue：partial 才做掩码，strict 原样（值已是不可逆掩码）', () => {
    const entry = { name: 'authorization', value: 'Bearer secret1234', masked: true };
    expect(renderMaskedValue(entry, 'header', 'partial')).toBe(`Bearer ${'•'.repeat(6)}1234`);
    expect(renderMaskedValue(entry, 'header', 'strict')).toBe('Bearer secret1234');
    expect(renderMaskedValue(entry, 'header', 'none')).toBe('Bearer secret1234');
  });

  it('renderMaskedValue：未掩码的项原样返回', () => {
    const entry = { name: 'host', value: 'example.com', masked: false };
    expect(renderMaskedValue(entry, 'header', 'partial')).toBe('example.com');
  });

  it('revealValue：只有 partial 能揭示，strict / none 没有明文可揭示', () => {
    const entry = { value: 'Bearer secret1234', masked: true };
    expect(revealValue(entry, 'partial')).toBe('Bearer secret1234');
    expect(revealValue(entry, 'strict')).toBeNull();
    expect(revealValue(entry, 'none')).toBeNull();
    expect(revealValue({ value: 'x', masked: false }, 'partial')).toBeNull();
  });
});

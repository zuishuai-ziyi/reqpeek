/**
 * body.ts 单测（计划 §8 的 test/body.test.ts：嗅探矩阵 + 超限 + 非法 JSON）。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_HEX_BYTES,
  MAX_TEXT_LENGTH,
  decodeText,
  detectKind,
  hexdump,
  parseContentType,
  parseFormFields,
  parseMultipart,
  printableRatio,
  sha256,
  sniffBody,
  truncateText,
} from '../src/core/body.js';
import { createMasker } from '../src/core/mask.js';

const masker = createMasker('partial');

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('parseContentType', () => {
  it('拆出 mime 与 charset', () => {
    expect(parseContentType('application/json; charset=UTF-8')).toEqual({
      mime: 'application/json',
      charset: 'utf-8',
      boundary: null,
    });
  });

  it('取出 multipart 的 boundary（去引号）', () => {
    expect(parseContentType('multipart/form-data; boundary="----abc"').boundary).toBe('----abc');
  });

  it('空值返回空 mime', () => {
    expect(parseContentType(null).mime).toBe('');
    expect(parseContentType(undefined).mime).toBe('');
  });
});

describe('detectKind', () => {
  it('按 Content-Type 判定 kind', () => {
    expect(detectKind('application/json')).toBe('json');
    expect(detectKind('application/vnd.api+json')).toBe('json');
    expect(detectKind('application/x-www-form-urlencoded')).toBe('form');
    expect(detectKind('multipart/form-data')).toBe('multipart');
    expect(detectKind('text/plain')).toBe('text');
    expect(detectKind('application/xml')).toBe('text');
    expect(detectKind('application/graphql')).toBe('text');
    expect(detectKind('application/octet-stream')).toBeNull();
    expect(detectKind('')).toBeNull();
  });
});

describe('sniffBody · 嗅探矩阵', () => {
  it('json：解析出对象', () => {
    const body = sniffBody({
      raw: buf('{"k":"v"}'),
      contentType: 'application/json',
      masker,
    });
    expect(body.kind).toBe('json');
    expect(body.present).toBe(true);
    expect(body.json).toEqual({ k: 'v' });
    expect(body.text).toBe('{"k":"v"}');
    expect(body.jsonError).toBeUndefined();
  });

  it('json：+json 后缀也算 json', () => {
    const body = sniffBody({
      raw: buf('{"a":1}'),
      contentType: 'application/vnd.api+json',
      masker,
    });
    expect(body.kind).toBe('json');
    expect(body.json).toEqual({ a: 1 });
  });

  it('json：非法 JSON → jsonError，同时按 text 展示', () => {
    const body = sniffBody({
      raw: buf('{not json'),
      contentType: 'application/json',
      masker,
    });
    expect(body.kind).toBe('json');
    expect(body.jsonError).toBeTruthy();
    expect(body.json).toBeUndefined();
    expect(body.text).toBe('{not json');
  });

  it('form：字段表保留重复键', () => {
    const body = sniffBody({
      raw: buf('a=1&a=2&b=3'),
      contentType: 'application/x-www-form-urlencoded',
      masker,
    });
    expect(body.kind).toBe('form');
    expect(body.fields?.map((f) => [f.key, f.value])).toEqual([
      ['a', '1'],
      ['a', '2'],
      ['b', '3'],
    ]);
  });

  it('form：敏感字段名被掩码', () => {
    const body = sniffBody({
      raw: buf('token=abcdefghijkl'),
      contentType: 'application/x-www-form-urlencoded',
      masker,
    });
    expect(body.fields?.[0]?.masked).toBe(true);
  });

  it('multipart：只列 name/filename/contentType/length', () => {
    const boundary = '----X';
    const raw = buf(
      `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="pic.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`,
    );
    const body = sniffBody({
      raw,
      contentType: `multipart/form-data; boundary=${boundary}`,
      masker,
    });

    expect(body.kind).toBe('multipart');
    expect(body.parts).toHaveLength(2);
    expect(body.parts?.[0]).toEqual({
      name: 'a',
      filename: null,
      contentType: null,
      length: 1,
    });
    expect(body.parts?.[1]).toEqual({
      name: 'f',
      filename: 'pic.png',
      contentType: 'image/png',
      length: 7,
    });
  });

  it('text：按 charset 解码', () => {
    const body = sniffBody({
      raw: Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f]),
      contentType: 'text/plain; charset=iso-8859-1',
      masker,
    });
    expect(body.kind).toBe('text');
    expect(body.text).toBe('héllo');
    expect(body.charset).toBe('iso-8859-1');
  });

  it('text：非法 utf-8 字节用 U+FFFD 代替', () => {
    const body = sniffBody({
      raw: Buffer.from([0x61, 0xff, 0x62]),
      contentType: 'text/plain; charset=utf-8',
      masker,
    });
    expect(body.kind).toBe('text');
    expect(body.text).toBe('a\uFFFDb');
  });

  it('未识别类型：可打印 → text', () => {
    const body = sniffBody({
      raw: buf('just some plain text'),
      contentType: 'application/octet-stream',
      masker,
    });
    expect(body.kind).toBe('text');
    expect(body.text).toBe('just some plain text');
  });

  it('未识别类型：二进制 → binary + hexdump', () => {
    const raw = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const body = sniffBody({ raw, contentType: 'application/octet-stream', masker });
    expect(body.kind).toBe('binary');
    expect(body.hexPreview).toContain('00 01 02 ff fe');
    expect(body.length).toBe(5);
  });

  it('无 body → empty / present=false', () => {
    const body = sniffBody({ raw: undefined, contentType: null, masker });
    expect(body.kind).toBe('empty');
    expect(body.present).toBe(false);
    expect(body.length).toBe(0);
    expect(body.sha256).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  });

  it('压缩内容不解压，按原始字节展示', () => {
    const body = sniffBody({
      raw: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      contentType: 'application/json',
      contentEncoding: 'gzip',
      masker,
    });
    expect(body.kind).toBe('binary');
    expect(body.contentEncoding).toBe('gzip');
    expect(body.json).toBeUndefined();
    expect(body.hexPreview).toBeTruthy();
  });
});

describe('sniffBody · strict 模式不落明文（审查 B-1 / B-3 + multipart filename）', () => {
  const strictMasker = createMasker('strict');
  const SECRET = 'sup3rs3cret';

  it('hexdump 关掉 ASCII 列后不回显原始字节', () => {
    const out = hexdump(buf('secret123'), MAX_HEX_BYTES, { ascii: false });
    expect(out).not.toContain('secret123');
    expect(out).toContain('73 65 63 72');
    expect(out).toMatch(/\|\.+\|/);
  });

  it('json 解析失败：strict 下 jsonError 不含原文', () => {
    const body = sniffBody({
      raw: buf(`{"token":"${SECRET}" not json`),
      contentType: 'application/json',
      masker: strictMasker,
    });
    expect(body.jsonError).toBeTruthy();
    expect(body.jsonError).not.toContain(SECRET);
    expect(body.jsonError).toContain('strict 模式已隐藏原文上下文');
  });

  it('multipart：strict 下文件名被掩码', () => {
    const boundary = '----X';
    const raw = buf(
      `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="${SECRET}.txt"\r\nContent-Type: text/plain\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`,
    );
    const body = sniffBody({
      raw,
      contentType: `multipart/form-data; boundary=${boundary}`,
      masker: strictMasker,
    });
    expect(body.kind).toBe('multipart');
    expect(body.parts?.[0]?.filename).not.toContain(SECRET);
    expect(body.parts?.[0]?.filename).toBe('•'.repeat(8));
  });

  it('binary：strict 下 hexPreview 不含原文（hex 列保留）', () => {
    const raw = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03]), buf(SECRET)]);
    const body = sniffBody({
      raw,
      contentType: 'application/octet-stream',
      masker: strictMasker,
    });
    expect(body.kind).toBe('binary');
    expect(body.hexPreview).not.toContain(SECRET);
    expect(body.hexPreview).toContain('00 01 02 03');
  });

  it('partial 模式行为不变（jsonError 与文件名原样）', () => {
    const bad = sniffBody({
      raw: buf('{not json'),
      contentType: 'application/json',
      masker,
    });
    expect(bad.jsonError).toContain('JSON');

    const boundary = '----X';
    const raw = buf(
      `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="pic.png"\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`,
    );
    const multi = sniffBody({
      raw,
      contentType: `multipart/form-data; boundary=${boundary}`,
      masker,
    });
    expect(multi.parts?.[0]?.filename).toBe('pic.png');
  });
});

describe('body · sha256 / 长度口径', () => {
  it('sha256 对原始字节计算', () => {
    const raw = buf('hello');
    const body = sniffBody({ raw, contentType: 'text/plain', masker });
    expect(body.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(sha256(raw)).toBe(body.sha256);
  });

  it('declaredLength 保留 Content-Length 声明值（用于不一致告警）', () => {
    const raw = buf('{"k":"v"}');
    const body = sniffBody({
      raw,
      contentType: 'application/json',
      declaredLength: 999,
      masker,
    });
    // length = 实际收到的字节数（`{"k":"v"}` 是 9 字节）
    expect(body.length).toBe(9);
    expect(body.length).toBe(raw.length);
    // declaredLength = Content-Length 的**声明值**，与实际长度不一致 → UI 黄字告警
    expect(body.declaredLength).toBe(999);
    expect(body.declaredLength).not.toBe(body.length);
  });

  it('超限（bodyLimit）时标记 truncated 并记录已收字节数', () => {
    const body = sniffBody({
      raw: undefined,
      contentType: 'application/octet-stream',
      declaredLength: 2 * 1024 * 1024,
      truncated: true,
      receivedLength: 1024 * 1024,
      masker,
    });
    expect(body.truncated).toBe(true);
    expect(body.length).toBe(1024 * 1024);
    expect(body.present).toBe(false);
  });
});

describe('工具函数', () => {
  it('printableRatio 区分文本与二进制', () => {
    expect(printableRatio(buf('hello world'))).toBe(1);
    expect(printableRatio(Buffer.from([0, 1, 2, 3]))).toBe(0);
    expect(printableRatio(Buffer.alloc(0))).toBe(1);
  });

  it('hexdump 16 字节一行并带 ascii 列', () => {
    const out = hexdump(buf('abc'));
    expect(out).toContain('61 62 63');
    expect(out).toContain('|abc|');
  });

  it('hexdump 超过 4 KiB 截断并提示', () => {
    const raw = Buffer.alloc(MAX_HEX_BYTES + 10, 0x41);
    const out = hexdump(raw);
    expect(out).toContain('已截断');
    expect(MAX_HEX_BYTES).toBe(4 * 1024);
  });

  it('truncateText 按 256 KiB 上限截断', () => {
    expect(MAX_TEXT_LENGTH).toBe(256 * 1024);
    const long = 'x'.repeat(MAX_TEXT_LENGTH + 10);
    const out = truncateText(long);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('已截断');
    expect(truncateText('short').truncated).toBe(false);
  });

  it('decodeText 支持不支持的 charset 时回退 utf-8', () => {
    expect(decodeText(buf('abc'), 'definitely-not-a-charset')).toBe('abc');
  });

  it('parseFormFields 直接可用', () => {
    expect(parseFormFields('a=1&a=2', masker)).toHaveLength(2);
  });

  it('parseMultipart 找不到 boundary 时返回空数组', () => {
    expect(parseMultipart(buf('nothing'), 'X')).toEqual([]);
  });
});

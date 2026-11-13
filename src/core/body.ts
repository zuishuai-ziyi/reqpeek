/**
 * Body 嗅探（计划 §5.9）。
 *
 * 输入是**原始字节**（`request.rawBody`，由 plugins/rawBody.ts 接管 content-type parser 后拿到），
 * 输出是 `RequestDump.body`：
 *
 * | Content-Type | kind | 处理 |
 * | --- | --- | --- |
 * | `application/json`、`+json` | json | `JSON.parse`；失败 → `jsonError` + 按 text 展示 |
 * | `x-www-form-urlencoded` | form | `URLSearchParams` → 字段表（重复键保留） |
 * | `multipart/form-data` | multipart | 按 boundary 切分，只列 name/filename/contentType/length |
 * | `text/*`、`application/xml`、`application/graphql` | text | 按 charset 解码，非法字节用 U+FFFD |
 * | 其它 | 嗅探前 512 B 的 printableRatio > 0.9 → text，否则 binary | binary 给 hexdump + sha256 |
 * | 无 body | empty | `present = false` |
 *
 * sha256 永远对**原始字节**计算（node:crypto），与展示形态无关。
 *
 * 两个口径说明：
 * - `Content-Encoding: gzip/br/deflate` **不解压**（计划 §5.9）：按原始压缩字节展示
 *   （kind=binary + hexdump），声明的 `contentType` 仍原样保留，便于对照。
 * - `truncated` 同时覆盖两种截断：bodyLimit 超限（没读全）与展示上限（文本被砍）。
 */

import { createHash } from 'node:crypto';
import type { BodyKind, RequestDump } from '../../shared/types.js';
import type { Masker } from './mask.js';
import { maskJsonError, maskSecretStrict } from './mask.js';

/** 计划 §6.6：展示文本上限 256 KiB */
export const MAX_TEXT_LENGTH = 256 * 1024;

/** 计划 §6.6：hexdump 上限 4 KiB */
export const MAX_HEX_BYTES = 4 * 1024;

/** 计划 §5.9：嗅探窗口 512 B */
export const SNIFF_BYTES = 512;

/** 已知的压缩编码（不解压） */
const COMPRESSED_ENCODINGS = new Set(['gzip', 'x-gzip', 'br', 'deflate', 'zstd', 'compress']);

export interface ParsedContentType {
  /** 小写的 mime（不含参数） */
  mime: string;
  charset: string | null;
  /** multipart 的 boundary（已去掉引号） */
  boundary: string | null;
}

/**
 * 拆 Content-Type：`application/json; charset=utf-8` → mime + charset。
 */
export function parseContentType(value: string | null | undefined): ParsedContentType {
  if (!value) return { mime: '', charset: null, boundary: null };

  const [rawMime, ...rest] = value.split(';');
  const mime = (rawMime ?? '').trim().toLowerCase();
  let charset: string | null = null;
  let boundary: string | null = null;

  for (const param of rest) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    let val = param.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (key === 'charset') charset = val.toLowerCase();
    else if (key === 'boundary') boundary = val;
  }

  return { mime, charset, boundary };
}

/**
 * sha256（十六进制），永远对原始字节算。
 */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 按 charset 解码；非法字节用 U+FFFD 代替（TextDecoder 默认行为）。
 * charset 不被支持时回退 utf-8。
 */
export function decodeText(buf: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

/**
 * 可打印字节占比（计划 §5.9 的嗅探判据）。
 */
export function printableRatio(buf: Buffer): number {
  if (buf.length === 0) return 1;
  let printable = 0;
  for (const byte of buf) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable += 1;
    }
  }
  return printable / buf.length;
}

/** hexdump 的可选项。 */
export interface HexdumpOptions {
  /**
   * 是否把可打印字节按字符回显到 ASCII 列。
   *
   * strict 模式必须关掉（`ascii: false`）：ASCII 列就是 body 原文的明文
   * （审查 blocker B-3，计划 §5.8 / §11.10）。关掉后该列整列是 `.`。
   */
  ascii?: boolean;
}

/**
 * 经典 hexdump（16 字节一行：偏移 + hex + ascii）。
 */
export function hexdump(
  buf: Buffer,
  maxBytes: number = MAX_HEX_BYTES,
  options: HexdumpOptions = {},
): string {
  const showAscii = options.ascii !== false;
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const lines: string[] = [];

  for (let offset = 0; offset < slice.length; offset += 16) {
    const chunk = slice.subarray(offset, offset + 16);
    const hex: string[] = [];
    let ascii = '';
    for (const byte of chunk) {
      hex.push(byte.toString(16).padStart(2, '0'));
      ascii += showAscii && byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
    }
    const hexPart = hex.join(' ').padEnd(47, ' ');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexPart}  |${ascii}|`);
  }

  if (buf.length > maxBytes) {
    lines.push(`… 共 ${buf.length} 字节，已截断到前 ${maxBytes} 字节`);
  }
  return lines.join('\n');
}

/**
 * 按 Content-Type 判定 kind（null = 需要嗅探）。
 */
export function detectKind(mime: string): BodyKind | null {
  if (mime === '') return null;
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json';
  if (mime === 'application/x-www-form-urlencoded') return 'form';
  if (mime === 'multipart/form-data') return 'multipart';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/xml' || mime.endsWith('+xml')) return 'text';
  if (mime === 'application/graphql') return 'text';
  if (mime === 'application/javascript' || mime.endsWith('+javascript')) return 'text';
  return null;
}

/** multipart 分片信息 */
export interface MultipartPart {
  name: string | null;
  filename: string | null;
  contentType: string | null;
  length: number;
}

function extractDispositionParam(disposition: string, key: string): string | null {
  const re = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const m = re.exec(disposition);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/** 把一个 multipart 分片拆成「头 + 体」 */
function splitMultipartPart(segment: Buffer): { headers: Record<string, string>; body: Buffer } {
  const headers: Record<string, string> = {};
  const sep = segment.indexOf('\r\n\r\n');
  let headerEnd = sep;
  let bodyStart = sep + 4;
  if (sep === -1) {
    const lfSep = segment.indexOf('\n\n');
    if (lfSep === -1) {
      return { headers, body: Buffer.alloc(0) };
    }
    headerEnd = lfSep;
    bodyStart = lfSep + 2;
  }
  const headText = segment.subarray(0, headerEnd).toString('latin1');
  for (const line of headText.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = value;
  }
  return { headers, body: segment.subarray(bodyStart) };
}

/**
 * 解析 multipart/form-data：只列 name / filename / contentType / length，
 * 不解释文件内容（计划 §5.9）。
 */
export function parseMultipart(raw: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const delimiter = Buffer.from(`--${boundary}`);

  let pos = raw.indexOf(delimiter);
  if (pos === -1) return parts;
  pos += delimiter.length;

  while (pos < raw.length) {
    // "--" 收尾
    if (raw[pos] === 0x2d && raw[pos + 1] === 0x2d) break;
    // 跳过紧跟分隔符后的换行
    if (raw[pos] === 0x0d && raw[pos + 1] === 0x0a) pos += 2;
    else if (raw[pos] === 0x0a) pos += 1;

    const next = raw.indexOf(delimiter, pos);
    if (next === -1) break;

    let end = next;
    if (end >= 2 && raw[end - 2] === 0x0d && raw[end - 1] === 0x0a) end -= 2;
    else if (end >= 1 && raw[end - 1] === 0x0a) end -= 1;

    const { headers, body } = splitMultipartPart(raw.subarray(pos, end));
    const disposition = headers['content-disposition'] ?? '';
    parts.push({
      name: extractDispositionParam(disposition, 'name'),
      filename: extractDispositionParam(disposition, 'filename'),
      contentType: headers['content-type'] ?? null,
      length: body.length,
    });

    pos = next + delimiter.length;
  }

  return parts;
}

/**
 * 解析 application/x-www-form-urlencoded（重复键保留）。
 *
 * 字段的敏感性沿用 query 键名规则（mask.ts 的 query 入口），因为两者的键名语义一致。
 */
export function parseFormFields(
  text: string,
  masker: Masker,
): Array<{ key: string; value: string; masked: boolean }> {
  const out: Array<{ key: string; value: string; masked: boolean }> = [];
  for (const [key, value] of new URLSearchParams(text)) {
    const masked = masker.query(key, value);
    out.push({ key, value: masked.value, masked: masked.masked });
  }
  return out;
}

export interface BodyInput {
  /** 原始字节（没读到 / 超限时为 undefined） */
  raw?: Buffer | undefined;
  /** Content-Type 原始值 */
  contentType?: string | null;
  /** Content-Encoding 原始值 */
  contentEncoding?: string | null;
  /** Content-Length 声明值 */
  declaredLength?: number | null;
  /** 读取时是否被截断（bodyLimit 超限） */
  truncated?: boolean;
  /** 已接收到的字节数（超限时用；缺省取 raw.length） */
  receivedLength?: number;
  /** 脱敏器（form 字段用） */
  masker: Masker;
}

/**
 * 嗅探 body，产出 `RequestDump.body`。
 */
export function sniffBody(input: BodyInput): RequestDump['body'] {
  const raw = input.raw;
  const present = raw !== undefined && raw.length > 0;
  const bytes = raw ?? Buffer.alloc(0);
  const received = input.receivedLength ?? bytes.length;

  const contentTypeRaw = input.contentType ?? null;
  const ct = parseContentType(contentTypeRaw);
  const contentEncoding = input.contentEncoding?.trim().toLowerCase() || null;

  const body: RequestDump['body'] = {
    present,
    kind: 'empty',
    contentType: contentTypeRaw,
    charset: ct.charset,
    contentEncoding,
    length: received,
    declaredLength: input.declaredLength ?? null,
    truncated: input.truncated === true,
    sha256: sha256(bytes),
  };

  if (!present) return body;

  // strict 模式：服务端不输出任何明文（计划 §5.8 / §11.10）
  const strict = input.masker.mode === 'strict';

  // 压缩内容不解压：按原始字节展示
  if (contentEncoding && COMPRESSED_ENCODINGS.has(contentEncoding)) {
    body.kind = 'binary';
    body.hexPreview = hexdump(bytes, MAX_HEX_BYTES, { ascii: !strict });
    return body;
  }

  const declaredKind = detectKind(ct.mime);

  if (declaredKind === 'json') {
    body.kind = 'json';
    const text = decodeText(bytes, ct.charset);
    const shown = truncateText(text);
    body.text = shown.text;
    if (shown.truncated) body.truncated = true;
    try {
      body.json = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // strict：Node 的 JSON.parse 错误消息内嵌原文前缀 → 换成不含明文的文案
      // （审查 blocker B-1）
      body.jsonError = strict ? maskJsonError(message) : message;
    }
    return body;
  }

  if (declaredKind === 'form') {
    body.kind = 'form';
    const text = decodeText(bytes, ct.charset);
    const shown = truncateText(text);
    body.text = shown.text;
    if (shown.truncated) body.truncated = true;
    body.fields = parseFormFields(text, input.masker);
    return body;
  }

  if (declaredKind === 'multipart') {
    body.kind = 'multipart';
    const parts = ct.boundary ? parseMultipart(bytes, ct.boundary) : [];
    // strict：文件名本身可能带敏感信息（`secret123.txt`）→ 换成不可逆掩码
    body.parts = strict
      ? parts.map((part) => ({
          ...part,
          filename: part.filename === null ? null : maskSecretStrict(part.filename),
        }))
      : parts;
    return body;
  }

  if (declaredKind === 'text') {
    body.kind = 'text';
    const shown = truncateText(decodeText(bytes, ct.charset));
    body.text = shown.text;
    if (shown.truncated) body.truncated = true;
    return body;
  }

  // 未识别类型 → 嗅探前 512 B
  const window = bytes.subarray(0, SNIFF_BYTES);
  if (printableRatio(window) > 0.9) {
    body.kind = 'text';
    const shown = truncateText(decodeText(bytes, ct.charset));
    body.text = shown.text;
    if (shown.truncated) body.truncated = true;
    return body;
  }

  body.kind = 'binary';
  body.hexPreview = hexdump(bytes, MAX_HEX_BYTES, { ascii: !strict });
  return body;
}

/**
 * 展示文本截断（计划 §6.6：256 KiB）。
 */
export function truncateText(
  text: string,
  limit: number = MAX_TEXT_LENGTH,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}…[已截断，共 ${text.length} 字符]`, truncated: true };
}

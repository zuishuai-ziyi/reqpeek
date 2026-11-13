/**
 * 部分脱敏（计划 §5.8）。
 *
 * 这是**唯一的脱敏出口**：header / query / cookie / form field 的掩码都在这里算，
 * 其它模块只负责判断「这一项敏不敏感」。
 *
 * 三种模式（`MASK_MODE`）：
 * - `none`   ：全明文，`masked` 恒为 false。
 * - `partial`：敏感项 `masked = true`，但 `value` **仍然保留明文**（页面 [reveal] 零往返揭示用）；
 *              渲染时必须调用 {@link renderMaskedValue} / {@link displayValue} 把它渲染成掩码串。
 * - `strict` ：服务端不输出任何明文，`value` 直接被替换成**不可逆**掩码（不含末 4 位），
 *              且 `revealable = false`（页面不出现 [reveal] 入口）。
 *
 * 掩码格式（计划 §5.8 示例 `Bearer ••••••••a1b2`）：
 * - 保留 `Bearer ` 之类的 scheme 前缀；
 * - 中间用 `•` 覆盖，条数 = min(明文长度 - 4, 12)；
 * - 保留末 4 位。
 */

export type MaskMode = 'none' | 'partial' | 'strict';

/** 永远明文的头（计划 §5.8：整活要的就是这些值） */
export const PLAINTEXT_HEADERS: readonly string[] = [
  'cf-connecting-ip',
  'x-forwarded-for',
  'true-client-ip',
  'via',
  'x-cache',
  'cdn-loop',
];

/** 需要掩码的头（计划 §5.8） */
export const SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
];

/** query 键名命中即掩码（计划 §5.8） */
export const SENSITIVE_QUERY_KEY_RE = /token|key|secret|password|passwd|sig|signature|code/i;

/** cookie 名称命中即掩码（计划 §5.8） */
export const SENSITIVE_COOKIE_NAME_RE = /session|token|auth|jwt|sid|csrf/i;

/** 已知认证 scheme：只有这些才保留「`Bearer ` 之类」的前缀 */
const KNOWN_SCHEMES: ReadonlySet<string> = new Set([
  'bearer',
  'basic',
  'digest',
  'hmac',
  'negotiate',
  'oauth',
  'token',
  'jwt',
  'signature',
  'aws4-hmac-sha256',
]);

const SCHEME_RE = /^([A-Za-z][A-Za-z0-9._+-]*)([ \t]+)([\s\S]*)$/;

/** strict 模式固定使用的掩码长度（不泄露原长度） */
const STRICT_BULLETS = 8;

/** partial 模式掩码条数上限 */
const MAX_BULLETS = 12;

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADERS.includes(name.trim().toLowerCase());
}

export function isPlaintextHeaderName(name: string): boolean {
  return PLAINTEXT_HEADERS.includes(name.trim().toLowerCase());
}

export function isSensitiveQueryKey(key: string): boolean {
  return SENSITIVE_QUERY_KEY_RE.test(key);
}

export function isSensitiveCookieName(name: string): boolean {
  return SENSITIVE_COOKIE_NAME_RE.test(name);
}

interface SchemeSplit {
  prefix: string;
  rest: string;
}

function splitScheme(value: string): SchemeSplit | null {
  const m = SCHEME_RE.exec(value);
  if (!m) return null;
  if (!KNOWN_SCHEMES.has(m[1].toLowerCase())) return null;
  return { prefix: m[1] + m[2], rest: m[3] };
}

function maskTail(secret: string): string {
  if (secret.length === 0) return '';
  if (secret.length <= 4) return '•'.repeat(secret.length);
  return '•'.repeat(Math.min(secret.length - 4, MAX_BULLETS)) + secret.slice(-4);
}

/**
 * partial 模式掩码：保留 scheme 前缀 + 末 4 位，中间用 `•` 覆盖。
 * 例：`Bearer eyJhbGciOiJIUzI1NiJ9abcdef` → `Bearer ••••••••cdef`
 */
export function maskSecret(value: string): string {
  const split = splitScheme(value);
  return split ? split.prefix + maskTail(split.rest) : maskTail(value);
}

/**
 * strict 模式掩码：不可逆，**不含明文任何片段**（连末 4 位也不给）。
 */
export function maskSecretStrict(value: string): string {
  const bullets = '•'.repeat(STRICT_BULLETS);
  const split = splitScheme(value);
  return split ? split.prefix + bullets : bullets;
}

/**
 * strict 模式下把 JSON 解析错误消息里的原文上下文抹掉（计划 §5.8 / §11.10）。
 *
 * Node ≥ 20 的 `JSON.parse` 错误消息会内嵌原始文本的前缀，例如：
 *
 * ```
 * Unexpected token 'p', "password=s"... is not valid JSON
 * ```
 *
 * 那等于把 body 原文又漏了一遍（审查 blocker B-1）。strict 下只保留位置信息，
 * 其余内容一律不保留。
 */
export function maskJsonError(message: string): string {
  const position = /position (\d+)/.exec(message);
  const lineColumn = /line (\d+) column (\d+)/.exec(message);
  const details: string[] = [];
  if (position) details.push(`position ${position[1]}`);
  if (lineColumn) details.push(`line ${lineColumn[1]} column ${lineColumn[2]}`);
  const suffix = details.length > 0 ? `（${details.join(' / ')}）` : '';
  return `strict 模式已隐藏原文上下文${suffix}`;
}

/**
 * strict 模式下把 hexdump 的 ASCII 列整列置 `.`（计划 §5.8 / §11.10）。
 *
 * ASCII 列把可打印字节按字符回显 —— 那就是 body 原文的明文（审查 blocker B-3）。
 * hex 列本身不含明文，保留可读性；本函数是幂等的（对已置点的列再跑一次结果不变）。
 */
export function maskHexAsciiColumn(hexPreview: string): string {
  // 行格式：`00000000  <47 个 hex 字符>  |ascii|`
  // ASCII 列里可能出现 `|`，所以用贪婪的 `(.*)` 取到行尾最后一个 `|` 为止。
  return hexPreview.replace(
    /^([0-9a-f]{8} {2}.{47} {2}\|)(.*)(\|)$/gm,
    (_match, head: string, ascii: string) => `${head}${'.'.repeat(ascii.length)}|`,
  );
}

export interface MaskedValue {
  /** 这一项敏感（无论当前是否掩码） */
  sensitive: boolean;
  /** 界面上必须以掩码形式展示 */
  masked: boolean;
  /** 实际存放的值：none/partial = 明文，strict = 不可逆掩码 */
  value: string;
}

export interface Masker {
  readonly mode: MaskMode;
  /** 是否允许 [reveal]（只有 partial 允许） */
  readonly revealable: boolean;
  /** 页脚要明示的说明（计划 §5.8 security.notes） */
  readonly notes: string[];
  header(name: string, value: string): MaskedValue;
  query(key: string, value: string): MaskedValue;
  cookie(name: string, value: string): MaskedValue;
}

export function createMasker(mode: MaskMode): Masker {
  const notes: string[] = [];
  if (mode === 'none') {
    notes.push('MASK_MODE=none：敏感值未做任何脱敏，全部以明文展示。');
  } else if (mode === 'partial') {
    notes.push(
      'MASK_MODE=partial：掩码项的明文仍随页面与 JSON 一同下发，仅在点击 [reveal] 时显示；请勿直接分享页面源码。',
    );
  } else {
    notes.push('MASK_MODE=strict：服务端不输出任何明文，页面不提供 [reveal] 入口。');
  }

  const apply = (sensitive: boolean, value: string): MaskedValue => {
    if (!sensitive || mode === 'none') return { sensitive, masked: false, value };
    if (mode === 'partial') return { sensitive, masked: true, value };
    return { sensitive, masked: true, value: maskSecretStrict(value) };
  };

  return {
    mode,
    revealable: mode === 'partial',
    notes,
    header(name, value) {
      const lower = name.trim().toLowerCase();
      if (isPlaintextHeaderName(lower)) return { sensitive: false, masked: false, value };
      return apply(isSensitiveHeaderName(lower), value);
    },
    query(key, value) {
      return apply(isSensitiveQueryKey(key), value);
    },
    cookie(name, value) {
      return apply(isSensitiveCookieName(name), value);
    },
  };
}

export type MaskKind = 'header' | 'query' | 'cookie';

/**
 * 把明文渲染成掩码串（partial 模式下渲染层用）。
 * 不敏感项原样返回。
 */
export function displayValue(kind: MaskKind, name: string, value: string): string {
  const sensitive =
    kind === 'header'
      ? isSensitiveHeaderName(name)
      : kind === 'query'
        ? isSensitiveQueryKey(name)
        : isSensitiveCookieName(name);
  return sensitive ? maskSecret(value) : value;
}

/**
 * 渲染层入口：给定 dump 里的一项，返回**应该显示**的字符串。
 *
 * - `masked = false`：原样显示；
 * - partial：`value` 仍是明文，这里才做掩码；
 * - strict：`value` 已是不可逆掩码，原样显示。
 */
export function renderMaskedValue(
  entry: { name: string; value: string; masked: boolean },
  kind: MaskKind,
  mode: MaskMode,
): string {
  if (!entry.masked) return entry.value;
  if (mode === 'partial') return displayValue(kind, entry.name, entry.value);
  return entry.value;
}

/**
 * 渲染层入口：给定 dump 里的一项，返回 [reveal] 后应该显示的明文。
 * strict / none 模式一律返回 null（没有明文可揭示）。
 */
export function revealValue(
  entry: { value: string; masked: boolean },
  mode: MaskMode,
): string | null {
  if (!entry.masked) return null;
  if (mode !== 'partial') return null;
  return entry.value;
}

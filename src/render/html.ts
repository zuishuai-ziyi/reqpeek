/**
 * 渲染层共用的 HTML 原语（计划 §6.2 / §6.5 / §7.5）。
 *
 * 这一层只放**与请求数据无关**的小工具，数据相关的部分在 sections/*.ts：
 *
 * - `esc()`：所有用户数据的唯一出口（计划 §7.5：全部用户数据经 esc()）；
 * - `section()`：区块外壳（一行「标题 …… 计数」+ 1px 线，计划 §6.2）；
 * - `row()` / `rowTags()` / `rowHtml()`：键值行（计划 §6.5：grid 168px + 1fr）；
 * - `badge()` / `vendorBadge()`：徽章（`[cf]` / `×2` / `[!]` 都带文字，不只靠颜色，计划 §6.5）；
 * - `maskedCell()`：掩码值 + `[reveal]` 入口（计划 §6.4：data-mask / data-value）；
 * - `tagDeclared()` / `tagFact()`：「声明值 / 可伪造」与「socket 事实」的区分标记（计划 §1.1）；
 * - `sanitizeDump()`：strict 模式下的展示口径统一（HTML 与 JSON 走同一份）。
 *
 * 转义约定（计划 §7.5）：
 * - **凡是拼进 HTML 的用户数据都必须经过 `esc()`**；
 * - `row()` / `rowTags()` 默认转义键与值；
 * - `rowHtml()` 收的是已经拼好的 HTML 片段，调用方自负其责（只在需要 `[reveal]` 按钮时用）。
 */

import type { RequestDump } from '../../shared/types.js';
import type { MaskKind, MaskMode } from '../core/mask.js';
import {
  isSensitiveQueryKey,
  maskHexAsciiColumn,
  maskJsonError,
  maskSecretStrict,
  renderMaskedValue,
  revealValue,
} from '../core/mask.js';

/** HTML 文本转义（计划 §7.5：全部用户数据经 esc()）。 */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON 安全嵌入：`<` 转成 `<`（计划 §7.5），
 * 避免 `</script>` / `<!--` 之类的字符提前闭合标签。
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

/* -------------------------------------------------------------------------- */
/* 区块外壳                                                                    */
/* -------------------------------------------------------------------------- */

export interface SectionSpec {
  /** 区块 id（用于前端锚点 / 过滤） */
  id: string;
  /** 区块标题（计划 §6.5：小写，呼应 dump 风） */
  title: string;
  /** 右侧计数（「22 项」/「3 跳 · 2 个 CDN」）；不给就不渲染 */
  count?: string | null;
  /** 区块正文（HTML 片段） */
  body: string;
  /** 区块底部补充说明（纯文本，会被转义） */
  note?: string | null;
  /** 区块标题右侧的工具按钮（HTML 片段，原样插入；计划 §6.4 的 [copy block] 等） */
  tools?: string | null;
}

/**
 * 区块外壳（计划 §6.2）：一行「标题 …… 计数」+ 1px 线。
 *
 * `sec-rule` 是留给 CSS 画「……」点引线的空元素；`sec-count` 是右对齐的计数。
 */
export function section(spec: SectionSpec): string {
  const count = spec.count ? `<span class="sec-count">${esc(spec.count)}</span>` : '';
  const tools = spec.tools ? `<span class="sec-tools">${spec.tools}</span>` : '';
  const note = spec.note ? `<p class="sec-note">${esc(spec.note)}</p>` : '';
  return [
    `<section class="sec" id="${esc(spec.id)}">`,
    '<h2 class="sec-head">',
    `<span class="sec-title">${esc(spec.title)}</span>`,
    '<span class="sec-rule" aria-hidden="true"></span>',
    count,
    tools,
    '</h2>',
    `<div class="sec-body">${spec.body}${note}</div>`,
    '</section>',
  ].join('');
}

/**
 * 空区块的统一文案（计划 §6.2：缺数据不隐藏区块，显示 `—` + 一句原因）。
 */
export function emptyState(reason: string): string {
  return `<p class="empty"><span class="dash">—</span> ${esc(reason)}</p>`;
}

/* -------------------------------------------------------------------------- */
/* 键值行                                                                      */
/* -------------------------------------------------------------------------- */

/** 键值行（键与值都转义）。 */
export function row(k: string, v: string): string {
  return rowHtml(esc(k), esc(v));
}

/** 键值行 + 右侧 HTML 徽章（键与值转义，徽章原样插入）。 */
export function rowTags(k: string, v: string, tags: string): string {
  return rowHtml(esc(k), esc(v), tags);
}

/** 键值行（全 HTML 片段，调用方保证已转义）。 */
export function rowHtml(k: string, v: string, tags?: string): string {
  const tagHtml = tags ? `<span class="row-tags">${tags}</span>` : '';
  return `<div class="row"><span class="k">${k}</span><span class="v">${v}</span>${tagHtml}</div>`;
}

/* -------------------------------------------------------------------------- */
/* 徽章与标签                                                                  */
/* -------------------------------------------------------------------------- */

/** 厂商徽章的短名（计划 §6.1 线框里用 `cf` / `fastly`）。 */
const VENDOR_LABELS: Record<string, string> = {
  cloudflare: 'cf',
  fastly: 'fastly',
  cloudfront: 'cloudfront',
  akamai: 'akamai',
  vercel: 'vercel',
  bunny: 'bunny',
  aliyun: 'aliyun',
  tencent: 'tencent',
  nginx: 'nginx',
  caddy: 'caddy',
  traefik: 'traefik',
};

/**
 * 厂商徽章（计划 §6.3：hover 显示判据，避免「猜」被当成事实）。
 *
 * @param vendor   厂商名（null 就不渲染）
 * @param evidence 判据命中的头名（写进 title 属性）
 */
export function vendorBadge(vendor: string | null, evidence: readonly string[] = []): string {
  if (!vendor) return '';
  const label = VENDOR_LABELS[vendor] ?? vendor;
  const title =
    evidence.length > 0
      ? `厂商指纹：${vendor}（判据：${evidence.join(', ')}）`
      : `厂商指纹：${vendor}`;
  return `<span class="badge badge-vendor" title="${esc(title)}">${esc(label)}</span>`;
}

/** 通用徽章（`×2` / `[!]` / `2` …）。 */
export function badge(label: string, kind = 'info'): string {
  return `<span class="badge badge-${esc(kind)}">${esc(label)}</span>`;
}

/** 警告徽章：计划 §6.5 用 `[!]` + `--warn` 色。 */
export function warnBadge(): string {
  return `<span class="badge badge-warn" title="告警">[!]</span>`;
}

/** 「声明值 / 可伪造」标记（计划 §1.1）。 */
export const DECLARED_HINT = '声明值 / 可伪造：这一项来自请求头，任何人都能自己写，不是事实';

/** 「socket 事实」标记（计划 §1.1）。 */
export const FACT_HINT = 'socket 事实：这一项来自 TCP 连接，对方伪造不了';

/**
 * 「声明值 / 可伪造」标签。
 *
 * @param source 声明来源的头名（写进 title，便于核对）
 */
export function tagDeclared(source?: string | null): string {
  const title = source ? `${DECLARED_HINT}（来源：${source}）` : DECLARED_HINT;
  return `<span class="tag tag-declared" title="${esc(title)}">声明值 / 可伪造</span>`;
}

/** 「socket 事实」标签。 */
export function tagFact(): string {
  return `<span class="tag tag-fact" title="${esc(FACT_HINT)}">socket 事实</span>`;
}

/* -------------------------------------------------------------------------- */
/* 掩码值                                                                      */
/* -------------------------------------------------------------------------- */

export interface MaskedEntry {
  name: string;
  value: string;
  masked: boolean;
}

/**
 * 掩码值单元格（计划 §6.4：`[reveal]` 点击把 data-mask 换成 data-value）。
 *
 * - 未掩码：原样显示；
 * - partial：显示掩码串，并把明文放进 `data-value`（计划 §5.8：partial 模式下明文确实在 SSR HTML 里）；
 * - strict：显示不可逆掩码，**不输出明文、不给 [reveal] 入口**。
 */
export function maskedCell(entry: MaskedEntry, kind: MaskKind, mode: MaskMode): string {
  const display = renderMaskedValue(entry, kind, mode);
  if (!entry.masked) return `<span class="val">${esc(display)}</span>`;

  const reveal = revealValue(entry, mode);
  if (reveal === null) {
    return `<span class="val masked" data-mask="${esc(display)}">${esc(display)}</span>`;
  }
  return [
    `<span class="val masked" data-mask="${esc(display)}" data-value="${esc(reveal)}">${esc(display)}</span>`,
    `<button type="button" class="reveal">[reveal]</button>`,
  ].join('');
}

/* -------------------------------------------------------------------------- */
/* 前端钩子与提示条                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 值行的 `[copy]` 按钮（计划 §6.4：hover 出现，点击复制原文）。
 *
 * 约定：前端按 `data-copy="value"` 找同一行里的 `.val` 元素取文本；
 * 掩码态复制 `data-mask`（掩码版），不复制明文 —— 明文不在 DOM 里，
 * strict 模式下更不可能泄漏。
 */
export function copyButton(): string {
  return '<button type="button" class="copy" data-copy="value">[copy]</button>';
}

/**
 * 区块标题右侧的 `[copy block]` 按钮（计划 §6.4：复制整块 `name: value` 文本）。
 *
 * @param sectionId 区块 id（前端据此定位 section）
 */
export function copyBlockButton(sectionId: string): string {
  return `<button type="button" class="copy-block" data-copy-block="${esc(sectionId)}">[copy block]</button>`;
}

/**
 * `[reveal all]` 按钮（计划 §6.4：揭示全部掩码项）。
 *
 * 只有 partial 模式给入口；strict 模式服务端根本没有明文（计划 §5.8）。
 */
export function revealAllButton(): string {
  return '<button type="button" class="reveal-all" data-reveal-all>[reveal all]</button>';
}

/**
 * 黄色告警行（计划 §6.6：length 与 declaredLength 不一致等）。
 */
export function warnLine(text: string): string {
  return `<p class="warn-line">${warnBadge()}<span class="warn-text">${esc(text)}</span></p>`;
}

/**
 * 截断横幅（计划 §6.6：展示上限截断时给一条横幅，而不是静默砍掉）。
 */
export function truncationBanner(text: string): string {
  return `<p class="banner banner-trunc">${warnBadge()}<span class="banner-text">${esc(text)}</span></p>`;
}

/**
 * `<pre>` 代码块（内容转义；计划 §6.5 的等宽 dump 风）。
 *
 * @param content   展示内容（会被转义）
 * @param className pre 的 class（附加 `pre`）
 * @param options   `hidden: true` 时加 `hidden` 属性（默认不显示，靠前端切换）
 */
export function pre(
  content: string,
  className = 'code',
  options: { hidden?: boolean } = {},
): string {
  const hidden = options.hidden === true ? ' hidden' : '';
  return `<pre class="pre ${esc(className)}"${hidden}>${esc(content)}</pre>`;
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

/** 字节数的人读格式。 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 秒 → `3h12m` / `12m30s` / `45s`。 */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
}

/* -------------------------------------------------------------------------- */
/* strict 模式下的口径统一                                                     */
/* -------------------------------------------------------------------------- */

/**
 * strict 模式下的展示口径统一（计划 §5.8 / §11.10）。
 *
 * 背景：`core/query.ts` 的 `raw` 片段与 `url.rawQuery` / `url.absolute` / `line.target`
 * 保留的是**原始 query 串**，而掩码只作用在 `query[].value` 上。
 * 于是 strict 模式下 `?token=abc123` 的明文仍会从这几个字段漏出去，
 * 违反计划 §11.10「strict 模式下 HTML 与 JSON 都不含明文 token」。
 *
 * 这里在**渲染层**统一处理（不动 core）：strict 模式下把敏感 query 项的 raw 片段换成
 * 「原键 + 不可逆掩码」，并同步替换 URL / 请求行里的同一段 query 串。
 * HTML 与 JSON 都过这个函数，两个出口的口径完全一致（计划 §3：同一 RequestDump 喂两个出口）。
 *
 * 非 strict 模式原样返回（partial 模式本来就允许明文随页面下发，见计划 §5.8）。
 *
 * strict 模式另外处理 **body**（计划 §5.8「服务端不输出明文」）：
 * - JSON body：键名命中敏感规则的字段值换成不可逆掩码（`body.json` 与 `body.text` 同步）；
 * - form / text body：文本里 `token=xxx` / `"token":"xxx"` 这类赋值换成不可逆掩码；
 * - form 字段表（`body.fields`）由 core/mask.ts 在采集时就掩好了，这里不重复处理。
 */
export function sanitizeDump(dump: RequestDump): RequestDump {
  if (dump.security.maskMode !== 'strict') return dump;

  const next: RequestDump = { ...dump };

  // ---- 1) query 的原始片段 + URL / 请求行里的同一段 query 串 ----
  const rawQuery = dump.url.rawQuery;
  if (rawQuery !== '') {
    const segments = rawQuery.split('&');
    const maskedSegments = dump.query.map((entry, index) => {
      const raw = segments[index] ?? entry.raw;
      if (!entry.sensitive) return raw;
      const eq = raw.indexOf('=');
      const head = eq === -1 ? raw : raw.slice(0, eq + 1);
      // strict 模式下 entry.value 已经是不可逆掩码（core/mask.ts 的 maskSecretStrict）
      return `${head}${entry.value}`;
    });
    const maskedRawQuery = maskedSegments.join('&');

    if (maskedRawQuery !== rawQuery) {
      const replaceQuery = (value: string): string => value.split(rawQuery).join(maskedRawQuery);

      next.line = {
        ...dump.line,
        target: replaceQuery(dump.line.target),
        raw: replaceQuery(dump.line.raw),
      };
      next.url = {
        ...dump.url,
        rawQuery: maskedRawQuery,
        absolute: replaceQuery(dump.url.absolute),
      };
      next.query = dump.query.map((entry, index) => ({
        ...entry,
        raw: maskedSegments[index] ?? entry.raw,
      }));
    }
  }

  // ---- 2) body 里的敏感值（body 区块也走这一个出口） ----
  const body = sanitizeBody(dump.body);
  if (body !== dump.body) next.body = body;

  return next;
}

/* -------------------------------------------------------------------------- */
/* strict 模式下的 body 收口                                                   */
/* -------------------------------------------------------------------------- */

/** body 里也按敏感处理的键名（query 规则之外再补几个 header 同名的）。 */
const SENSITIVE_BODY_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

/** body 里的键名是否敏感。 */
export function isSensitiveBodyKey(key: string): boolean {
  return isSensitiveQueryKey(key) || SENSITIVE_BODY_KEYS.has(key.trim().toLowerCase());
}

/**
 * 文本里的敏感键名关键词（strict 模式用）。
 *
 * 原来这里是一条正则，但那条正则是**灾难性回溯**：键名部分写成
 * `[A-Za-z0-9_.\-]*(?:kw)[A-Za-z0-9_.\-]*`（关键词两侧都是通配），
 * 长文本上代价是平方级的（64 KiB 纯文本 ≈ 15 s，128 KiB ≈ 67 s），
 * strict 模式下一个 256 KiB 的 body 就能把事件循环卡死几分钟
 * （审查 blocker B-2）。
 *
 * 现在改成**单遍前向扫描器**：没有回溯，代价与文本长度线性相关。
 */
const SENSITIVE_TEXT_KEYWORDS: readonly string[] = [
  'token',
  'key',
  'secret',
  'password',
  'passwd',
  'sig',
  'signature',
  'code',
  'authorization',
  'cookie',
];

/** 键名里允许的字符（与原正则的 `[A-Za-z0-9_.\-]` 一致）。 */
function isKeyCharCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f || // _
    code === 0x2e || // .
    code === 0x2d // -
  );
}

/** `\s` 的等价判定（覆盖 JS 正则的空白字符集）。 */
function isSpaceCode(code: number): boolean {
  return (
    code === 0x20 || // 空格
    code === 0x09 || // \t
    code === 0x0a || // \n
    code === 0x0d || // \r
    code === 0x0b || // \v
    code === 0x0c || // \f
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** ASCII 小写化（只处理 A-Z：避免 toLowerCase() 改变长度导致下标错位）。 */
function asciiLowerCode(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/** 关键词首字符 → 候选关键词（用来快速跳过绝大多数不可能命中的位置）。 */
const KEYWORDS_BY_FIRST_CHAR: Map<number, string[]> = new Map();
for (const keyword of SENSITIVE_TEXT_KEYWORDS) {
  const first = keyword.charCodeAt(0);
  const list = KEYWORDS_BY_FIRST_CHAR.get(first);
  if (list) list.push(keyword);
  else KEYWORDS_BY_FIRST_CHAR.set(first, [keyword]);
}

/** `text` 在 `pos` 处是否以 `keyword` 开头（ASCII 大小写不敏感）。 */
function startsWithKeyword(text: string, pos: number, keyword: string): boolean {
  if (pos + keyword.length > text.length) return false;
  for (let k = 0; k < keyword.length; k += 1) {
    if (asciiLowerCode(text.charCodeAt(pos + k)) !== keyword.charCodeAt(k)) return false;
  }
  return true;
}

/** 键名片段 `[start, end)` 里有没有命中敏感关键词。 */
function runHasKeyword(text: string, start: number, end: number): boolean {
  for (let pos = start; pos < end; pos += 1) {
    const candidates = KEYWORDS_BY_FIRST_CHAR.get(asciiLowerCode(text.charCodeAt(pos)));
    if (!candidates) continue;
    for (const keyword of candidates) {
      if (pos + keyword.length <= end && startsWithKeyword(text, pos, keyword)) return true;
    }
  }
  return false;
}

/** 一次命中：键 + 分隔符 + 值。 */
interface SensitiveAssignment {
  /** 命中段起点（含键前的引号） */
  start: number;
  /** 键与分隔符（原文保留） */
  head: string;
  /** 值的原文（含引号） */
  value: string;
  /** 命中段末尾（值的末尾） */
  end: number;
}

/** 裸值的结束位置（到 `&` / 空白 / `,` / `;` / `}` / `]` 为止）。 */
function scanBareValue(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (
      code === 0x26 || // &
      code === 0x2c || // ,
      code === 0x3b || // ;
      code === 0x7d || // }
      code === 0x5d || // ]
      isSpaceCode(code)
    ) {
      break;
    }
    i += 1;
  }
  return i;
}

/**
 * 从 `from` 开始找下一个「敏感键 = 值」。
 *
 * 单遍前向扫描：没有回溯，代价与文本长度线性相关（审查 blocker B-2）。
 */
function findSensitiveAssignment(text: string, from: number): SensitiveAssignment | null {
  const len = text.length;
  let i = from;

  while (i < len) {
    const code = text.charCodeAt(i);
    const quoted = code === 0x22 || code === 0x27; // " '
    if (!quoted && !isKeyCharCode(code)) {
      i += 1;
      continue;
    }

    // 键：可选的前引号 + 连续的键字符
    const start = i;
    const keyStart = quoted ? i + 1 : i;
    let keyEnd = keyStart;
    while (keyEnd < len && isKeyCharCode(text.charCodeAt(keyEnd))) keyEnd += 1;

    // 键里没有关键词 → 整段跳过（这一段里不可能命中）
    if (!runHasKeyword(text, keyStart, keyEnd)) {
      i = Math.max(keyEnd, i + 1);
      continue;
    }

    // 键后可选的引号
    let afterKey = keyEnd;
    if (afterKey < len) {
      const c = text.charCodeAt(afterKey);
      if (c === 0x22 || c === 0x27) afterKey += 1;
    }

    // 分隔符（`:` / `=`），前后允许空白
    let p = afterKey;
    while (p < len && isSpaceCode(text.charCodeAt(p))) p += 1;
    if (p >= len) return null;
    const sep = text.charCodeAt(p);
    if (sep !== 0x3a && sep !== 0x3d) {
      i = Math.max(keyEnd, i + 1);
      continue;
    }
    p += 1;
    while (p < len && isSpaceCode(text.charCodeAt(p))) p += 1;

    // 值：带引号取到闭合引号，否则取到分隔符 / 空白为止
    const valueStart = p;
    let valueEnd = -1;
    if (p < len) {
      const valueCode = text.charCodeAt(p);
      if (valueCode === 0x22 || valueCode === 0x27) {
        const quote = text[p];
        let j = p + 1;
        while (j < len) {
          const c = text[j];
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (c === quote) {
            valueEnd = j + 1;
            break;
          }
          j += 1;
        }
      }
    }
    if (valueEnd === -1) valueEnd = scanBareValue(text, valueStart);
    if (valueEnd <= valueStart) {
      i = Math.max(keyEnd, i + 1);
      continue;
    }

    return {
      start,
      head: text.slice(start, valueStart),
      value: text.slice(valueStart, valueEnd),
      end: valueEnd,
    };
  }

  return null;
}

/** 把一个原始值片段换成不可逆掩码（保留原有的引号结构）。 */
function redactFragment(fragment: string): string {
  if (fragment.length >= 2 && fragment.startsWith('"') && fragment.endsWith('"')) {
    return `"${maskSecretStrict(fragment.slice(1, -1))}"`;
  }
  if (fragment.length >= 2 && fragment.startsWith("'") && fragment.endsWith("'")) {
    return `'${maskSecretStrict(fragment.slice(1, -1))}'`;
  }
  return maskSecretStrict(fragment);
}

/**
 * 文本里的敏感赋值换成不可逆掩码（strict 模式专用）。
 *
 * 单遍扫描 + 原地拼接，代价与文本长度线性相关（审查 blocker B-2）。
 */
export function redactSensitiveText(text: string): string {
  if (text.length === 0) return text;
  // 快速路径：整个文本里没有关键词 → 不可能命中
  if (!runHasKeyword(text, 0, text.length)) return text;

  let out = '';
  let cursor = 0;
  let from = 0;

  for (;;) {
    const match = findSensitiveAssignment(text, from);
    if (!match) break;
    out += text.slice(cursor, match.start) + match.head + redactFragment(match.value);
    cursor = match.end;
    from = match.end;
    if (from >= text.length) break;
  }

  if (cursor === 0) return text;
  return out + text.slice(cursor);
}

/** JSON 树里敏感键的值换成不可逆掩码（递归）。 */
function maskJsonTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => maskJsonTree(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveBodyKey(key)) {
        const raw = typeof item === 'string' ? item : (JSON.stringify(item) ?? '');
        out[key] = maskSecretStrict(raw);
      } else {
        out[key] = maskJsonTree(item);
      }
    }
    return out;
  }
  return value;
}

/**
 * strict 模式下收口 body 区块（计划 §5.8 / §11.10）。
 *
 * - json：解析树与原文里的敏感字段同时掩掉（两者都要，因为区块同时展示「原样」与「美化」），
 *   JSON 解析错误消息（`body.jsonError`）也会内嵌原文 → 一并换成不含明文的文案；
 * - form / text：文本里的敏感赋值掩掉（字段表 `body.fields` 在采集时已掩）；
 * - binary：hexdump 的 ASCII 列就是 body 原文 → 整列置 `.`（hex 列保留）；
 * - multipart：文件名可能带敏感信息 → 换成不可逆掩码；
 * - empty：原样返回。
 */
function sanitizeBody(body: RequestDump['body']): RequestDump['body'] {
  if (body.kind === 'json') {
    const json = body.json === undefined ? undefined : maskJsonTree(body.json);
    const text = body.text === undefined ? undefined : redactSensitiveText(body.text);
    // strict：JSON.parse 的错误消息内嵌原文前缀 → 换成不含明文的文案（审查 blocker B-1）
    const jsonError = body.jsonError === undefined ? undefined : maskJsonError(body.jsonError);
    return { ...body, json, text, jsonError };
  }

  if (body.kind === 'form' || body.kind === 'text') {
    if (body.text === undefined) return body;
    return { ...body, text: redactSensitiveText(body.text) };
  }

  if (body.kind === 'binary') {
    // strict：hexdump 的 ASCII 列是 body 原文 → 整列置 '.'（审查 blocker B-3）
    if (body.hexPreview === undefined) return body;
    return { ...body, hexPreview: maskHexAsciiColumn(body.hexPreview) };
  }

  if (body.kind === 'multipart') {
    // strict：文件名可能带敏感信息 → 换成不可逆掩码
    if (body.parts === undefined) return body;
    return {
      ...body,
      parts: body.parts.map((part) => ({
        ...part,
        filename: part.filename === null ? null : maskSecretStrict(part.filename),
      })),
    };
  }

  return body;
}

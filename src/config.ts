/**
 * 环境变量 → 配置（计划 §9）。
 *
 * 这里是**唯一**读 env 的地方：`main.ts` 读一次，其余模块只拿 `Config` 对象，
 * 这样集成测试可以用不同的 env 造出不同配置的实例，不必真的改 process.env。
 *
 * 默认值全部按计划 §9：
 * HOST=0.0.0.0 · PORT=3000 · ORIGIN_TOKEN=（空）· TRUST_PROXY=1 ·
 * BODY_LIMIT=1mb · DISPLAY_LIMIT=256kb · MASK_MODE=partial ·
 * RATE_LIMIT=off · LOG_LEVEL=warn
 */

import type { MaskMode } from './core/mask.js';

/** Fastify 的 trustProxy 形态（boolean | 地址列表 | 逐跳判定函数） */
export type TrustProxySetting =
  | boolean
  | string
  | string[]
  | ((address: string, hop: number) => boolean);

export interface Config {
  /** 监听地址（公网 origin：0.0.0.0） */
  host: string;
  /** 监听端口 */
  port: number;
  /** 回源 token；空串 = 关闭门禁 */
  originToken: string;
  /** 回源 token 门禁是否开启 */
  tokenGate: boolean;
  /** 框架层是否信任代理头（X-Forwarded-* / X-Real-IP …） */
  trustProxy: TrustProxySetting;
  /** 原始 env 值（启动横幅展示用） */
  trustProxyRaw: string;
  /** 接收 body 上限（字节） */
  bodyLimit: number;
  /** 展示文本截断上限（字符） */
  displayLimit: number;
  /** 脱敏模式 */
  maskMode: MaskMode;
  /** 是否开启 per-IP 限流 */
  rateLimit: boolean;
  /** 日志级别 */
  logLevel: string;
}

export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PORT = 3000;
export const DEFAULT_BODY_LIMIT = 1024 * 1024; // 1 MiB
export const DEFAULT_DISPLAY_LIMIT = 256 * 1024; // 256 Ki
export const DEFAULT_MASK_MODE: MaskMode = 'partial';
export const DEFAULT_TRUST_PROXY = '1';

/** 限流：60 req/min per socket IP（计划 §7.7） */
export const RATE_LIMIT_CAPACITY = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

/**
 * 解析 `1mb` / `256kb` / `1024` 这类尺寸串（字节）。
 * 解析不出来就用 fallback（不抛错，避免因为一个环境变量写错就起不来）。
 */
export function parseSize(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const text = raw.trim().toLowerCase();
  if (text === '') return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(text);
  if (!m) return fallback;
  const value = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(value)) return fallback;
  const unit = m[2] ?? 'b';
  const factor = SIZE_UNITS[unit];
  if (factor === undefined) return fallback;
  return Math.floor(value * factor);
}

/**
 * TRUST_PROXY → Fastify 的 trustProxy。
 *
 * 计划 §9 给的默认值是 `1`，语义是「信任 1 跳代理」（本服务前面通常就一层 CDN）：
 * - `0` / `off` / `false` / `no` → 完全不信任代理头（request.ip = socket 对端）；
 * - `1` / `2` / `n`             → 信任 n 跳（`hop < n`），n=1 时只有直连对端可信；
 * - `true` / `on` / `yes`       → 全信任；
 * - 其它（IP / CIDR 列表）      → 原样交给 Fastify 编译。
 *
 * 偏离说明：Fastify 自己收到**数字** trustProxy 时会「fail closed」（一律不信），
 * 与计划想要的「信任 n 跳」不符，所以这里把数字显式翻成逐跳判定函数。
 */
export function parseTrustProxy(raw: string | undefined): {
  value: TrustProxySetting;
  raw: string;
} {
  const text = (raw ?? DEFAULT_TRUST_PROXY).trim();
  const lower = text.toLowerCase();

  if (lower === '' || lower === '0' || lower === 'off' || lower === 'false' || lower === 'no') {
    return { value: false, raw: text };
  }
  if (lower === 'true' || lower === 'on' || lower === 'yes') {
    return { value: true, raw: text };
  }
  if (/^\d+$/.test(lower)) {
    const hops = Number.parseInt(lower, 10);
    if (hops <= 0) return { value: false, raw: text };
    return { value: (_address: string, hop: number) => hop < hops, raw: text };
  }
  // 地址 / CIDR 列表：交给 Fastify 的 proxy-addr 编译
  return { value: text, raw: text };
}

function parseMaskMode(raw: string | undefined): MaskMode {
  const text = (raw ?? DEFAULT_MASK_MODE).trim().toLowerCase();
  if (text === 'none' || text === 'partial' || text === 'strict') return text;
  throw new Error(`MASK_MODE 非法：${text}（只能是 none | partial | strict）`);
}

function parseRateLimit(raw: string | undefined): boolean {
  const text = (raw ?? 'off').trim().toLowerCase();
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

/**
 * 从 env 构造配置。
 *
 * @param env 默认 `process.env`；测试可以传入自定义对象。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portRaw = (env.PORT ?? String(DEFAULT_PORT)).trim();
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT 非法：${portRaw}`);
  }

  const originToken = (env.ORIGIN_TOKEN ?? '').trim();
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);

  return {
    host: (env.HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST,
    port,
    originToken,
    tokenGate: originToken.length > 0,
    trustProxy: trustProxy.value,
    trustProxyRaw: trustProxy.raw,
    bodyLimit: parseSize(env.BODY_LIMIT, DEFAULT_BODY_LIMIT),
    displayLimit: parseSize(env.DISPLAY_LIMIT, DEFAULT_DISPLAY_LIMIT),
    maskMode: parseMaskMode(env.MASK_MODE),
    rateLimit: parseRateLimit(env.RATE_LIMIT),
    logLevel: (env.LOG_LEVEL ?? 'warn').trim() || 'warn',
  };
}

/**
 * 转发链解析（计划 §5.7）。
 *
 * 按优先级取候选链，**全部来源都进 JSON**，UI 主视图只用优先级最高的那条并注明来源：
 *
 * 1. `Forwarded`（RFC 7239，可多段，含 for=/by=/proto=/host=）—— 最正式
 * 2. `X-Forwarded-For`（逗号列表，左=最早/最像客户端）
 * 3. `CF-Connecting-IP` → `True-Client-IP` → `Fastly-Client-IP` → `X-Real-IP`
 *    → `X-Client-IP` → `X-Cluster-Client-IP`（单值兜底）
 * 4. `socket.remoteAddress`（兜底）
 *
 * 清洗规则：值可能带 `:port`、`[v6]:port`、`unknown`、`_hidden`、引号——统一清洗；
 * `unknown` 保留为 `unknown` 而不是丢弃。
 */

import type { ChainCandidate } from '../../shared/types.js';

/** 链路跳数上限（计划 §5.7 / §6.6） */
export const MAX_HOPS = 20;

/** 单值兜底头的优先级顺序 */
export const SINGLE_IP_HEADERS: readonly string[] = [
  'cf-connecting-ip',
  'true-client-ip',
  'fastly-client-ip',
  'x-real-ip',
  'x-client-ip',
  'x-cluster-client-ip',
];

/** header 索引：lower → values */
export type HeaderIndex = Record<string, string[] | undefined>;

/** 取第一个头值（没有则 undefined） */
export function firstHeader(headers: HeaderIndex, name: string): string | undefined {
  const values = headers[name];
  return values && values.length > 0 ? values[0] : undefined;
}

/**
 * 清洗一个 IP token：
 * - 去掉引号；
 * - `[v6]:port` → `v6`；
 * - `ipv4:port` → `ipv4`；
 * - `unknown` / `_hidden` 原样保留（不丢弃）。
 */
export function cleanIpToken(token: string): string {
  let t = token.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1).trim();
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (bracketed) return bracketed[1];
  const ipv4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(t);
  if (ipv4Port) return ipv4Port[1];
  return t;
}

/** IPv4-mapped IPv6 归一化：`::ffff:1.2.3.4` → `1.2.3.4` */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  return m ? m[1] : ip.trim();
}

function isIpv4(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 127) return true; // 127/8
  if (a === 169 && b === 254) return true; // 169.254/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
  return false;
}

/**
 * 私网 / CGNAT / 环回判定（计划 §5.7）：
 * `10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, fc00::/7, ::1`
 */
export function isPrivateIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = normalizeIp(ip).toLowerCase();
  if (isIpv4(v)) return isPrivateIpv4(v);
  if (!v.includes(':')) return false;
  if (v === '::1' || v === '::') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(v)) return true; // fc00::/7
  if (v.startsWith('fe80:')) return true; // link-local（顺手覆盖）
  return false;
}

/** 解析 `X-Forwarded-For`（左=最早/最像客户端），保留重复与原始 token */
export function parseXForwardedFor(value: string): string[] {
  return value
    .split(',')
    .map((part) => cleanIpToken(part))
    .filter((part) => part.length > 0);
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

/** 解析 Forwarded 元素：`for=1.2.3.4;proto=https;host=example.com` */
export function parseForwardedParams(element: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of element.split(';')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      out[trimmed.toLowerCase()] = '';
      continue;
    }
    out[trimmed.slice(0, eq).trim().toLowerCase()] = unquote(trimmed.slice(eq + 1));
  }
  return out;
}

/** 拆 `host=example.com:8080` → host + port */
export function splitHostPort(value: string): { host: string; port: string | null } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] ?? null };
  const idx = value.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(value.slice(idx + 1))) {
    return { host: value.slice(0, idx), port: value.slice(idx + 1) };
  }
  return { host: value, port: null };
}

/**
 * 解析 `Forwarded` 头（RFC 7239，可多段）。
 * 多个元素按出现顺序（第一个元素是最靠近客户端的那一跳）。
 */
export function parseForwardedHeader(value: string): ChainCandidate | null {
  const elements = value
    .split(',')
    .map((el) => el.trim())
    .filter((el) => el.length > 0);
  if (elements.length === 0) return null;

  const ips: string[] = [];
  let proto: string | null = null;
  let host: string | null = null;
  let port: string | null = null;

  for (const element of elements) {
    const params = parseForwardedParams(element);
    if (ips.length < MAX_HOPS && params.for) {
      const ip = cleanIpToken(params.for);
      if (ip) ips.push(ip);
    }
    if (proto === null && params.proto) proto = params.proto.toLowerCase();
    if (host === null && params.host) {
      const split = splitHostPort(params.host);
      host = split.host;
      if (port === null) port = split.port;
    }
  }

  if (ips.length === 0 && proto === null && host === null) return null;
  return { source: 'forwarded', ips, proto, host, port };
}

/** 取 X-Forwarded-Proto 家族（计划 §5.2 的推导顺序） */
export function pickForwardedProto(headers: HeaderIndex): string | null {
  const proto = firstHeader(headers, 'x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim().toLowerCase() || null;
  const protocol = firstHeader(headers, 'x-forwarded-protocol');
  if (protocol) return protocol.split(',')[0].trim().toLowerCase() || null;
  const ssl = firstHeader(headers, 'x-forwarded-ssl');
  if (ssl) {
    const v = ssl.split(',')[0].trim().toLowerCase();
    if (v === 'on' || v === '1' || v === 'true') return 'https';
    if (v === 'off' || v === '0' || v === 'false') return 'http';
  }
  return null;
}

export interface ChainSelection {
  /** 优先级最高的那条链 */
  primary: ChainCandidate;
  /**
   * 声明的协议（**声明值**，可伪造）：`Forwarded` 的 `proto=` → X-Forwarded-Proto 家族。
   *
   * 为什么单独一个字段而不看 `primary.proto`：
   * IP 链的候选来源（Forwarded / XFF / 单值头 / socket）与「客户端声称的协议」
   * 是**两个正交维度**。只有 `x-forwarded-proto` 而没有任何 IP 头时，
   * 主链只能落到 socket 候选（proto = null = socket 层事实：明文），
   * 此时若只看 `primary.proto`，「声明 https 但到本机是明文」这条告警就永远不触发
   * （计划 §6.3 要求触发）。
   */
  forwardedProto: string | null;
  /** 全部候选链（按优先级排序） */
  candidates: ChainCandidate[];
  /** 链长超过上限被截断 */
  truncated: boolean;
  /** 声明的客户端 IP（推断值，可伪造） */
  declaredClient: string | null;
  /** 声明来源头名 */
  declaredSource: string | null;
  /** 解析过程中的告警 */
  warnings: string[];
}

/**
 * 汇总全部候选链。
 *
 * `declaredClient` 的取值优先级与候选链不同：厂商单值头（cf-connecting-ip 等）
 * 比 XFF 最左值更可信（XFF 最左值通常可由客户端自行伪造），故单值头优先。
 */
export function collectChains(headers: HeaderIndex, socketAddress?: string | null): ChainSelection {
  const candidates: ChainCandidate[] = [];
  const warnings: string[] = [];

  const proto = pickForwardedProto(headers);
  const host = firstHeader(headers, 'x-forwarded-host') ?? null;
  const port = firstHeader(headers, 'x-forwarded-port') ?? null;

  const forwardedRaw = firstHeader(headers, 'forwarded');
  let forwardedProtoParam: string | null = null;
  if (forwardedRaw) {
    const parsed = parseForwardedHeader(forwardedRaw);
    if (parsed) {
      forwardedProtoParam = parsed.proto;
      candidates.push({
        ...parsed,
        proto: parsed.proto ?? proto,
        host: parsed.host ?? host,
        port: parsed.port ?? port,
      });
    }
  }

  const xffRaw = firstHeader(headers, 'x-forwarded-for');
  let truncated = false;
  if (xffRaw) {
    const ips = parseXForwardedFor(xffRaw);
    if (ips.length > MAX_HOPS) {
      truncated = true;
      warnings.push('XFF 超过 20 跳，已截断');
      ips.length = MAX_HOPS;
    }
    candidates.push({ source: 'x-forwarded-for', ips, proto, host, port });
  }

  for (const name of SINGLE_IP_HEADERS) {
    const value = firstHeader(headers, name);
    if (!value) continue;
    const ip = cleanIpToken(value);
    if (!ip) continue;
    candidates.push({ source: name, ips: [ip], proto, host, port });
  }

  if (socketAddress) {
    candidates.push({
      source: 'socket',
      ips: [cleanIpToken(socketAddress)],
      proto: null,
      host: null,
      port: null,
    });
  }

  const primary: ChainCandidate = candidates[0] ?? {
    source: 'socket',
    ips: [],
    proto: null,
    host: null,
    port: null,
  };

  // 声明的客户端：计划 §4 的 client.declaredClient 写作「XFF[0] / CF-Connecting-IP / …」，
  // 故取值顺序 = Forwarded(for[0]) → XFF[0] → 单值头 → socket。
  // （注意：这全是**声明值**，可伪造；socketPeer 才是事实。）
  let declaredClient: string | null = null;
  let declaredSource: string | null = null;
  const fwd = candidates.find((c) => c.source === 'forwarded');
  if (fwd && fwd.ips.length > 0) {
    declaredClient = fwd.ips[0];
    declaredSource = 'forwarded';
  }
  if (declaredClient === null) {
    const xff = candidates.find((c) => c.source === 'x-forwarded-for');
    if (xff && xff.ips.length > 0) {
      declaredClient = xff.ips[0];
      declaredSource = 'x-forwarded-for';
    }
  }
  if (declaredClient === null) {
    for (const name of SINGLE_IP_HEADERS) {
      const value = firstHeader(headers, name);
      if (!value) continue;
      const ip = cleanIpToken(value);
      if (!ip) continue;
      declaredClient = ip;
      declaredSource = name;
      break;
    }
  }
  if (declaredClient === null && socketAddress) {
    declaredClient = cleanIpToken(socketAddress);
    declaredSource = 'socket';
  }

  // 声明的协议：与「哪条 IP 链当主链」无关。
  // 优先 Forwarded 的 proto=（RFC 7239，最正式），否则 X-Forwarded-Proto 家族（计划 §5.2）。
  const forwardedProto = forwardedProtoParam ?? proto;

  return {
    primary,
    forwardedProto,
    candidates,
    truncated,
    declaredClient,
    declaredSource,
    warnings,
  };
}

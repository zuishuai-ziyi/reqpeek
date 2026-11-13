/**
 * CDN 指纹 + 链路推断（计划 §6.3 / §5.7）。
 *
 * 纯本地规则，不发任何出站请求。分三块：
 * 1. **指纹**：按 §6.3 的表判定「这次请求经过了哪些厂商」；
 * 2. **链路**：把候选链变成 hop 列表（谁加的头、几跳、IP、证据头名、私网标记）；
 * 3. **告警**：矛盾迹象（私网冒充客户端 / https 声明 vs 明文回源 / CDN-Loop ≥3 / via 与 cdn-loop 厂商不符）。
 *
 * 设计哲学（计划 §1.1）：凡是从 header 推导出来的内容，一律标注为「声明值 / 可伪造」，
 * 绝不与 socket 事实混为一谈——所以 hop.evidence 永远给出支撑它的**头名**，
 * 让读者能自己判断可信度。
 */

import type { Hop } from '../../shared/types.js';
import {
  type ChainSelection,
  type HeaderIndex,
  cleanIpToken,
  isPrivateIp,
  normalizeIp,
} from './forwarded.js';

/** 计划 §6.3 表里的 CDN 厂商 */
export const CDN_VENDORS = [
  'cloudflare',
  'fastly',
  'cloudfront',
  'akamai',
  'vercel',
  'bunny',
  'aliyun',
  'tencent',
] as const;

export type CdnVendor = (typeof CDN_VENDORS)[number];

/** 通用反代（§6.3 最后一行），不算 CDN，但会作为 origin 跳的厂商 */
export const REVERSE_PROXY_VENDORS = ['nginx', 'caddy', 'traefik'] as const;

export type ReverseProxyVendor = (typeof REVERSE_PROXY_VENDORS)[number];

export type Vendor = CdnVendor | ReverseProxyVendor;

/** 厂商命中：判据命中的头名 */
export interface VendorHit {
  vendor: Vendor;
  /** 支撑该判定的头名（hover 提示用） */
  evidence: string[];
}

function has(headers: HeaderIndex, name: string): boolean {
  const v = headers[name];
  return Array.isArray(v) && v.length > 0;
}

function hasPrefix(headers: HeaderIndex, prefix: string): string[] {
  const out: string[] = [];
  for (const name of Object.keys(headers)) {
    if (name.startsWith(prefix)) out.push(name);
  }
  return out.sort();
}

function firstValue(headers: HeaderIndex, name: string): string {
  const v = headers[name];
  return Array.isArray(v) && v.length > 0 ? (v[0] ?? '') : '';
}

/** 解析 `Via` 头（可能是多行，也可能一行里逗号分隔） */
export function parseVia(headers: HeaderIndex): string[] {
  const raw = headers.via;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const line of raw) {
    for (const piece of line.split(',')) {
      const v = piece.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * 解析 `CDN-Loop` 头（RFC 8586：逗号分隔的 CDN 标识）。
 *
 * 现实中也有用 `;` 分隔的写法（计划 §11.4 的验收样例就是 `cloudflare; fastly`），
 * 所以逗号与分号都当分隔符。
 */
export function parseCdnLoop(headers: HeaderIndex): string[] {
  const raw = headers['cdn-loop'];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const line of raw) {
    for (const piece of line.split(/[,;]/)) {
      const v = cleanIpToken(piece).trim();
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * 从一段 Via / CDN-Loop 文本里认厂商。
 * 例：`1.1 varnish` → fastly；`1.1 cloudfront` → cloudfront；`cloudflare` → cloudflare。
 */
export function vendorFromToken(token: string): Vendor | null {
  const t = token.toLowerCase();
  if (t.includes('cloudflare')) return 'cloudflare';
  if (t.includes('varnish') || t.includes('fastly')) return 'fastly';
  if (t.includes('cloudfront')) return 'cloudfront';
  if (t.includes('akamai')) return 'akamai';
  if (t.includes('vercel')) return 'vercel';
  if (t.includes('bunny')) return 'bunny';
  if (t.includes('aliyun') || t.includes('ali-cdn') || t.includes('tengine')) return 'aliyun';
  if (t.includes('tencent') || t.includes('qcloud') || t.includes('nws')) return 'tencent';
  if (t.includes('nginx')) return 'nginx';
  if (t.includes('caddy')) return 'caddy';
  if (t.includes('traefik')) return 'traefik';
  return null;
}

/**
 * 逐厂商判定（计划 §6.3 表，判据任一命中即算）。
 * 返回顺序 = 表顺序（cloudflare → … → tencent → 反代），
 * 链路中间跳按这个顺序依次贴厂商徽章。
 */
export function detectVendors(headers: HeaderIndex): VendorHit[] {
  const hits: VendorHit[] = [];

  const cloudflareEvidence = ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cf-ipcountry'].filter(
    (n) => has(headers, n),
  );
  if (cloudflareEvidence.length > 0) {
    hits.push({ vendor: 'cloudflare', evidence: cloudflareEvidence });
  }

  const fastlyEvidence: string[] = [];
  if (has(headers, 'fastly-client-ip')) fastlyEvidence.push('fastly-client-ip');
  if (has(headers, 'x-served-by')) fastlyEvidence.push('x-served-by');
  for (const n of hasPrefix(headers, 'x-fastly-')) fastlyEvidence.push(n);
  if (has(headers, 'x-timer')) fastlyEvidence.push('x-timer');
  if (parseVia(headers).some((v) => v.toLowerCase().includes('varnish')))
    fastlyEvidence.push('via');
  if (fastlyEvidence.length > 0) hits.push({ vendor: 'fastly', evidence: fastlyEvidence });

  const cloudfrontEvidence: string[] = [];
  for (const n of hasPrefix(headers, 'x-amz-cf-')) cloudfrontEvidence.push(n);
  if (parseVia(headers).some((v) => v.toLowerCase().includes('cloudfront')))
    cloudfrontEvidence.push('via');
  if (cloudfrontEvidence.length > 0)
    hits.push({ vendor: 'cloudfront', evidence: cloudfrontEvidence });

  const akamaiEvidence: string[] = [];
  for (const n of hasPrefix(headers, 'akamai-')) akamaiEvidence.push(n);
  for (const n of hasPrefix(headers, 'x-akamai-')) akamaiEvidence.push(n);
  if (has(headers, 'true-client-ip')) akamaiEvidence.push('true-client-ip');
  if (akamaiEvidence.length > 0) hits.push({ vendor: 'akamai', evidence: akamaiEvidence });

  const vercelEvidence = ['x-vercel-id', 'x-vercel-forwarded-for'].filter((n) => has(headers, n));
  if (vercelEvidence.length > 0) hits.push({ vendor: 'vercel', evidence: vercelEvidence });

  const bunnyEvidence: string[] = [];
  if (parseCdnLoop(headers).some((v) => v.toLowerCase().includes('bunny')))
    bunnyEvidence.push('cdn-loop');
  if (firstValue(headers, 'server').toLowerCase().includes('bunnycdn'))
    bunnyEvidence.push('server');
  if (bunnyEvidence.length > 0) hits.push({ vendor: 'bunny', evidence: bunnyEvidence });

  const aliyunEvidence: string[] = [];
  for (const n of hasPrefix(headers, 'ali-cdn-')) aliyunEvidence.push(n);
  if (firstValue(headers, 'x-cache').toLowerCase().includes('hit from'))
    aliyunEvidence.push('x-cache');
  if (aliyunEvidence.length > 0) hits.push({ vendor: 'aliyun', evidence: aliyunEvidence });

  const tencentEvidence: string[] = [];
  if (has(headers, 'x-nws-log-uuid')) tencentEvidence.push('x-nws-log-uuid');
  if (has(headers, 'x-cache-lookup')) tencentEvidence.push('x-cache-lookup');
  if (tencentEvidence.length > 0) hits.push({ vendor: 'tencent', evidence: tencentEvidence });

  return hits;
}

/**
 * 通用反代判定（§6.3 最后一行）：
 * `server` 含 nginx/Caddy/Traefik，或 `x-real-ip` 单独出现。
 */
export function detectReverseProxy(headers: HeaderIndex): VendorHit | null {
  const server = firstValue(headers, 'server').toLowerCase();
  const evidence: string[] = [];
  let vendor: ReverseProxyVendor | null = null;
  if (server.includes('nginx')) {
    vendor = 'nginx';
    evidence.push('server');
  } else if (server.includes('caddy')) {
    vendor = 'caddy';
    evidence.push('server');
  } else if (server.includes('traefik')) {
    vendor = 'traefik';
    evidence.push('server');
  }
  if (vendor === null && has(headers, 'x-real-ip')) {
    vendor = 'nginx';
    evidence.push('x-real-ip');
  }
  if (vendor === null) return null;
  return { vendor, evidence };
}

/**
 * 单个 header 的厂商徽章（计划 §6.1 里 header 行右侧的 `cf` / `fastly` 小标签）。
 *
 * 只给 **CDN 厂商**贴徽章；通用反代（nginx/Caddy）在 §6.3 表里标记头是「—」，
 * 所以只体现在链路的 origin 跳上，不在 header 行贴标签。
 */
export function headerVendor(name: string, value: string): string | null {
  const lower = name.trim().toLowerCase();
  if (lower.startsWith('cf-')) return 'cloudflare';
  if (lower === 'fastly-client-ip' || lower === 'x-served-by' || lower === 'x-timer')
    return 'fastly';
  if (lower.startsWith('x-fastly-')) return 'fastly';
  if (lower.startsWith('x-amz-cf-')) return 'cloudfront';
  if (lower.startsWith('akamai-') || lower.startsWith('x-akamai-')) return 'akamai';
  if (lower === 'true-client-ip') return 'akamai';
  if (lower.startsWith('x-vercel-')) return 'vercel';
  if (lower.startsWith('ali-cdn-')) return 'aliyun';
  if (lower.startsWith('x-nws-') || lower === 'x-cache-lookup') return 'tencent';
  if (lower === 'cdn-loop' && value.toLowerCase().includes('bunny')) return 'bunny';
  if (lower === 'server' && value.toLowerCase().includes('bunnycdn')) return 'bunny';
  return null;
}

export interface ChainBuildInput {
  headers: HeaderIndex;
  /** socket 对端（事实：最后一跳） */
  socketPeer: string | null;
  /**
   * socket 对端端口。
   *
   * 计划 §4 把它放在 `RequestDump.client.socketPeerPort`（事实层），
   * §6.3 的链路判定与告警并不需要端口，所以这里**不参与推断**，
   * 只是把入口留着（可选字段），端口的归口由 connection.ts / collect.ts 负责。
   */
  socketPeerPort?: number | null;
  /** 本机连接是否 TLS（本服务恒 false） */
  encrypted: boolean;
  /** forwarded.ts 选出的候选链 */
  selection: ChainSelection;
}

export interface ChainResult {
  hops: Hop[];
  hopCount: number;
  /** 去重后的 CDN 厂商 */
  vendors: string[];
  cdnLoop: string[];
  via: string[];
  forwardedProto: string | null;
  forwardedHost: string | null;
  forwardedPort: string | null;
  warnings: string[];
  /** 全部候选链（供 JSON 里展示，主视图用 primary） */
  candidates: ChainSelection['candidates'];
}

/**
 * 构建 hop 列表 + 告警。
 *
 * hop 顺序 = 客户端 → 中间跳 → 本机对端（从左到右 = 从客户端走向我们）。
 * 中间跳的厂商按 §6.3 的检测顺序依次贴（cloudflare 最先 = 通常最靠客户端）。
 */
export function buildChain(input: ChainBuildInput): ChainResult {
  const { headers, socketPeer, encrypted, selection } = input;
  const warnings: string[] = [...selection.warnings];

  const vendorHits = detectVendors(headers);
  const reverseProxy = detectReverseProxy(headers);
  const cdnVendors = vendorHits
    .map((h) => h.vendor)
    .filter((v): v is CdnVendor => (CDN_VENDORS as readonly string[]).includes(v));
  const via = parseVia(headers);
  const cdnLoop = parseCdnLoop(headers);

  // 声明的协议取 `selection.forwardedProto`（**不**取 primary.proto）：
  // 只有 x-forwarded-proto 而没有 XFF / Forwarded / 单值 IP 头时，
  // 主链只能落到 socket 候选（proto = null = socket 事实：明文），
  // 若跟着 primary 走，「声明 https 但到本机是明文」这条告警就丢了（计划 §6.3 要求触发）。
  const forwardedProto = selection.forwardedProto;
  const forwardedHost = selection.primary.host;
  const forwardedPort = selection.primary.port;

  const hops: Hop[] = [];
  const pushed = new Set<string>();
  const push = (
    ip: string | null,
    kind: Hop['kind'],
    vendor: string | null,
    evidence: string[],
  ): void => {
    const key = ip ?? `unknown:${hops.length}`;
    if (pushed.has(key)) return;
    pushed.add(key);
    hops.push({
      index: hops.length,
      ip: ip === null ? null : normalizeIp(ip),
      kind,
      vendor,
      evidence,
      private: isPrivateIp(ip),
    });
  };

  const clientIp = selection.declaredClient;
  const chainIps = selection.primary.ips;

  if (clientIp) {
    const source = selection.declaredSource ?? selection.primary.source;
    push(clientIp, isUnknownIp(clientIp) ? 'unknown' : 'client', null, [source]);
  }

  // 中间跳：主链里除去「客户端」与「本机对端」的部分
  // 厂商按 §6.3 的检测顺序依次贴（cloudflare 最先 = 通常最靠客户端）。
  const middleIps = chainIps.filter((ip) => ip !== clientIp && ip !== socketPeer);
  const cdnHits = vendorHits.filter((h) => (CDN_VENDORS as readonly string[]).includes(h.vendor));
  middleIps.forEach((ip, i) => {
    const hit = cdnHits[i];
    push(
      ip,
      isUnknownIp(ip) ? 'unknown' : 'proxy',
      hit ? hit.vendor : null,
      hit ? hit.evidence : [selection.primary.source],
    );
  });

  // 本机对端（唯一不可伪造的一跳）：若还有没分配的 CDN 厂商，它就是离我们最近的那个
  const originHit = cdnHits[middleIps.length] ?? null;
  if (socketPeer && socketPeer !== clientIp) {
    const vendor = originHit?.vendor ?? reverseProxy?.vendor ?? null;
    push(
      socketPeer,
      vendor && (CDN_VENDORS as readonly string[]).includes(vendor) ? 'cdn' : 'origin',
      vendor,
      originHit
        ? [...originHit.evidence, 'socket']
        : reverseProxy
          ? [...reverseProxy.evidence, 'socket']
          : ['socket'],
    );
  }

  // ---- 矛盾告警（计划 §6.3） ----
  const xffIps = chainIps;
  const xffLeft = selection.primary.source === 'x-forwarded-for' ? xffIps[0] : undefined;
  if (xffLeft && isPrivateIp(xffLeft)) {
    warnings.push(
      `XFF 最左值 ${xffLeft} 是私网/环回地址，却声称是客户端 IP（声明值，可能被伪造或链路上有内网跳）`,
    );
  }
  if (forwardedProto === 'https' && !encrypted) {
    warnings.push(
      '声明 x-forwarded-proto=https，但到本机是明文 HTTP（CDN 到用户为 https，回源为 http）',
    );
  }
  if (cdnLoop.length >= 3) {
    warnings.push(`CDN-Loop 有 ${cdnLoop.length} 个条目（≥3），疑似多重 CDN 串联`);
  }
  const viaVendors = new Set(
    via
      .map((v) => vendorFromToken(v))
      .filter((v): v is Vendor => v !== null && (CDN_VENDORS as readonly string[]).includes(v)),
  );
  const loopVendors = new Set(
    cdnLoop
      .map((v) => vendorFromToken(v))
      .filter((v): v is Vendor => v !== null && (CDN_VENDORS as readonly string[]).includes(v)),
  );
  if (viaVendors.size > 0 && loopVendors.size > 0) {
    const overlap = [...viaVendors].some((v) => loopVendors.has(v));
    if (!overlap) {
      warnings.push(
        `Via 的厂商（${[...viaVendors].join(', ')}）与 CDN-Loop 的厂商（${[...loopVendors].join(', ')}）不一致`,
      );
    }
  }

  return {
    hops,
    hopCount: hops.length,
    vendors: cdnVendors,
    cdnLoop,
    via,
    forwardedProto,
    forwardedHost,
    forwardedPort,
    warnings,
    candidates: selection.candidates,
  };
}

/** `unknown` / `_hidden` 这类占位值不是真 IP */
export function isUnknownIp(ip: string): boolean {
  const t = ip.trim().toLowerCase();
  return t === 'unknown' || t === '_hidden' || t === 'hidden' || t === '';
}

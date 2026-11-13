/**
 * 采集层主装配（计划 §3 / §5）。
 *
 * `collect` 只做一件事：把「这一跳跳过来的请求」变成一个**纯数据**的 `RequestDump`，
 * 里面既有事实（socket / 原始字节），也有推断（链路 / 声明值），两者在字段名上分开：
 *
 * - 事实：`client.socketPeer*`、`connection.*`、`headers`、`body`、`query`、`cookies`
 * - 推断：`chain.*`、`client.declared*`、`url.schemeFrom` / `url.hostFrom`
 *
 * **不掺渲染**：这里不产出任何 HTML / 模板字符串，HTML 与 JSON 两个出口共用同一个 dump。
 *
 * 依赖注入：core 层不直接依赖 Fastify 的具体类型，只认下面这几个最小结构，
 * 因此可以脱离服务器直接单测（见 test/collect.test.ts）。
 */

import { randomBytes } from 'node:crypto';
import os from 'node:os';
import type { HeaderEntry, RequestDump } from '../../shared/types.js';
import { sniffBody } from './body.js';
import { buildChain } from './cdn.js';
import { type RawSocketLike, buildConnection } from './connection.js';
import { parseCookieHeader } from './cookies.js';
import {
  type HeaderIndex,
  collectChains,
  firstHeader,
  pickForwardedProto,
  splitHostPort,
} from './forwarded.js';
import { parseHeaders } from './headers.js';
import { type MaskMode, type Masker, createMasker } from './mask.js';
import { parseQuery } from './query.js';

/** 原始请求的最小结构（Fastify 的 `request.raw` 满足它） */
export interface RawRequestLike {
  method?: string | undefined;
  url?: string | undefined;
  httpVersion?: string | undefined;
  rawHeaders?: readonly string[] | undefined;
  socket?: RawSocketLike | null | undefined;
}

export interface CollectInput {
  request: RawRequestLike;
  /** 原始 body 字节（plugins/rawBody.ts 接管 content-type parser 后才有） */
  rawBody?: Buffer | undefined;
  /** body 是否被截断（bodyLimit 超限） */
  bodyTruncated?: boolean;
  /** 超限时已收到的字节数 */
  receivedBytes?: number;
  /** 脱敏器（不给就按 maskMode 建一个） */
  masker?: Masker;
  /** 脱敏模式（masker 不给时生效） */
  maskMode?: MaskMode;
  /** 请求 id（plugins/requestId.ts 给；不给就随机一个） */
  requestId?: string;
  /** 收到请求的时刻（不给就用现在） */
  receivedAt?: Date;
  /** 服务端处理耗时（ms，plugins/timing.ts 给） */
  durationMs?: number;
  /** 页脚的 origin 信息（不给就取本机真实值） */
  origin?: Partial<RequestDump['origin']>;
}

function randomRequestId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * HeaderIndex（lower → values | undefined）→ RequestDump.headerIndex（lower → values）
 *
 * 注意：这里用**展示值**（entry.value）而不是 rawHeaders 里的原值，
 * 否则 strict 模式下 headerIndex 会把 authorization / cookie 的明文又漏出去
 * （计划 §5.8：strict 模式下服务端不输出任何明文）。
 */
function toHeaderIndex(entries: readonly HeaderEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of entries) {
    const bucket = out[entry.lower];
    if (bucket) bucket.push(entry.value);
    else out[entry.lower] = [entry.value];
  }
  return out;
}

/**
 * 拆原始 target：得到 pathname 与原始 query 串。
 *
 * `raw.url` 可能是 absolute-form（正向代理发过来的 `http://host/path?q=1`），
 * 也可能是 origin-form（`/path?q=1`）；两种都要能拆。
 */
export function splitTarget(target: string): { pathname: string; rawQuery: string } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      return { pathname: url.pathname, rawQuery: url.search.replace(/^\?/, '') };
    } catch {
      // 落到下面的 origin-form 分支
    }
  }
  const q = target.indexOf('?');
  if (q === -1) return { pathname: target, rawQuery: '' };
  return { pathname: target.slice(0, q), rawQuery: target.slice(q + 1) };
}

/**
 * scheme 推导（计划 §5.2）：X-Forwarded-Proto → X-Forwarded-Protocol → X-Forwarded-Ssl → socket。
 * **不采信框架的 `request.protocol`**。
 */
export function deriveScheme(headers: HeaderIndex): {
  scheme: string;
  schemeFrom: 'forwarded' | 'socket';
} {
  const forwarded = pickForwardedProto(headers);
  if (forwarded) return { scheme: forwarded, schemeFrom: 'forwarded' };
  return { scheme: 'http', schemeFrom: 'socket' };
}

/**
 * host 推导（计划 §5.2）：X-Forwarded-Host → Host → socket.localAddress。
 */
export function deriveHost(
  headers: HeaderIndex,
  socketLocalAddress: string,
  socketLocalPort = 0,
): { host: string; hostFrom: 'x-forwarded-host' | 'host' | 'socket'; port: number | null } {
  const forwardedHost = firstHeader(headers, 'x-forwarded-host');
  if (forwardedHost) {
    const split = splitHostPort(forwardedHost.split(',')[0]?.trim() ?? forwardedHost);
    return {
      host: split.host,
      hostFrom: 'x-forwarded-host',
      port: split.port ? Number.parseInt(split.port, 10) : forwardedPort(headers),
    };
  }

  const hostHeader = firstHeader(headers, 'host');
  if (hostHeader) {
    const split = splitHostPort(hostHeader.trim());
    return {
      host: split.host,
      hostFrom: 'host',
      port: split.port ? Number.parseInt(split.port, 10) : forwardedPort(headers),
    };
  }

  return {
    host: socketLocalAddress,
    hostFrom: 'socket',
    port: forwardedPort(headers) ?? (socketLocalPort > 0 ? socketLocalPort : null),
  };
}

/** X-Forwarded-Port（可能带端口号） */
function forwardedPort(headers: HeaderIndex): number | null {
  const raw = firstHeader(headers, 'x-forwarded-port');
  if (!raw) return null;
  const port = Number.parseInt(raw.split(',')[0]?.trim() ?? raw, 10);
  return Number.isFinite(port) ? port : null;
}

function countMasked(dump: {
  headers: RequestDump['headers'];
  query: RequestDump['query'];
  cookies: RequestDump['cookies'];
  body: RequestDump['body'];
}): number {
  let n = 0;
  for (const header of dump.headers) if (header.masked) n += 1;
  for (const item of dump.query) if (item.masked) n += 1;
  for (const cookie of dump.cookies) if (cookie.masked) n += 1;
  for (const field of dump.body.fields ?? []) if (field.masked) n += 1;
  return n;
}

/**
 * 主装配：原始请求 → `RequestDump`。
 */
export function collectRequestDump(input: CollectInput): RequestDump {
  const request = input.request;
  const masker = input.masker ?? createMasker(input.maskMode ?? 'partial');

  const rawHeaders = request.rawHeaders ?? [];
  const { entries, index } = parseHeaders(rawHeaders, masker);

  const method = request.method ?? 'GET';
  const target = request.url ?? '/';
  const httpVersion = request.httpVersion ?? 'HTTP/1.1';

  const connection = buildConnection({ httpVersion, socket: request.socket });

  const { pathname, rawQuery } = splitTarget(target);
  const queryEntries = parseQuery(rawQuery, masker);
  const cookieEntries = parseCookieHeader(index.cookie, masker);

  const contentType = firstHeader(index, 'content-type') ?? null;
  const contentEncoding = firstHeader(index, 'content-encoding') ?? null;
  const declaredLengthRaw = firstHeader(index, 'content-length');
  const declaredLength = declaredLengthRaw ? Number.parseInt(declaredLengthRaw, 10) : null;

  const body = sniffBody({
    raw: input.rawBody,
    contentType,
    contentEncoding,
    declaredLength: Number.isFinite(declaredLength) ? declaredLength : null,
    truncated: input.bodyTruncated,
    receivedLength: input.receivedBytes,
    masker,
  });

  // 链路候选：socket 候选用**原始**对端地址（与归一化后的 client.socketPeer 并列展示）
  const selection = collectChains(index, connection.peerAddressRaw);

  const chain = buildChain({
    headers: index,
    socketPeer: connection.peerAddress,
    socketPeerPort: connection.peerPort,
    encrypted: connection.encrypted,
    selection,
  });

  const { scheme, schemeFrom } = deriveScheme(index);
  const { host, hostFrom, port } = deriveHost(
    index,
    connection.local.address,
    connection.local.port,
  );
  const absolute = `${scheme}://${host}${port ? `:${port}` : ''}${pathname}${
    rawQuery ? `?${rawQuery}` : ''
  }`;

  const headerEntries = entries;
  const dump: RequestDump = {
    meta: {
      id: input.requestId ?? randomRequestId(),
      receivedAt: (input.receivedAt ?? new Date()).toISOString(),
      durationMs: input.durationMs ?? 0,
    },
    line: {
      method,
      target,
      httpVersion,
      raw: `${method} ${target} ${httpVersion}`,
    },
    url: {
      scheme,
      schemeFrom,
      host,
      hostFrom,
      port,
      pathname,
      rawQuery,
      absolute,
    },
    query: queryEntries,
    headers: headerEntries,
    headerIndex: toHeaderIndex(headerEntries),
    cookies: cookieEntries,
    body,
    client: {
      socketPeer: connection.peerAddress,
      socketPeerPort: connection.peerPort,
      declaredClient: selection.declaredClient,
      declaredSource: selection.declaredSource,
    },
    connection: {
      httpVersion: connection.httpVersion,
      alpn: connection.alpn,
      local: connection.local,
      bytesRead: connection.bytesRead,
      bytesWritten: connection.bytesWritten,
      keepAlive: connection.keepAlive,
      encrypted: connection.encrypted,
    },
    chain: {
      hops: chain.hops,
      hopCount: chain.hopCount,
      vendors: chain.vendors,
      cdnLoop: chain.cdnLoop,
      via: chain.via,
      forwardedProto: chain.forwardedProto,
      forwardedHost: chain.forwardedHost,
      forwardedPort: chain.forwardedPort,
      candidates: chain.candidates,
      warnings: chain.warnings,
    },
    security: {
      maskedCount: 0,
      maskMode: masker.mode,
      revealable: masker.revealable,
      notes: masker.notes,
    },
    origin: {
      hostname: os.hostname(),
      pid: process.pid,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      ...input.origin,
    },
  };

  dump.security.maskedCount = countMasked(dump);
  return dump;
}

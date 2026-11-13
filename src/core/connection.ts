/**
 * 连接层事实（计划 §5.6）。
 *
 * 这一层只放**不可伪造的事实**：socket 对端 / 本端 / 累计字节数 / HTTP 版本 / ALPN。
 * 任何来自 header 的推断（XFF、CF-Connecting-IP…）都不在这里，见 forwarded.ts / cdn.ts。
 *
 * | 字段 | 来源 |
 * | --- | --- |
 * | peerAddress | `socket.remoteAddress`（= 最后一跳 CDN 边缘节点，本服务唯一能"看到"的对端） |
 * | peerPort | `socket.remotePort` |
 * | local | `socket.localAddress` / `socket.localPort` |
 * | bytesRead / bytesWritten | `socket.bytesRead` / `socket.bytesWritten`（TCP 连接累计值，非本次请求） |
 * | httpVersion | `raw.httpVersion` |
 * | alpn | `socket.alpnProtocol ?? null` |
 *
 * IPv4-mapped IPv6（`::ffff:1.2.3.4`）会被归一化成 `1.2.3.4`；
 * 原始值仍保留在 `peerAddressRaw` 里（collect.ts 放进 chain.candidates 的 socket 候选），
 * 两者在 JSON 里并列，不丢信息。
 */

import { normalizeIp } from './forwarded.js';

/**
 * socket 的最小结构（Node 的 `net.Socket` / `tls.TLSSocket` 都满足）。
 * 用结构化类型而不是 Fastify 的具体类型，是为了让 core 保持纯函数、可直接单测。
 */
export interface RawSocketLike {
  remoteAddress?: string | undefined;
  remotePort?: number | undefined;
  localAddress?: string | undefined;
  localPort?: number | undefined;
  bytesRead?: number | undefined;
  bytesWritten?: number | undefined;
  keepAlive?: boolean | undefined;
  /** 只有 TLS socket 才有这个字段；本服务是明文 HTTP，恒为 false */
  encrypted?: boolean | undefined;
  alpnProtocol?: string | null | undefined;
}

export interface SocketFacts {
  remoteAddress: string | null;
  remotePort: number | null;
  localAddress: string | null;
  localPort: number | null;
  bytesRead: number;
  bytesWritten: number;
  keepAlive: boolean;
  encrypted: boolean;
  alpnProtocol: string | null;
}

export interface ConnectionInfo {
  /** 对端（归一化后的 IPv4-mapped IPv6 → IPv4） */
  peerAddress: string | null;
  /** 对端（socket 原样，未归一化） */
  peerAddressRaw: string | null;
  /** 对端端口 */
  peerPort: number | null;
  local: { address: string; port: number };
  bytesRead: number;
  bytesWritten: number;
  keepAlive: boolean;
  encrypted: boolean;
  httpVersion: string;
  alpn: string | null;
}

/**
 * 读取 socket 上的事实（缺字段一律退化成 null / 0，不猜）。
 */
export function readSocketFacts(socket: RawSocketLike | null | undefined): SocketFacts {
  return {
    remoteAddress: socket?.remoteAddress ?? null,
    remotePort: socket?.remotePort ?? null,
    localAddress: socket?.localAddress ?? null,
    localPort: socket?.localPort ?? null,
    bytesRead: socket?.bytesRead ?? 0,
    bytesWritten: socket?.bytesWritten ?? 0,
    keepAlive: socket?.keepAlive === true,
    encrypted: socket?.encrypted === true,
    alpnProtocol: socket?.alpnProtocol ?? null,
  };
}

export interface RawConnectionLike {
  httpVersion?: string | undefined;
  socket?: RawSocketLike | null | undefined;
}

/**
 * 组装连接层信息。
 */
export function buildConnection(raw: RawConnectionLike): ConnectionInfo {
  const facts = readSocketFacts(raw.socket);
  const peerRaw = facts.remoteAddress;

  return {
    peerAddress: peerRaw === null ? null : normalizeIp(peerRaw),
    peerAddressRaw: peerRaw,
    peerPort: facts.remotePort,
    local: {
      address: facts.localAddress ?? '',
      port: facts.localPort ?? 0,
    },
    bytesRead: facts.bytesRead,
    bytesWritten: facts.bytesWritten,
    keepAlive: facts.keepAlive,
    encrypted: facts.encrypted,
    httpVersion: raw.httpVersion ?? 'HTTP/1.1',
    alpn: facts.alpnProtocol,
  };
}

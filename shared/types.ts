/**
 * reqpeek 数据模型（对应计划 §4）。
 *
 * 设计原则：
 * - 只说两件事：「收到了什么字节」与「这些字节自己声称了什么」。
 * - 凡是推断出来的字段都必须带证据（evidence / *From / declared*），
 *   socket 事实（socketPeer / local / bytes*）是唯一不可伪造的一跳。
 */

export type BodyKind = 'empty' | 'json' | 'form' | 'text' | 'binary' | 'multipart';

export interface HeaderEntry {
  /** 原始大小写 */
  name: string;
  /** 小写名（用于查表 / 去重归并） */
  lower: string;
  value: string;
  /** rawHeaders 中的真实顺序 */
  index: number;
  /** 同名的前一条 index（用于 ×N 角标） */
  dupOf: number | null;
  sensitive: boolean;
  masked: boolean;
  /** 'cloudflare' | 'fastly' | 'cloudfront' | 'akamai' | 'vercel' | null */
  vendor: string | null;
}

/**
 * 转发链候选（计划 §5.7：「全部来源都进 JSON，UI 主视图只用优先级最高的那条并注明来源」）。
 *
 * 偏离说明：§4 的 chain 类型未列出该字段，但 §5.7 明确要求「全部来源都进 JSON」，
 * 且 UI 主视图要能查看其它候选链，故在此以可选字段补充。
 */
export interface ChainCandidate {
  /** 来源头名（小写）或 'socket' */
  source: string;
  /** 清洗后的 IP 列表（保留 unknown / _hidden 原样，不丢弃） */
  ips: string[];
  proto: string | null;
  host: string | null;
  port: string | null;
}

export interface Hop {
  index: number;
  ip: string | null;
  kind: 'client' | 'cdn' | 'proxy' | 'origin' | 'unknown';
  vendor: string | null;
  /** 支撑该判定的头名，如 ['cf-ray','cf-connecting-ip'] */
  evidence: string[];
  /** 私网/CGNAT/环回 */
  private: boolean;
}

export interface RequestDump {
  meta: { id: string; receivedAt: string; durationMs: number };
  line: { method: string; target: string; httpVersion: string; raw: string };
  url: {
    scheme: string;
    schemeFrom: 'forwarded' | 'socket';
    host: string;
    hostFrom: 'x-forwarded-host' | 'host' | 'socket';
    port: number | null;
    pathname: string;
    rawQuery: string;
    /** 按上面的来源拼出，来源一并展示 */
    absolute: string;
  };
  query: Array<{
    key: string;
    value: string;
    index: number;
    sensitive: boolean;
    masked: boolean;
    /** 在 rawQuery 中的原始片段 */
    raw: string;
  }>;
  headers: HeaderEntry[];
  /** lower → values（重复键） */
  headerIndex: Record<string, string[]>;
  /**
   * decoded 是「另给解码副本」（计划 §5.5：切分不解码，另给解码副本）。
   * 偏离说明：§4 类型未列出该字段，但 §5.5 明确要求提供解码副本，
   * 故在此以可选字段补充（strict 模式下与服务端一致，不含明文）。
   */
  cookies: Array<{ name: string; value: string; masked: boolean; decoded?: string }>;
  body: {
    present: boolean;
    kind: BodyKind;
    contentType: string | null;
    charset: string | null;
    contentEncoding: string | null;
    length: number;
    /** Content-Length 声明值，不一致时 UI 黄字告警 */
    declaredLength: number | null;
    truncated: boolean;
    sha256: string;
    text?: string;
    json?: unknown;
    jsonError?: string;
    fields?: Array<{ key: string; value: string; masked: boolean }>;
    parts?: Array<{
      name: string | null;
      filename: string | null;
      contentType: string | null;
      length: number;
    }>;
    hexPreview?: string;
  };
  client: {
    /** 事实：raw.socket.remoteAddress（= 最后一跳） */
    socketPeer: string | null;
    socketPeerPort: number | null;
    /** 推断：XFF[0] / CF-Connecting-IP / … */
    declaredClient: string | null;
    /** 上述取值的头名 */
    declaredSource: string | null;
  };
  connection: {
    httpVersion: string;
    alpn: string | null;
    local: { address: string; port: number };
    bytesRead: number;
    bytesWritten: number;
    keepAlive: boolean;
    /** 仅记录事实（本服务纯 HTTP，恒 false） */
    encrypted: boolean;
  };
  chain: {
    hops: Hop[];
    hopCount: number;
    /** 去重后的 CDN 厂商 */
    vendors: string[];
    /** CDN-Loop 条目（RFC 8586） */
    cdnLoop: string[];
    /** Via 条目 */
    via: string[];
    forwardedProto: string | null;
    forwardedHost: string | null;
    forwardedPort: string | null;
    /** 全部候选链（来源 + IP 列表），主视图只显示优先级最高的一条 */
    candidates?: ChainCandidate[];
    /** 伪造迹象 / 私网跳 / 长度超限 / 与 socket 矛盾 */
    warnings: string[];
  };
  /**
   * notes 用于页面底部明示脱敏口径（计划 §5.8 提到 security.notes）。
   * 偏离说明：§4 类型未列出该字段，但 §5.8 明确引用了 security.notes，
   * 故在此以可选字段补充。
   */
  security: {
    maskedCount: number;
    maskMode: 'none' | 'partial' | 'strict';
    revealable: boolean;
    notes?: string[];
  };
  /** 页脚一行 */
  origin: { hostname: string; pid: number; node: string; uptimeSec: number };
}

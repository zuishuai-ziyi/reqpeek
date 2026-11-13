/**
 * Query 解析（计划 §5.4）。
 *
 * **不要用 `request.query`**（Fastify 的解析器会丢重复键、也会把编码吃掉）：
 * 直接从原始 URL 的 query 串切，保证：
 * - 重复键全部保留、顺序不变；
 * - 每一项都带 `raw`（它在原始 query 串里的原始片段，编码原样）。
 *
 * 解码只用于展示：`key`/`value` 是解码后的，`raw` 是原始编码。
 */

import type { Masker } from './mask.js';

export interface QueryEntry {
  key: string;
  value: string;
  /** 在 query 里的顺序 */
  index: number;
  sensitive: boolean;
  masked: boolean;
  /** 原始片段（编码原样，如 `token=abc%20def`） */
  raw: string;
}

/** 计划 §6.6：URL / query 上限 4 KiB */
export const MAX_QUERY_RAW = 4 * 1024;

function decodeSegment(segment: string): { key: string; value: string } {
  try {
    const params = new URLSearchParams(segment);
    const key = params.keys().next().value ?? '';
    const value = params.get(key) ?? '';
    return { key, value };
  } catch {
    return { key: segment, value: '' };
  }
}

/**
 * 解析原始 query 串（不带 `?`）。
 */
export function parseQuery(rawQuery: string, masker: Masker): QueryEntry[] {
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (query === '') return [];

  const segments = query.split('&');
  const entries: QueryEntry[] = [];

  segments.forEach((segment, index) => {
    const { key, value } = decodeSegment(segment);
    const masked = masker.query(key, value);
    entries.push({
      key,
      value:
        masked.value.length > MAX_QUERY_RAW
          ? `${masked.value.slice(0, MAX_QUERY_RAW)}…`
          : masked.value,
      index,
      sensitive: masked.sensitive,
      masked: masked.masked,
      raw: segment.length > MAX_QUERY_RAW ? `${segment.slice(0, MAX_QUERY_RAW)}…` : segment,
    });
  });

  return entries;
}

/**
 * query 串里出现的**不同**键名（去重，保持首次出现顺序）—— UI 过滤用。
 */
export function queryKeys(entries: readonly QueryEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(entry.key);
  }
  return out;
}

/**
 * 原始 header 解析（计划 §5.3）。
 *
 * 数据源是 Node 的 `raw.rawHeaders`：**扁平的 [name, value, name, value, …]**。
 * 三个必须保住的事实：
 * 1. **原始顺序**（entry.index 就是它在 rawHeaders 里的序号）；
 * 2. **原始大小写**（entry.name 保留服务端发来的写法，entry.lower 只是索引用的归一化键）；
 * 3. **重复键全部保留**（entry.dupOf 指向同名的前一条 index，UI 用它打 ×N 角标）。
 *
 * 掩码由 `mask.ts` 的 Masker 决定（strict 模式下 value 直接是不可逆掩码）。
 */

import type { HeaderEntry } from '../../shared/types.js';
import { headerVendor } from './cdn.js';
import type { HeaderIndex } from './forwarded.js';
import type { Masker } from './mask.js';

/** 计划 §6.6：header 单值上限 8 KiB，超出中间省略 */
export const MAX_HEADER_VALUE = 8 * 1024;

export interface ParsedHeaders {
  /** 有序列表（含重复项） */
  entries: HeaderEntry[];
  /** lower → values（重复键都在里面） */
  index: HeaderIndex;
}

/**
 * 中间省略：保留头尾各一半，中间插入省略标记。
 */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 16) / 2);
  const dropped = value.length - keep * 2;
  return `${value.slice(0, keep)}…[已截断 ${dropped} 字节]…${value.slice(value.length - keep)}`;
}

/**
 * 解析 rawHeaders。
 *
 * @param rawHeaders Node 的 `raw.rawHeaders`（扁平数组）
 * @param masker     脱敏器（决定 sensitive / masked / value）
 */
export function parseHeaders(rawHeaders: readonly string[], masker: Masker): ParsedHeaders {
  const entries: HeaderEntry[] = [];
  const index: HeaderIndex = {};
  const lastIndexOf: Record<string, number> = {};

  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? '';
    const rawValue = rawHeaders[i + 1] ?? '';
    if (name === '') continue;

    const lower = name.toLowerCase();
    const ordinal = entries.length;

    const maskedValue = masker.header(name, rawValue);
    const value = truncateMiddle(maskedValue.value, MAX_HEADER_VALUE);

    entries.push({
      name,
      lower,
      value,
      index: ordinal,
      // 同名的前一条 index（首次出现为 null）
      dupOf: Object.prototype.hasOwnProperty.call(lastIndexOf, lower) ? lastIndexOf[lower] : null,
      sensitive: maskedValue.sensitive,
      masked: maskedValue.masked,
      vendor: headerVendor(name, rawValue),
    });

    lastIndexOf[lower] = ordinal;

    const bucket = index[lower];
    if (bucket) bucket.push(rawValue);
    else index[lower] = [rawValue];
  }

  return { entries, index };
}

/**
 * 同名 header 的出现次数（UI 的 ×N 角标用）。
 */
export function duplicateCounts(entries: readonly HeaderEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.lower, (counts.get(entry.lower) ?? 0) + 1);
  }
  return counts;
}

/**
 * 某个 header 名字一共出现几次（>=2 才是 ×N）。
 */
export function duplicateCount(entries: readonly HeaderEntry[], lower: string): number {
  let n = 0;
  for (const entry of entries) {
    if (entry.lower === lower) n += 1;
  }
  return n;
}

/**
 * 重复组的根（第一条）index —— dupOf 链的终点。
 */
export function rootIndex(entries: readonly HeaderEntry[], index: number): number {
  let current = entries[index];
  const seen = new Set<number>([index]);
  while (current?.dupOf !== null && current?.dupOf !== undefined && !seen.has(current.dupOf)) {
    seen.add(current.dupOf);
    current = entries[current.dupOf];
  }
  return current?.index ?? index;
}

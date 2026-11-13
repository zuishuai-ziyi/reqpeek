/**
 * Cookie 解析（计划 §5.5）。
 *
 * 规则：
 * - `headers.cookie` 按 `;` 切分，**值不解码**（`value` 保持服务端发来的原样）；
 * - 另给一份解码副本 `decoded`（`decodeURIComponent`，失败保留原值）；
 * - 名称命中 `session|token|auth|jwt|sid|csrf` 的按掩码策略处理（唯一出口是 mask.ts）。
 *
 * 注意：同名 cookie 出现多次全部保留（不归并），因为「收到了什么字节」比「解析后的语义」更重要。
 */

import type { Masker } from './mask.js';

export interface CookieEntry {
  /** cookie 名（原始大小写） */
  name: string;
  /** 原始值（**未解码**） */
  value: string;
  /** 是否以掩码形式展示 */
  masked: boolean;
  /** 解码副本；解码失败时与 `value` 相同 */
  decoded?: string;
}

/**
 * 解码副本：`decodeURIComponent` 失败（非法 `%` 序列等）时保留原值。
 */
export function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 解析 `Cookie` 头。
 *
 * @param values 所有 `cookie` 头的原始值（可能有多个）
 * @param masker 脱敏器（决定 masked 与实际存放的值）
 */
export function parseCookieHeader(
  values: readonly string[] | undefined,
  masker: Masker,
): CookieEntry[] {
  const out: CookieEntry[] = [];
  if (!values) return out;

  for (const header of values) {
    for (const part of header.split(';')) {
      const trimmed = part.trim();
      if (trimmed === '') continue;

      const eq = trimmed.indexOf('=');
      const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
      if (name === '') continue;

      const rawValue = eq === -1 ? '' : trimmed.slice(eq + 1).trim();

      // strict 模式下 masker 返回的已经是不含明文的不可逆掩码，
      // 因此解码副本也从「掩码后的值」派生，strict 模式下不可能泄漏明文。
      const masked = masker.cookie(name, rawValue);
      out.push({
        name,
        value: masked.value,
        masked: masked.masked,
        decoded: decodeCookieValue(masked.value),
      });
    }
  }

  return out;
}

/**
 * cookie 名称是否命中敏感名（供 UI / 其它模块判断）。
 */
export function findCookie(entries: readonly CookieEntry[], name: string): CookieEntry | null {
  const lower = name.toLowerCase();
  for (const entry of entries) {
    if (entry.name.toLowerCase() === lower) return entry;
  }
  return null;
}

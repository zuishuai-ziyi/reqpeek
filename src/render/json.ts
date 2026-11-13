/**
 * JSON 出口（计划 §3 / §3.1 / §11.10）。
 *
 * `/api/echo` 与 `Accept: application/json` 共用这一个函数：
 * **同一份 RequestDump → 同一份 JSON**，不存在「页面一套口径、接口另一套口径」的问题
 * （计划 §3 的原则：同一 RequestDump 同时喂 HTML 与 JSON）。
 *
 * strict 模式：先过 `sanitizeDump()`（渲染层的统一收口），
 * 服务端不输出任何明文 —— HTML 与 JSON 两个出口走的是同一个函数，口径一致
 * （计划 §5.8 / §11.10）。
 */

import type { RequestDump } from '../../shared/types.js';
import { sanitizeDump } from './html.js';

/**
 * 把 dump 渲染成 JSON 文本。
 *
 * @param dump   采集层产出的纯数据（未脱敏收口）
 * @param pretty 是否美化（默认美化，方便 `curl … | jq` 之外直接肉眼读）
 */
export function renderJson(dump: RequestDump, pretty = true): string {
  const safe = sanitizeDump(dump);
  return pretty ? JSON.stringify(safe, null, 2) : JSON.stringify(safe);
}

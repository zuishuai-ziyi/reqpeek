/**
 * 页面渲染（计划 §6）。
 *
 * 页面按计划 §6.1 的线框顺序拼装各区块：
 *
 * ```
 * headline → chain → query → headers → cookies → body → footer
 * ```
 *
 * 原则：
 * - 每个区块由 `sections/*.ts` 输出纯 HTML 字符串，共用 `html.ts` 的 `section()` 外壳；
 * - **HTML 与 JSON 走同一份 RequestDump**（计划 §3），不存在两套口径；
 * - 所有用户数据都在 sections 里经 `esc()` 转义（计划 §7.5）；
 * - strict 模式先过 `sanitizeDump()`，页面里不会有明文（计划 §5.8 / §11.10）。
 *
 * 静态资源：`/_assets/app.css` 与 `/_assets/app.js` 由 app.ts 从 public/ 读进内存直接 send，
 * 这里只引用路径。app.js 目前还是占位（计划 §6.4 的「揭示 / 过滤 / 复制 / pretty」
 * 是下一阶段的事），但**页面本身在禁 JS 时也必须完整可读**（计划 §10 M3 验收）。
 */

import type { RequestDump } from '../../shared/types.js';
import { esc, sanitizeDump } from './html.js';
import { renderBody } from './sections/body.js';
import { renderChain } from './sections/chain.js';
import { renderCookies } from './sections/cookies.js';
import { renderFooter } from './sections/footer.js';
import { renderHeaders } from './sections/headers.js';
import { renderHeadline } from './sections/headline.js';
import { renderQuery } from './sections/query.js';

/**
 * 渲染转储页。
 *
 * @param dump 采集层产出的纯数据
 */
export function renderPage(dump: RequestDump): string {
  // strict 模式统一收口（HTML 与 JSON 同一个函数，口径一致）
  const safe = sanitizeDump(dump);

  const title = `${safe.line.method} ${safe.line.target}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>reqpeek · ${esc(title)}</title>
<link rel="stylesheet" href="/_assets/app.css">
</head>
<body>
<main class="dump">
${renderHeadline(safe)}
${renderChain(safe)}
${renderQuery(safe)}
${renderHeaders(safe)}
${renderCookies(safe)}
${renderBody(safe)}
${renderFooter(safe)}
</main>
<script src="/_assets/app.js" defer></script>
</body>
</html>
`;
}

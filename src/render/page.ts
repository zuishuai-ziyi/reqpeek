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
 * 静态资源：`/_assets/app.css` 与 `/_assets/app.js` 由 app.ts 从 public/ 读进内存，
 * **直接内联进页面**（`<style>` / `<script>`），不再让浏览器发起子资源请求。
 *
 * 为什么内联（2026-11-13 实测）：站点前面叠了 CF → bunkerweb → SafeLine 三层，
 * 子资源请求（`/_assets/app.css`）在边缘就被拦掉——SafeLine 的浏览器侧访问日志里
 * `/_assets` 计数为 0，说明请求根本没到源站，页面因此「无样式」。把 CSS/JS 内联后，
 * 页面只依赖 `GET /` 这一个文档请求，边缘拦子资源也不影响可读性。
 * `/_assets/app.css` / `/_assets/app.js` 路由保留（收藏、调试、直接访问都能用）。
 * app.js 目前还是占位（计划 §6.4 的「揭示 / 过滤 / 复制 / pretty」
 * 是下一阶段的事），但**页面本身在禁 JS 时也必须完整可读**（计划 §10 M3 验收）。
 */

import { createHash } from 'node:crypto';
import type { RequestDump } from '../../shared/types.js';
import { esc, sanitizeDump } from './html.js';
import { renderBody } from './sections/body.js';
import { renderChain } from './sections/chain.js';
import { renderCookies } from './sections/cookies.js';
import { renderFooter } from './sections/footer.js';
import { renderHeaders } from './sections/headers.js';
import { renderHeadline } from './sections/headline.js';
import { renderQuery } from './sections/query.js';

/** 内联资源（app.ts 启动时从 public/ 读进内存的那两份）。 */
export interface InlineAssets {
  css: string | null;
  js: string | null;
}

/** 内联 `<style>` 的内容：挡住提前闭合的 `</style`（style 是 raw text 元素）。 */
export function inlineStylePayload(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

/** 内联 `<script>` 的内容：挡住提前闭合的 `</script`（script 是 raw text 元素）。 */
export function inlineScriptPayload(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * CSP 用的哈希：`sha256` → base64。
 *
 * 必须对**最终内联进 HTML 的那段文本**计算，浏览器算的就是这个值。
 */
export function cspHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('base64');
}

/**
 * 渲染转储页。
 *
 * @param dump 采集层产出的纯数据
 * @param assets 启动时读进内存的静态资源；给了就内联，没给就退回外链（构建产物缺失时的兜底）
 */
export function renderPage(dump: RequestDump, assets?: InlineAssets): string {
  // strict 模式统一收口（HTML 与 JSON 同一个函数，口径一致）
  const safe = sanitizeDump(dump);

  const title = `${safe.line.method} ${safe.line.target}`;

  // 资源内联：页面自带样式与脚本，不再依赖边缘可能拦掉的子资源
  const css = assets?.css ? inlineStylePayload(assets.css) : null;
  const js = assets?.js ? inlineScriptPayload(assets.js) : null;
  const styleTag =
    css !== null ? `<style>${css}</style>` : '<link rel="stylesheet" href="/_assets/app.css">';
  const scriptTag =
    js !== null ? `<script>${js}</script>` : '<script src="/_assets/app.js" defer></script>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>reqpeek · ${esc(title)}</title>
${styleTag}
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
${scriptTag}
</body>
</html>
`;
}

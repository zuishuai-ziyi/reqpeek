/**
 * cookies 区块（计划 §5.5 / §6.1）。
 *
 * 内容：
 * - 原始 cookie 名 + **未解码**的值（服务端发来的原样）；
 * - 另给一份解码副本（计划 §5.5「不解码，另给解码副本」）；
 * - 名字命中 `session|token|auth|jwt|sid|csrf` 的按掩码策略处理（掩码出口唯一在 core/mask.ts）。
 *
 * 同名 cookie 出现多次全部保留（不归并），因为「收到了什么字节」比解析语义更重要。
 */

import type { RequestDump } from '../../../shared/types.js';
import {
  copyBlockButton,
  copyButton,
  emptyState,
  esc,
  maskedCell,
  section,
  tagDeclared,
} from '../html.js';

/**
 * 渲染 cookies 区块。
 */
export function renderCookies(dump: RequestDump): string {
  const { cookies } = dump;
  const mode = dump.security.maskMode;

  if (cookies.length === 0) {
    return section({
      id: 'sec-cookies',
      title: 'cookies',
      count: '0 项',
      body: emptyState('未携带 Cookie'),
      tools: copyBlockButton('sec-cookies'),
    });
  }

  const rows = cookies
    .map((entry) => {
      const cell = maskedCell(
        { name: entry.name, value: entry.value, masked: entry.masked },
        'cookie',
        mode,
      );
      const decoded =
        entry.decoded !== undefined && entry.decoded !== entry.value
          ? `<span class="raw">decoded: ${esc(entry.decoded)}</span>`
          : '';
      return `<div class="row" data-row data-name="${esc(entry.name)}" data-text="${esc(entry.value)}"><span class="k">${esc(entry.name)}</span><span class="v">${cell}${decoded}</span><span class="row-tags">${tagDeclared('cookie')}</span><span class="row-tools">${copyButton()}</span></div>`;
    })
    .join('');

  return section({
    id: 'sec-cookies',
    title: 'cookies',
    count: `${cookies.length} 项`,
    body: `<div class="grid">${rows}</div>`,
    note: '值按 ; 切分后**未解码**展示，decoded 是另给的解码副本；同名 cookie 全部保留。',
    tools: copyBlockButton('sec-cookies'),
  });
}

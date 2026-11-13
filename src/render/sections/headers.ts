/**
 * headers 区块（计划 §5.3 / §6.1）。
 *
 * 内容：
 * - **原序、原大小写、重复全留**（数据源是 `request.raw.rawHeaders`）；
 * - 重复键打 `×N` 角标（N = 该名字出现的总次数，计划 §5.3）；
 * - 厂商徽章（计划 §6.3 指纹表，只在 header 列表上标厂商，不当事实用）；
 * - 敏感头（authorization / cookie / x-api-key …）显示掩码串，partial 模式给 [reveal]。
 *
 * 设计哲学（计划 §1.1）：header 全是「声明值 / 可伪造」，
 * 所以每一行都带 `tagDeclared` 标记，避免与 socket 事实混淆。
 */

import type { RequestDump } from '../../../shared/types.js';
import { duplicateCounts } from '../../core/headers.js';
import {
  badge,
  copyBlockButton,
  copyButton,
  emptyState,
  esc,
  maskedCell,
  revealAllButton,
  section,
  tagDeclared,
  vendorBadge,
} from '../html.js';

/**
 * 渲染 headers 区块。
 */
export function renderHeaders(dump: RequestDump): string {
  const { headers } = dump;
  const mode = dump.security.maskMode;

  if (headers.length === 0) {
    return section({
      id: 'sec-headers',
      title: 'headers',
      count: '0 项',
      body: emptyState('本次请求没有携带任何 header'),
      tools: copyBlockButton('sec-headers'),
    });
  }

  const counts = duplicateCounts(headers);

  const rows = headers
    .map((entry) => {
      const total = counts.get(entry.lower) ?? 1;
      const dupBadge = total > 1 ? badge(`×${total}`, 'dup') : '';
      const key = `<span class="k">${esc(entry.name)}${dupBadge}</span>`;
      const cell = maskedCell(
        { name: entry.name, value: entry.value, masked: entry.masked },
        'header',
        mode,
      );
      const tags = [vendorBadge(entry.vendor, [entry.name]), tagDeclared(entry.name)]
        .filter((part) => part !== '')
        .join('');
      // 行上的 data-name / data-text 给前端过滤用（按「名 或 值」匹配，计划 §6.4）。
      // 注意与掩码单元格的 `data-value`（= 明文，reveal 用）区分开，不要混用。
      return `<div class="row" data-row data-name="${esc(entry.name)}" data-text="${esc(entry.value)}">${key}<span class="v">${cell}</span><span class="row-tags">${tags}</span><span class="row-tools">${copyButton()}</span></div>`;
    })
    .join('');

  // 过滤入口（计划 §6.4：`/` 聚焦输入框，按「名 或 值」实时过滤，命中计数 `12/22`）
  const filter = [
    '<div class="filter">',
    '<input id="header-filter" class="filter-input" type="search" placeholder="按名字或值过滤（/ 聚焦）" autocomplete="off" spellcheck="false" aria-label="过滤 header">',
    `<span id="filter-count" class="filter-count" data-total="${headers.length}">0/${headers.length}</span>`,
    '</div>',
  ].join('');

  return section({
    id: 'sec-headers',
    title: 'headers',
    count: `${headers.length} 项`,
    body: `${filter}<div class="grid" id="header-rows">${rows}</div>`,
    note: '按服务端发来的原序、原大小写排列，重复键全部保留并打 ×N 角标；header 内容均可自行伪造。',
    tools: `${dump.security.revealable ? revealAllButton() : ''}${copyBlockButton('sec-headers')}`,
  });
}

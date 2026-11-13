/**
 * query 区块（计划 §5.4 / §6.1）。
 *
 * 内容：
 * - 原始 query 串（编码原样，`url.rawQuery`）；
 * - 每一项：键名 + **解码后的值**（掩码项显示掩码串并给 [reveal]）+ **原始片段**（编码原样）。
 *
 * 计划 §5.4 明确：「UI 上原始形式与解码值都可看」——所以一行里两个都给。
 * 重复键全部保留、顺序不变（不用框架的 `request.query`）。
 */

import type { RequestDump } from '../../../shared/types.js';
import {
  copyBlockButton,
  copyButton,
  emptyState,
  esc,
  maskedCell,
  rowHtml,
  section,
} from '../html.js';

/**
 * 渲染 query 区块。
 */
export function renderQuery(dump: RequestDump): string {
  const { query, url } = dump;
  const mode = dump.security.maskMode;

  if (query.length === 0) {
    return section({
      id: 'sec-query',
      title: 'query',
      count: '0 项',
      body: emptyState(url.rawQuery === '' ? '未携带 query 参数' : 'query 串无法解析'),
      tools: copyBlockButton('sec-query'),
    });
  }

  const rawRow = rowHtml(esc('raw'), esc(url.rawQuery === '' ? '—' : url.rawQuery));

  const itemRows = query
    .map((entry) => {
      const cell = maskedCell(
        { name: entry.key, value: entry.value, masked: entry.masked },
        'query',
        mode,
      );
      const raw = `<span class="raw">raw: ${esc(entry.raw)}</span>`;
      return `<div class="row" data-row data-name="${esc(entry.key)}" data-text="${esc(entry.value)}"><span class="k">${esc(entry.key)}</span><span class="v">${cell}${raw}</span><span class="row-tools">${copyButton()}</span></div>`;
    })
    .join('');

  return section({
    id: 'sec-query',
    title: 'query',
    count: `${query.length} 项`,
    body: `<div class="grid">${rawRow}${itemRows}</div>`,
    note: 'query 项按原始顺序排列，重复键全部保留；raw 是编码原样的原始片段。',
    tools: copyBlockButton('sec-query'),
  });
}

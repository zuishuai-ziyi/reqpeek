/**
 * footer 区块（计划 §6.1 最后一行 / §6.2「页脚固定一行 origin 信息」）。
 *
 * 页脚只放**唯一一行非请求信息**：这台实例是谁（origin）。
 * 打到哪台实例看不出来，就会把两台机器的请求混在一起看。
 *
 * 「声明值 / 可伪造」的说明文案在这里**硬编码**（计划 §1.1）：
 * 不往数据模型里加字段（`security.notes` 之类），因为这段话是**页面的固定文案**，
 * 与本次请求无关 —— 每次都一模一样，写死最省事也不会与采集层脱节。
 */

import type { RequestDump } from '../../../shared/types.js';
import { copyBlockButton, esc, formatUptime, row, section } from '../html.js';

/**
 * 页面固定说明（计划 §1.1 的设计哲学）。
 *
 * 「收到了什么字节」与「这些字节自己声称了什么」——两件事分开说，
 * 免得把 header 里自称的东西当成事实。
 */
export const DECLARED_NOTE =
  '本页只说两件事：「收到了什么字节」与「这些字节自己声称了什么」。' +
  '凡是从请求头推导出来的内容一律标注为「声明值 / 可伪造」——任何人都能自己写，不是事实；' +
  '只有 TCP 连接层的信息（socket 对端、本机地址、累计字节数）是事实。';

/** 脱敏口径说明（按模式给一句；模式本身取自 dump.security.maskMode）。 */
const MASK_MODE_NOTES: Record<RequestDump['security']['maskMode'], string> = {
  none: 'MASK_MODE=none：敏感值未脱敏，全部明文展示。',
  partial:
    'MASK_MODE=partial：掩码项的明文仍随页面与 JSON 一同下发，只在点击 [reveal] 时显示——别直接分享页面源码。',
  strict: 'MASK_MODE=strict：服务端不输出任何明文，页面也没有 [reveal] 入口。',
};

/**
 * 渲染 footer 区块。
 */
export function renderFooter(dump: RequestDump): string {
  const { origin, security } = dump;

  const rows = [
    row(
      'origin',
      `${origin.hostname} · pid ${origin.pid} · node ${origin.node} · up ${formatUptime(origin.uptimeSec)}`,
    ),
    row(
      'masking',
      `mode=${security.maskMode} · masked=${security.maskedCount} · reveal=${
        security.revealable ? 'on' : 'off'
      }`,
    ),
  ].join('');

  const notes = [
    `<p class="foot-note">${esc(DECLARED_NOTE)}</p>`,
    `<p class="foot-note">${esc(MASK_MODE_NOTES[security.maskMode])}</p>`,
    '<p class="foot-note">页脚以外，页面上的每一个字节都来自这次请求本身。</p>',
  ].join('');

  return section({
    id: 'sec-footer',
    title: 'origin',
    count: null,
    body: `<div class="grid">${rows}</div>${notes}`,
    tools: copyBlockButton('sec-footer'),
  });
}

/**
 * chain 区块（计划 §6.1 线框第二段 / §6.3）。
 *
 * 内容：
 * - 链路跳列表（hop）：顺序 = 客户端 → 中间跳 → 本机对端，**从左到右就是请求走过来的方向**；
 *   每一跳都带证据头名（`evidence`），厂商徽章的 title 里写判据（计划 §6.3）；
 * - 「声明值 / 可伪造」与「socket 事实」的区分（计划 §1.1）：
 *   只有 socket 对端那一跳是事实，其余都是从请求头推断出来的；
 * - `CDN-Loop`（RFC 8586）与 `Via` 条目：多重 CDN 的整活看点；
 * - `warnings`：矛盾告警（私网冒充客户端 / 声明 https 而回源明文 / CDN-Loop ≥3 / via 与 cdn-loop 不一致）。
 */

import type { Hop, RequestDump } from '../../../shared/types.js';
import {
  badge,
  copyBlockButton,
  esc,
  row,
  rowHtml,
  rowTags,
  section,
  tagDeclared,
  tagFact,
  vendorBadge,
  warnBadge,
} from '../html.js';

/** hop 的类型 → 展示名。 */
const KIND_LABELS: Record<Hop['kind'], string> = {
  client: 'client',
  cdn: 'cdn',
  proxy: 'proxy',
  origin: 'origin',
  unknown: 'unknown',
};

/** 是不是「socket 事实」那一跳（core/cdn.ts 给它塞了 `socket` 证据）。 */
function isFactHop(hop: Hop): boolean {
  return hop.evidence.includes('socket');
}

/** 一跳的说明文字（计划 §6.1 线框里每一跳右边的那一列）。 */
function hopNote(hop: Hop): string {
  if (isFactHop(hop)) return '本机对端（唯一不可伪造的一跳）';
  const evidence = hop.evidence.length > 0 ? hop.evidence.join(' · ') : hop.kind;
  return `${evidence}（声明值，可伪造）`;
}

/**
 * 渲染 chain 区块。
 */
export function renderChain(dump: RequestDump): string {
  const { chain, client } = dump;

  const hopRows = chain.hops
    .map((hop, index) => {
      const label = `${index === 0 ? '' : '↳ '}${KIND_LABELS[hop.kind]}`;
      const ip = hop.ip ?? '—';
      const tags = [
        vendorBadge(hop.vendor, hop.evidence),
        hop.private ? badge('私网', 'warn') : '',
        isFactHop(hop) ? tagFact() : '',
        `<span class="hop-note">${esc(hopNote(hop))}</span>`,
      ]
        .filter((part) => part !== '')
        .join('');
      return rowHtml(esc(label), esc(ip), tags);
    })
    .join('');

  const loopTags = chain.cdnLoop.length >= 3 ? badge('多重 CDN', 'warn') : '';

  const extraRows = [
    rowTags(
      'declared',
      client.declaredClient
        ? `${client.declaredClient}（来自 ${client.declaredSource ?? '未知来源'}）`
        : '—',
      tagDeclared(client.declaredSource),
    ),
    rowTags(
      'socket',
      client.socketPeer
        ? `${client.socketPeer}${client.socketPeerPort ? `:${client.socketPeerPort}` : ''}`
        : '—',
      tagFact(),
    ),
    chain.cdnLoop.length > 0
      ? rowHtml(esc('cdn-loop'), esc(chain.cdnLoop.join('; ')), loopTags)
      : '',
    chain.via.length > 0 ? rowHtml(esc('via'), esc(chain.via.join(', ')), '') : '',
    chain.vendors.length > 0 ? row('vendors', chain.vendors.join(', ')) : '',
  ]
    .filter((part) => part !== '')
    .join('');

  // 其它候选链：主视图只显示优先级最高的一条（计划 §5.7），但把来源都列出来
  const candidates = chain.candidates ?? [];
  const candidateRows =
    candidates.length > 1
      ? row('candidates', candidates.map((c) => `${c.source}（${c.ips.length}）`).join(', '))
      : '';

  const warnings =
    chain.warnings.length > 0
      ? [
          '<ul class="warnings">',
          ...chain.warnings.map(
            (warning) =>
              `<li class="warn">${warnBadge()}<span class="warn-text">${esc(warning)}</span></li>`,
          ),
          '</ul>',
        ].join('')
      : '';

  const body = [`<div class="grid">${hopRows}${extraRows}${candidateRows}</div>`, warnings].join(
    '',
  );

  const count = `${chain.hopCount} 跳 · ${chain.vendors.length} 个 CDN`;

  return section({
    id: 'sec-chain',
    title: 'chain',
    count,
    body,
    note: '从上到下就是请求走过来的方向；只有带 socket 证据的那一跳是事实，其余都是从请求头推断出来的。',
    tools: copyBlockButton('sec-chain'),
  });
}

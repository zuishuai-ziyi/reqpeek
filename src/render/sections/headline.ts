/**
 * headline 区块（计划 §6.1 线框第一行 + 第二行）。
 *
 * 内容：
 * - 请求行：方法 / 原始 target / HTTP 版本（方法带颜色类，CSS 变量 `--m-get` / `--m-post` …）；
 * - 右上角：协议简写（h1/h2）与服务端处理耗时（计划 §5.10）；
 * - host / scheme：**标明取自信源**（`hostFrom` / `schemeFrom`），
 *   来自 `x-forwarded-*` 的一律标「声明值 / 可伪造」，来自 socket 的标「socket 事实」；
 * - socket 对端 → 本机地址：唯一不可伪造的一跳（计划 §5.6）；
 * - id / 收到时刻 / 耗时。
 */

import type { RequestDump } from '../../../shared/types.js';
import { esc, row, rowTags, tagDeclared, tagFact } from '../html.js';

/** 计划 §6.5 里定义过颜色的方法；其它方法落到 `m-other`。 */
const KNOWN_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** 方法 → CSS class（`m-post` 等）。 */
function methodClass(method: string): string {
  const lower = method.toLowerCase();
  return KNOWN_METHODS.has(lower) ? `m-${lower}` : 'm-other';
}

/** HTTP 版本简写：`1.1` → `h1`，`2.0` → `h2`。 */
export function versionLabel(httpVersion: string): string {
  if (httpVersion.startsWith('HTTP/')) {
    const bare = httpVersion.slice(5);
    return bare.startsWith('2') ? 'h2' : bare.startsWith('3') ? 'h3' : 'h1';
  }
  if (httpVersion.startsWith('2')) return 'h2';
  if (httpVersion.startsWith('3')) return 'h3';
  return 'h1';
}

/** `1.1` → `HTTP/1.1`（计划 §6.1 线框里请求行是完整协议名）。 */
export function formatHttpVersion(httpVersion: string): string {
  return httpVersion.toUpperCase().startsWith('HTTP/') ? httpVersion : `HTTP/${httpVersion}`;
}

/** 毫秒 → `3.2 ms`。 */
function formatMs(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

/**
 * 渲染 headline 区块。
 */
export function renderHeadline(dump: RequestDump): string {
  const { url, client, connection, meta, line } = dump;

  const schemeTag = url.schemeFrom === 'forwarded' ? tagDeclared('x-forwarded-proto') : tagFact();
  const hostTag =
    url.hostFrom === 'socket'
      ? tagFact()
      : tagDeclared(url.hostFrom === 'host' ? 'host' : url.hostFrom);

  const host = url.port ? `${url.host}:${url.port}` : url.host;

  const peer = client.socketPeer
    ? `${client.socketPeer}${client.socketPeerPort ? `:${client.socketPeerPort}` : ''}`
    : '—';
  const local = `${connection.local.address || '—'}:${connection.local.port || '—'}`;

  const declared = client.declaredClient
    ? `${client.declaredClient}（来自 ${client.declaredSource ?? '未知来源'}）`
    : '—';

  const rows = [
    row('url', url.absolute),
    rowTags('scheme', url.scheme, schemeTag),
    rowTags('host', host, hostTag),
    rowTags('socket', `${peer} → 本机 ${local}`, tagFact()),
    rowTags('client', declared, tagDeclared(client.declaredSource)),
    row('id', meta.id),
    row('received', meta.receivedAt),
    row('duration', formatMs(meta.durationMs)),
  ].join('');

  const headline = [
    `<div class="reqline">`,
    `<span class="method ${methodClass(line.method)}">${esc(line.method)}</span>`,
    `<span class="target">${esc(line.target)}</span>`,
    `<span class="ver">${esc(formatHttpVersion(line.httpVersion))}</span>`,
    `<span class="reqline-meta">${esc(versionLabel(connection.httpVersion))} · ${esc(formatMs(meta.durationMs))}</span>`,
    '</div>',
  ].join('');

  const extra = [
    '<p class="hint">',
    '本区块第 2 行起是「收到了什么字节」与「这些字节自己声称了什么」的对照：',
    '标 <span class="tag tag-fact">socket 事实</span> 的来自 TCP 连接，',
    '标 <span class="tag tag-declared">声明值 / 可伪造</span> 的来自请求头。',
    '</p>',
  ].join('');

  return `<div class="headline" id="sec-headline">${headline}<div class="grid">${rows}</div>${extra}</div>`;
}

/**
 * body 区块（计划 §5.9 / §6.1 / §6.6）。
 *
 * 内容按 `body.kind` 分支（计划 §5.9 的嗅探矩阵）：
 *
 * | kind | 展示 |
 * | --- | --- |
 * | empty     | 「本次请求未携带 body」（缺数据不隐藏区块，计划 §6.2） |
 * | json      | **原样**文本 + **美化**后的 JSON（两份都在，切换由前端做，计划 §6.4） |
 * | form      | 字段表（重复键保留）+ 原样文本 |
 * | multipart | 部件表（name / filename / content-type / length，**不解码文件内容**） |
 * | text      | 原样文本 |
 * | binary    | hexdump（前 4 KiB） |
 *
 * 另外固定给出：
 * - `length` 与 `declaredLength` 不一致时的黄色告警（计划 §4 / §6.6）；
 * - 截断横幅（计划 §6.6）；
 * - `sha256`（永远对原始字节算，见 core/body.ts）。
 *
 * 脱敏口径：strict 模式下页面拿到的是 `render/html.ts` 的 `sanitizeDump()` 处理过的 dump，
 * 这里的文本里不会有明文（计划 §5.8 / §11.10）。
 */

import type { RequestDump } from '../../../shared/types.js';
import {
  copyBlockButton,
  emptyState,
  esc,
  formatBytes,
  maskedCell,
  pre,
  row,
  section,
  truncationBanner,
  warnLine,
} from '../html.js';

/** body.kind → 展示名（计划 §5.9 的 kind 直接用小写英文，呼应 dump 风）。 */
const KIND_LABELS: Record<RequestDump['body']['kind'], string> = {
  empty: 'empty',
  json: 'json',
  form: 'form',
  text: 'text',
  binary: 'binary',
  multipart: 'multipart',
};

/**
 * JSON 美化：只做 `JSON.stringify(_, null, 2)`，不做语法着色（计划 §6.4）。
 */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

/** json / form / text 的原样文本。 */
function rawText(body: RequestDump['body']): string {
  return body.text ?? '';
}

/**
 * 渲染 body 区块。
 */
export function renderBody(dump: RequestDump): string {
  const body = dump.body;
  const mode = dump.security.maskMode;

  const metaRows = [
    row('kind', KIND_LABELS[body.kind]),
    row('content-type', body.contentType ?? '—'),
    body.charset === null ? '' : row('charset', body.charset),
    body.contentEncoding === null ? '' : row('content-encoding', body.contentEncoding),
    row('length', formatBytes(body.length)),
    row('declared-length', body.declaredLength === null ? '—' : formatBytes(body.declaredLength)),
    row('sha256', body.sha256),
  ].join('');

  // ---- 告警：长度不一致 / 截断 / 压缩 / JSON 解析失败 ----
  const warnings: string[] = [];

  if (body.declaredLength !== null && body.declaredLength !== body.length) {
    warnings.push(
      warnLine(
        `Content-Length 声明 ${body.declaredLength} B 与实际收到的 ${body.length} B 不一致（可能被截断或分块传输）`,
      ),
    );
  }

  if (body.truncated) {
    warnings.push(
      truncationBanner(`body 已截断：共 ${formatBytes(body.length)}，以下只展示收到的部分`),
    );
  }

  if (body.contentEncoding !== null) {
    warnings.push(
      warnLine(`Content-Encoding: ${body.contentEncoding} —— 不解压，下面是压缩后的原始字节`),
    );
  }

  if (body.jsonError !== undefined) {
    warnings.push(warnLine(`JSON 解析失败：${body.jsonError}（按原样文本展示）`));
  }

  // ---- 按 kind 分支 ----
  let content = '';
  let note = '';

  switch (body.kind) {
    case 'empty': {
      content = emptyState('本次请求未携带 body');
      note = 'body 区块不隐藏：没有 body 也是一条信息。';
      break;
    }

    case 'json': {
      const raw = rawText(body);
      const pretty = body.json === undefined ? '' : prettyJson(body.json);
      content = [
        '<div class="body-json">',
        '<button type="button" class="pretty" data-pretty-toggle="body-json">[pretty]</button>',
        pre(raw, 'body-raw'),
        pretty === '' ? '' : pre(pretty, 'body-pretty', { hidden: true }),
        '</div>',
      ].join('');
      note = '上面是收到的原样字节，下面是 JSON.stringify(_, null, 2) 的美化结果（不做语法着色）。';
      break;
    }

    case 'form': {
      const fields = body.fields ?? [];
      const fieldRows = fields
        .map((field) => {
          const cell = maskedCell(
            { name: field.key, value: field.value, masked: field.masked },
            'query',
            mode,
          );
          return `<div class="row"><span class="k">${esc(field.key)}</span><span class="v">${cell}</span></div>`;
        })
        .join('');
      content = [
        fields.length === 0
          ? emptyState('Content-Type 声明为表单，但没有解析出字段')
          : `<div class="grid">${fieldRows}</div>`,
        pre(rawText(body), 'body-raw'),
      ].join('');
      note = '字段表按出现顺序排列，重复键全部保留；下面是原样的 urlencoded 文本。';
      break;
    }

    case 'multipart': {
      const parts = body.parts ?? [];
      const partRows = parts
        .map((part) =>
          row(
            part.name ?? '—',
            `filename=${part.filename ?? '—'} · type=${part.contentType ?? '—'} · ${formatBytes(part.length)}`,
          ),
        )
        .join('');
      content =
        parts.length === 0
          ? emptyState('Content-Type 声明为 multipart，但没有解析出部件')
          : `<div class="grid">${partRows}</div>`;
      note =
        '只列结构（name / filename / content-type / 长度），不解释文件内容，避免把二进制糊到页面上。';
      break;
    }

    case 'text': {
      content = pre(rawText(body), 'body-raw');
      note = '按 charset 解码后的原样文本（非法字节用 U+FFFD 代替）。';
      break;
    }

    case 'binary': {
      content = pre(body.hexPreview ?? '', 'body-hex');
      note = '二进制 body 给 hexdump（前 4 KiB），sha256 对全部原始字节计算。';
      break;
    }
  }

  const bodyHtml = [`<div class="grid">${metaRows}</div>`, warnings.join(''), content].join('');

  const count = `${formatBytes(body.length)} · ${KIND_LABELS[body.kind]}`;

  return section({
    id: 'sec-body',
    title: 'body',
    count,
    body: bodyHtml,
    note,
    tools: copyBlockButton('sec-body'),
  });
}

/**
 * 浏览器端增强（计划 §6.4 / §10 M4）。
 *
 * 只做四件事：**揭示 / 过滤 / 复制 / 折叠**（外加 body 的「原样 ↔ 美化」切换）。
 *
 * 硬约束（照计划抄下来的）：
 * - **只做增强**：禁 JS 时页面完整可读（计划 §10 M3），本页所有内容都来自 SSR；
 * - **不造明文**：揭示只是把 SSR 已经写在 DOM 里的 `data-value` 换回显示。
 *   strict 模式下服务端根本不下发明文（计划 §5.8），页面里也没有 `data-value`，
 *   前端拿不到也就显示不出来；
 * - **无 fetch、无动画、无 localStorage**（计划 §6.4）；
 * - 产物 `public/app.js` < 8KB（计划 §2 / §6.4）。
 *
 * 依赖的 SSR 钩子（都在 src/render/html.ts 与 sections/*.ts 里就位）：
 * - `.reveal` 按钮 + `.val[data-mask][data-value]`（单条揭示）；
 * - `[data-reveal-all]` 按钮（揭示全部）；
 * - `.row[data-row][data-name][data-text]`（按「名 或 值」过滤）；
 * - `.copy[data-copy="value"]` / `.copy-block[data-copy-block="<section id>"]`；
 * - `.pretty[data-pretty-toggle]` + `.body-raw` / `.body-pretty`（原样 ↔ 美化）；
 * - `.sec` / `.sec-head` / `.sec-body`（区块，可折叠）。
 */

/* -------------------------------------------------------------------------- */
/* DOM 小工具                                                                  */
/* -------------------------------------------------------------------------- */

/** 取第一个匹配元素。 */
function one<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

/** 取全部匹配元素（真数组）。 */
function all<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** 去掉首尾空白（复制出去的东西不带缩进噪声）。 */
function trim(text: string | null): string {
  return (text ?? '').trim();
}

/* -------------------------------------------------------------------------- */
/* 复制                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 复制到剪贴板：优先 `navigator.clipboard`，失败降级 `document.execCommand('copy')`。
 *
 * 计划 §6.4 只要求「点击复制原文」，但 `execCommand` 在部分浏览器里仍是最稳的兜底
 * （非安全上下文、剪贴板权限被拒时）。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 剪贴板 API 不可用（权限被拒 / 非安全上下文）→ 走下面的降级分支
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.append(area);
  area.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

/** 复制并给按钮一个短暂反馈（[copied] / [failed]）。 */
async function copyWithFeedback(button: HTMLElement, text: string): Promise<void> {
  const copied = await copyText(text);
  const original = button.textContent ?? '';
  button.textContent = copied ? '[copied]' : '[failed]';
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

/**
 * 一行里应该被复制的值（计划 §7.2：**默认给掩码版**，防止 token 被截图外泄）。
 *
 * - 掩码态：复制 `data-mask`（掩码串）；
 * - 已揭示态：复制屏幕上显示的明文（用户自己点了 [reveal]）；
 * - 普通值：复制原文。
 */
function valueText(row: Element): string {
  const value = one<HTMLElement>('.val', row);
  if (value) {
    if (value.classList.contains('revealed')) return trim(value.textContent);
    const mask = value.getAttribute('data-mask');
    if (mask !== null) return mask.trim();
    return trim(value.textContent);
  }
  // 没有 .val 的行（例如 query 的 raw 行）→ 复制原样片段，去掉行内的 "raw: " 前缀
  const raw = one<HTMLElement>('.raw', row);
  if (raw) return trim(raw.textContent).replace(/^raw:\s*/, '');
  return trim(one('.v', row)?.textContent ?? '');
}

/**
 * 整块的 `name: value` 文本（计划 §6.4 的 `[copy block]`）。
 *
 * 行按 `名: 值` 拼；区块里的 `<pre>`（body 原样文本等）单独附在后面。
 */
function blockText(section: Element | null): string {
  if (!section) return '';
  const lines: string[] = [];
  for (const row of all('.row', section)) {
    lines.push(`${trim(one('.k', row)?.textContent ?? '')}: ${valueText(row)}`);
  }
  for (const pre of all<HTMLElement>('.pre', section)) {
    if (pre.hidden) continue;
    const text = (pre.textContent ?? '').replace(/\s+$/, '');
    if (text !== '') lines.push(text);
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* 揭示                                                                        */
/* -------------------------------------------------------------------------- */

/** 掩码值切换显示：明文在 `data-value` 里，掩码串在 `data-mask` 里。 */
function setRevealed(value: HTMLElement, on: boolean): void {
  if (on) {
    const plain = value.getAttribute('data-value');
    if (plain === null) return;
    value.textContent = plain;
    value.classList.add('revealed');
    return;
  }
  const mask = value.getAttribute('data-mask');
  if (mask === null) return;
  value.textContent = mask;
  value.classList.remove('revealed');
}

/** 同步所有 [reveal] / [reveal all] 按钮的文案。 */
function syncRevealLabels(): void {
  const values = all<HTMLElement>('.val[data-value]');
  const allOn = values.length > 0 && values.every((value) => value.classList.contains('revealed'));
  for (const button of all<HTMLElement>('[data-reveal-all]')) {
    // 这一页没有可揭示的值（没有敏感项 / strict 模式）→ 按钮没有意义，藏掉
    button.hidden = values.length === 0;
    button.textContent = allOn ? '[hide all]' : '[reveal all]';
  }
  for (const button of all<HTMLElement>('.reveal')) {
    const value = one<HTMLElement>('.val', button.parentElement ?? document);
    button.textContent = value?.classList.contains('revealed') ? '[hide]' : '[reveal]';
  }
}

/** 单条揭示：点一下显示明文，再点一下收回掩码串。 */
function wireReveal(): void {
  for (const button of all<HTMLElement>('.reveal')) {
    button.addEventListener('click', () => {
      const value = one<HTMLElement>('.val', button.parentElement ?? document);
      if (!value) return;
      setRevealed(value, !value.classList.contains('revealed'));
      syncRevealLabels();
    });
  }
}

/** 揭示全部：页面上所有带 `data-value` 的掩码值一起切换。 */
function wireRevealAll(): void {
  for (const button of all<HTMLElement>('[data-reveal-all]')) {
    button.addEventListener('click', () => {
      const values = all<HTMLElement>('.val[data-value]');
      const on = !values.every((value) => value.classList.contains('revealed'));
      for (const value of values) setRevealed(value, on);
      syncRevealLabels();
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 过滤                                                                        */
/* -------------------------------------------------------------------------- */

interface FilterBox {
  input: HTMLInputElement;
  count: HTMLElement;
  rows: HTMLElement[];
}

/**
 * 给一个区块准备过滤框。
 *
 * SSR 只给 headers 区块带了过滤框（`#header-filter` + `#filter-count`），
 * query / cookies 的过滤框由前端补一个（结构与 SSR 的完全一致，样式共用 `.filter`）。
 */
function setupFilter(sectionId: string, label: string): FilterBox | null {
  const section = document.getElementById(sectionId);
  if (!section) return null;

  const grid = one('.grid', section);
  if (!grid) return null;

  const rows = all<HTMLElement>('[data-row]', grid);
  if (rows.length === 0) return null;

  let input = one<HTMLInputElement>('.filter-input', section);
  let count = one<HTMLElement>('.filter-count', section);

  if (!input || !count) {
    const box = document.createElement('div');
    box.className = 'filter';

    input = document.createElement('input');
    input.className = 'filter-input';
    input.type = 'search';
    input.placeholder = '按名字或值过滤（/ 聚焦）';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `过滤 ${label}`);

    count = document.createElement('span');
    count.className = 'filter-count';

    box.append(input, count);
    one('.sec-body', section)?.prepend(box);
  }

  return { input, count, rows };
}

/** 过滤：按「名 或 值」实时匹配，命中计数 `12/22`。 */
function wireFilters(): void {
  const boxes = [
    setupFilter('sec-headers', 'header'),
    setupFilter('sec-query', 'query'),
    setupFilter('sec-cookies', 'cookie'),
  ];

  for (const box of boxes) {
    if (!box) continue;
    const apply = (): void => {
      const needle = box.input.value.trim().toLowerCase();
      let shown = 0;
      for (const row of box.rows) {
        const name = row.dataset.name ?? '';
        const value = row.dataset.text ?? trim(one('.v', row)?.textContent ?? '');
        const hit = needle === '' || `${name} ${value}`.toLowerCase().includes(needle);
        row.hidden = !hit;
        if (hit) shown += 1;
      }
      box.count.textContent = `${shown}/${box.rows.length}`;
    };
    box.input.addEventListener('input', apply);
    apply();
  }
}

/* -------------------------------------------------------------------------- */
/* 复制按钮                                                                    */
/* -------------------------------------------------------------------------- */

function wireCopy(): void {
  for (const button of all<HTMLElement>('[data-copy="value"]')) {
    button.addEventListener('click', () => {
      const row = button.closest('.row');
      if (!row) return;
      void copyWithFeedback(button, valueText(row));
    });
  }

  for (const button of all<HTMLElement>('[data-copy-block]')) {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-copy-block') ?? '';
      void copyWithFeedback(button, blockText(document.getElementById(id)));
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 折叠                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 区块折叠：给每个 `.sec` 的标题栏加一个 `[fold]` 按钮（SSR 没给这个钩子）。
 *
 * 折叠的是 `.sec-body`，标题栏保留在原位；打印样式会把折叠的区块展开（计划 §6.5）。
 */
function wireFold(): void {
  for (const section of all<HTMLElement>('.sec')) {
    const head = one('.sec-head', section);
    const body = one<HTMLElement>('.sec-body', section);
    if (!head || !body) continue;

    let tools = one<HTMLElement>('.sec-tools', head);
    if (!tools) {
      tools = document.createElement('span');
      tools.className = 'sec-tools';
      head.append(tools);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fold';
    button.textContent = '[fold]';
    button.addEventListener('click', () => {
      const folded = body.hidden;
      body.hidden = !folded;
      button.textContent = folded ? '[unfold]' : '[fold]';
    });

    tools.prepend(button);
  }
}

/* -------------------------------------------------------------------------- */
/* body 原样 ↔ 美化                                                             */
/* -------------------------------------------------------------------------- */

/** `[pretty]` 切换：原样文本与 `JSON.stringify(_, null, 2)` 的美化结果互换。 */
function wirePretty(): void {
  for (const button of all<HTMLElement>('[data-pretty-toggle]')) {
    button.addEventListener('click', () => {
      const host = button.parentElement;
      if (!host) return;
      const raw = one<HTMLElement>('.body-raw', host);
      const pretty = one<HTMLElement>('.body-pretty', host);
      if (!raw || !pretty) return;
      const showPretty = pretty.hidden;
      pretty.hidden = !showPretty;
      raw.hidden = showPretty;
      button.textContent = showPretty ? '[raw]' : '[pretty]';
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 键盘                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 键盘：`/` 聚焦过滤框，`Esc` 清空当前过滤框（计划 §6.4 / §11.12）。
 */
function wireKeyboard(): void {
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName ?? '';
    const typing =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      target?.isContentEditable === true;

    if (event.key === '/' && !typing) {
      const input =
        one<HTMLInputElement>('#header-filter') ?? one<HTMLInputElement>('.filter-input');
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
      return;
    }

    if (event.key === 'Escape' && target instanceof HTMLInputElement) {
      if (!target.classList.contains('filter-input')) return;
      target.value = '';
      target.dispatchEvent(new Event('input'));
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                        */
/* -------------------------------------------------------------------------- */

function main(): void {
  wireReveal();
  wireRevealAll();
  wireFilters();
  wireCopy();
  wireFold();
  wirePretty();
  wireKeyboard();
  syncRevealLabels();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

export {};

// 本体の表示のうち、文書の状態を持たない部品：プレビューとページ内リンク、スクロールの連動、ツリーの表示、図形と properties（詳細設計 3.8）

import type { EditorView } from '@codemirror/view';

import { createButton, createElement } from './dom.ts';
import { renderGeoJson } from './geojson.ts';
import type { RenderedMarkdown } from './markdown.ts';
import { renderTree } from './tree.ts';
import type { TreeHandle } from './tree.ts';

// スクロールの連動で、片方を動かした直後に相手からの連動を無視する時間
const SCROLL_SYNC_IGNORE_MS = 100;

export const NO_VALUE_YET_MESSAGE = 'まだ正しく読めていないため表示できません。誤りパネルの項目から直してください';

/** ページ内リンク（`#…`）は、目次の slug が一致する見出し、なければ `user-content-<値>` の要素へ移る（F2-4） */
function handlePreviewClick(event: MouseEvent, preview: HTMLElement, rendered: RenderedMarkdown): void {
  const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;

  if (link === null) {
    return;
  }

  event.preventDefault();

  let anchor: string;

  try {
    anchor = decodeURIComponent((link.getAttribute('href') ?? '').slice(1));
  } catch {
    return;
  }

  const entry = rendered.toc.find((toc) => toc.slug === anchor);
  const target =
    entry === undefined ? document.getElementById(`user-content-${anchor}`) : preview.querySelector(`[data-toc="${rendered.nonce}:${entry.index}"]`);

  if (target !== null && preview.contains(target)) {
    target.scrollIntoView({ block: 'start' });
  }
}

export function createPreview(rendered: RenderedMarkdown): HTMLElement {
  const preview = createElement('article', 'markdown-body preview');

  // DOMPurify を通した html だけを入れる（N2-4）
  preview.innerHTML = rendered.html;
  preview.addEventListener('click', (event) => {
    handlePreviewClick(event, preview, rendered);
  });

  return preview;
}

/** 元の行の印（data-line）の付いた要素と、その行・プレビューの中の縦の位置 */
function lineMarks(preview: HTMLElement, nonce: string): { line: number; top: number }[] {
  const base = preview.getBoundingClientRect().top - preview.scrollTop;

  return [...preview.querySelectorAll<HTMLElement>(`[data-line^="${nonce}:"]`)].map((element) => ({
    line: Number(element.dataset.line?.slice(nonce.length + 1)),
    top: element.getBoundingClientRect().top - base,
  }));
}

/** 印の間を補間する。from の値（行か位置）から to の値を求める */
function interpolate(marks: { line: number; top: number }[], value: number, from: 'line' | 'top', to: 'line' | 'top'): number {
  const index = marks.findLastIndex((mark) => mark[from] <= value);
  const before = marks[Math.max(0, index)];
  const after = marks[index + 1];

  if (before === undefined) {
    return 0;
  }

  if (after === undefined || after[from] === before[from]) {
    return before[to];
  }

  return before[to] + ((after[to] - before[to]) * (value - before[from])) / (after[from] - before[from]);
}

/** 編集＋プレビューのスクロールの連動。片方を動かした直後は、相手からの連動を無視する */
export function attachScrollSync(preview: HTMLElement, nonce: string, editor: EditorView): void {
  const scroller = editor.scrollDOM;
  let ignoreUntil = 0;

  scroller.addEventListener('scroll', () => {
    if (Date.now() < ignoreUntil) {
      return;
    }

    const block = editor.lineBlockAtHeight(scroller.scrollTop);
    const topLine = editor.state.doc.lineAt(block.from).number;

    ignoreUntil = Date.now() + SCROLL_SYNC_IGNORE_MS;
    preview.scrollTop = interpolate(lineMarks(preview, nonce), topLine, 'line', 'top');
  });
  preview.addEventListener('scroll', () => {
    if (Date.now() < ignoreUntil) {
      return;
    }

    const line = Math.round(interpolate(lineMarks(preview, nonce), preview.scrollTop, 'top', 'line'));
    const doc = editor.state.doc;

    ignoreUntil = Date.now() + SCROLL_SYNC_IGNORE_MS;
    scroller.scrollTop = editor.lineBlockAt(doc.line(Math.min(Math.max(1, line), doc.lines)).from).top;
  });
}

/**
 * ツリーの表示（全開・全閉・検索欄・前・次とツリー本体）。value が undefined（まだ読めていない）なら案内だけ出す。
 * brokenCount は JSON Lines の全行のツリーで除いた誤りの行の数
 */
export function renderTreeView(
  value: unknown,
  brokenCount: number,
  onPartlyExpanded: () => void,
): { element: HTMLElement; handle: TreeHandle | null } {
  const wrapper = createElement('div', 'tree-view');

  if (value === undefined) {
    wrapper.append(createElement('p', 'guide', NO_VALUE_YET_MESSAGE));

    return { element: wrapper, handle: null };
  }

  const toolbar = createElement('div', 'tree-toolbar');
  const search = createElement('input', 'tree-search');
  const count = createElement('span', 'tree-count');
  const container = createElement('div', 'tree-container');
  const handle = renderTree(container, value);

  search.type = 'search';
  search.placeholder = '検索';
  search.setAttribute('aria-label', 'ツリーを検索');
  search.addEventListener('input', () => {
    count.textContent = search.value === '' ? '' : `${handle.search(search.value)} 件`;
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }

    if (event.shiftKey) {
      handle.prev();
    } else {
      handle.next();
    }
  });
  toolbar.append(
    createButton('tree-expand', '全開', () => {
      if (!handle.expandAll()) {
        onPartlyExpanded();
      }
    }),
    createButton('tree-collapse', '全閉', handle.collapseAll),
    search,
    createButton('tree-prev', '前', handle.prev),
    createButton('tree-next', '次', handle.next),
    count,
  );
  wrapper.append(toolbar);

  if (brokenCount > 0) {
    wrapper.append(createElement('p', 'tree-excluded', `誤りのある ${brokenCount} 行を除いた`));
  }

  wrapper.append(container);

  return { element: wrapper, handle };
}

/** クリックした Feature の properties を、見出しにパス、本文にキーと値の表で出す */
export function showProperties(panel: HTMLElement, properties: unknown, path: string): void {
  const table = createElement('table', 'properties-table');

  if (typeof properties === 'object' && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      const row = createElement('tr', '');

      row.append(createElement('th', '', key), createElement('td', '', typeof value === 'string' ? value : JSON.stringify(value)));
      table.append(row);
    }
  }

  panel.replaceChildren(
    createElement('h2', 'properties-path', path),
    table.rows.length > 0 ? table : createElement('p', 'guide', 'properties はありません'),
  );
}

export function renderShapeView(
  lastGood: { readonly value: unknown } | null,
  errorFeatures: Set<string>,
  onSelect: (properties: unknown, path: string) => void,
): HTMLElement {
  const container = createElement('div', 'shape-view');

  if (lastGood === null) {
    container.append(createElement('p', 'guide', NO_VALUE_YET_MESSAGE));

    return container;
  }

  const result = renderGeoJson(container, lastGood.value, errorFeatures, onSelect);

  if (!result.drawn) {
    container.append(createElement('p', 'guide', `大きすぎるため図形を描きません（位置 ${result.count} 個、上限 50 万）。ツリーで見てください`));
  }

  return container;
}

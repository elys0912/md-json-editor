// 本体の表示のうち、文書の状態を持たない部品：プレビューとページ内リンク、スクロールの連動、ツリーの表示、図形と properties（詳細設計 3.8）

import type { EditorView } from '@codemirror/view';

import { createButton, createElement } from './dom.ts';
import { MAX_DRAWN_POSITIONS, renderGeoJson } from './geojson.ts';
import type { RenderedMarkdown } from './markdown.ts';
import { renderTree } from './tree.ts';
import type { TreeHandle } from './tree.ts';

// スクロールの連動で、片方を動かした直後に相手からの連動を無視する時間
const SCROLL_SYNC_IGNORE_MS = 100;

const NO_VALUE_YET_MESSAGE = 'まだ正しく読めていないため表示できません。誤りパネルの項目から直してください';
const NO_PROPERTIES_MESSAGE = 'properties はありません';
const TEN_THOUSAND = 10_000;

/** プレビュー。本文が変わったら update で中身だけ差し替える（要素とイベントは作り直さない） */
export interface PreviewHandle {
  readonly element: HTMLElement;
  readonly current: () => RenderedMarkdown;
  readonly update: (rendered: RenderedMarkdown) => void;
}

interface LineMark {
  readonly line: number;
  readonly top: number;
}

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

export function createPreview(initial: RenderedMarkdown): PreviewHandle {
  const element = createElement('article', 'markdown-body preview');
  let rendered = initial;

  // DOMPurify を通した html だけを入れる（N2-4）
  element.innerHTML = rendered.html;
  element.addEventListener('click', (event) => {
    handlePreviewClick(event, element, rendered);
  });

  return {
    element,
    current: () => rendered,
    update(next) {
      rendered = next;
      element.innerHTML = next.html;
      element.dispatchEvent(new Event('preview-updated'));
    },
  };
}

/** 元の行の印（data-line）の付いた要素と、その行・プレビューの中の縦の位置 */
function lineMarks(preview: HTMLElement, nonce: string): LineMark[] {
  const base = preview.getBoundingClientRect().top - preview.scrollTop;

  return [...preview.querySelectorAll<HTMLElement>(`[data-line^="${nonce}:"]`)].map((element) => ({
    line: Number(element.dataset.line?.slice(nonce.length + 1)),
    top: element.getBoundingClientRect().top - base,
  }));
}

/** 印の間を補間する。from の値（行か位置）から to の値を求める */
function interpolate(marks: readonly LineMark[], value: number, from: keyof LineMark, to: keyof LineMark): number {
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

/**
 * 編集＋プレビューのスクロールの連動。片方を動かした直後は、相手からの連動だけを無視する（自分側の続きは追う）。
 * 印の位置は、本文の差し替えと画面の大きさの変化まで使い回す。signal で外す
 */
export function attachScrollSync(preview: PreviewHandle, editor: EditorView, signal: AbortSignal): void {
  const scroller = editor.scrollDOM;
  let ignored: { source: 'editor' | 'preview'; until: number } | null = null;
  let marks: LineMark[] | null = null;

  const isIgnored = (source: 'editor' | 'preview'): boolean => ignored !== null && ignored.source === source && Date.now() < ignored.until;
  const currentMarks = (): LineMark[] => (marks ??= lineMarks(preview.element, preview.current().nonce));
  const forgetMarks = (): void => {
    marks = null;
  };

  scroller.addEventListener(
    'scroll',
    () => {
      if (isIgnored('editor')) {
        return;
      }

      const topLine = editor.state.doc.lineAt(editor.lineBlockAtHeight(scroller.scrollTop).from).number;

      ignored = { source: 'preview', until: Date.now() + SCROLL_SYNC_IGNORE_MS };
      preview.element.scrollTop = interpolate(currentMarks(), topLine, 'line', 'top');
    },
    { signal },
  );
  preview.element.addEventListener(
    'scroll',
    () => {
      if (isIgnored('preview')) {
        return;
      }

      const line = Math.round(interpolate(currentMarks(), preview.element.scrollTop, 'top', 'line'));
      const doc = editor.state.doc;

      ignored = { source: 'editor', until: Date.now() + SCROLL_SYNC_IGNORE_MS };
      scroller.scrollTop = editor.lineBlockAt(doc.line(Math.min(Math.max(1, line), doc.lines)).from).top;
    },
    { signal },
  );
  preview.element.addEventListener('preview-updated', forgetMarks, { signal });
  window.addEventListener('resize', forgetMarks, { signal });
}

function buildTreeToolbar(handle: TreeHandle, onPartlyExpanded: () => void): HTMLElement {
  const toolbar = createElement('div', 'tree-toolbar');
  const search = createElement('input', 'tree-search');
  const count = createElement('span', 'tree-count');

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

  return toolbar;
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

  const treeBody = createElement('div', 'tree-body');
  const handle = renderTree(treeBody, value);

  wrapper.append(buildTreeToolbar(handle, onPartlyExpanded));

  if (brokenCount > 0) {
    wrapper.append(createElement('p', 'tree-excluded', `誤りのある ${brokenCount} 行を除いた`));
  }

  wrapper.append(treeBody);

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
    table.rows.length > 0 ? table : createElement('p', 'guide', NO_PROPERTIES_MESSAGE),
  );
}

export function renderShapeView(
  lastGood: { readonly value: unknown } | null,
  errorFeatures: ReadonlySet<string>,
  onSelect: (properties: unknown, path: string) => void,
): HTMLElement {
  const container = createElement('div', 'shape-view');

  if (lastGood === null) {
    container.append(createElement('p', 'guide', NO_VALUE_YET_MESSAGE));

    return container;
  }

  const drawResult = renderGeoJson(container, lastGood.value, errorFeatures, onSelect);

  if (!drawResult.drawn) {
    // 4 章の文言どおり「50 万」の形で出す
    const limitInMan = MAX_DRAWN_POSITIONS / TEN_THOUSAND;

    container.append(
      createElement('p', 'guide', `大きすぎるため図形を描きません（位置 ${drawResult.count} 個、上限 ${limitInMan} 万）。ツリーで見てください`),
    );
  }

  return container;
}

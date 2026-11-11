// 値をツリーとして描く（開いた階層だけ描く）、検索、パスの写し、JSON Lines の行一覧（詳細設計 3.5、F3-2・F3-5・F5-3）
// キーと値は利用者由来なので textContent でだけ出す（N2-4）
// パスの例：`$.items[2].name`、識別子にならないキーは `$["a b"]`

import { createButton, createElement } from './dom.ts';
import { describeLineError } from './json.ts';
import type { JsonlLine } from './json.ts';

export interface TreeHandle {
  // 開き切れたら true。描くノードが上限を超えたら途中で止めて false
  readonly expandAll: () => boolean;
  readonly collapseAll: () => void;
  // 一致した数（上限 MAX_SEARCH_MATCHES）を返す。移動は next と prev で行う
  readonly search: (query: string) => number;
  readonly next: () => void;
  readonly prev: () => void;
  // パスのノードの祖先を開いて強調する。誤りパネルから GeoJSON の構造の誤りを開くときに使う
  readonly reveal: (path: string) => void;
}

// 子をこの数ずつ描く（N3-2）
const CHILD_CHUNK = 500;
// 全開で描くノードの上限
const MAX_EXPANDED_NODES = 5_000;
// 検索や誤りの位置への移動で、1 つの親の下に描き足していく子の上限。隣の束へ順に移り続けても、描く数を抑える
const MAX_REVEALED_CHILDREN = 5_000;
// 文字列の値の要約の長さ
const MAX_SUMMARY_LENGTH = 200;
// UTF-16 の上位サロゲートの範囲。切り詰めの末尾がこの範囲だと、サロゲートペアを割ってしまう
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const MAX_SEARCH_MATCHES = 1_000;
// JSON Lines の行一覧をこの数ずつ描く（N3-2）
const ROW_CHUNK = 1_000;

const ROOT_PATH = '$';
// 検索の直後など、どの一致も指していない状態
const NO_CURRENT = -1;

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;
// パスの 1 区切り：`.key`、`[0]`、`["key"]`
const PATH_SEGMENT_PATTERN = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g;

type Key = string | number;

interface TreeNode {
  readonly path: string;
  readonly value: unknown;
  readonly li: HTMLLIElement;
  readonly row: HTMLDivElement;
  readonly toggle: HTMLButtonElement | null;
  readonly childList: HTMLUListElement;
  readonly children: TreeNode[];
  // 描いた子の範囲（begin 以上 end 未満）。離れた位置へ移ったとき（showChunkOf）だけ begin が 0 でなくなる
  begin: number;
  end: number;
  expanded: boolean;
}

interface SearchItem {
  readonly path: string;
  readonly key: Key | null;
  readonly value: unknown;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function childEntries(value: unknown): [Key, unknown][] {
  if (Array.isArray(value)) {
    return value.map((child, index) => [index, child]);
  }

  return isContainer(value) ? Object.entries(value) : [];
}

function childPath(parent: string, key: Key): string {
  if (typeof key === 'number') {
    return `${parent}[${key}]`;
  }

  return IDENTIFIER_PATTERN.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/** パスを区切りの列に直す。`$` だけなら空の列 */
function parsePath(path: string): Key[] {
  return [...path.matchAll(PATH_SEGMENT_PATTERN)].map(([, name, index, quoted]) => {
    if (index !== undefined) {
      return Number(index);
    }

    return name ?? String(JSON.parse(quoted ?? '""'));
  });
}

/** MAX_SUMMARY_LENGTH 文字で切る。末尾がサロゲートペアの前半なら、ペアを割らないよう 1 文字短く切る */
function truncate(text: string): string {
  if (text.length <= MAX_SUMMARY_LENGTH) {
    return text;
  }

  const lastUnit = text.charCodeAt(MAX_SUMMARY_LENGTH - 1);
  const isSplittingPair = lastUnit >= HIGH_SURROGATE_FIRST && lastUnit <= HIGH_SURROGATE_LAST;

  return `${text.slice(0, isSplittingPair ? MAX_SUMMARY_LENGTH - 1 : MAX_SUMMARY_LENGTH)}…`;
}

/** 値の要約。オブジェクトは `{n}`、配列は `[n]`、文字列は引用符つきで MAX_SUMMARY_LENGTH 文字で切る */
function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }

  if (isContainer(value)) {
    return `{${Object.keys(value).length}}`;
  }

  return typeof value === 'string' ? `"${truncate(value)}"` : String(value);
}

function valueClass(value: unknown): string {
  if (value === null) {
    return 'tree-null';
  }

  return isContainer(value) ? 'tree-container' : `tree-${typeof value}`;
}

function copyPath(path: string): void {
  // クリップボードが使えない環境では何もしない。HTTP など安全でない文脈では navigator.clipboard が undefined になるが、型定義には現れない
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  void navigator.clipboard?.writeText(path).catch(() => undefined);
}

// 描いたノード（パス → ノード）。開いた階層だけを持ち、閉じたら子の分を捨てる
interface TreeState {
  readonly nodes: Map<string, TreeNode>;
}

function expandAll(state: TreeState, root: TreeNode): boolean {
  const queue: TreeNode[] = [root];

  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    if (state.nodes.size > MAX_EXPANDED_NODES) {
      return false;
    }

    expand(state, node);
    queue.push(...node.children);
  }

  return true;
}

/** path のノードの行を返す。祖先を開き、描いた範囲の外にあればその束を描く */
function findRow(state: TreeState, root: TreeNode, path: string): HTMLElement | undefined {
  let node: TreeNode | undefined = root;

  for (const key of parsePath(path)) {
    if (node === undefined) {
      return undefined;
    }

    const parent: TreeNode = node;
    const index = childEntries(parent.value).findIndex(([entryKey]) => entryKey === key);

    if (index < 0) {
      return undefined;
    }

    showChild(state, parent, index);
    markExpanded(parent);

    node = state.nodes.get(childPath(parent.path, key));
  }

  return node?.row;
}

function createNode(state: TreeState, path: string, label: string, nodeValue: unknown): TreeNode {
  const li = createElement('li', 'tree-node');
  const row = createElement('div', 'tree-row');
  const hasChildren = childEntries(nodeValue).length > 0;
  const toggle = hasChildren ? createButton('tree-toggle', '▶') : null;
  const copy = createButton('tree-copy', '写す');
  const childList = createElement('ul', 'tree-children');

  li.setAttribute('role', 'treeitem');
  childList.setAttribute('role', 'group');
  childList.hidden = true;
  copy.title = 'パスを写す';
  copy.setAttribute('aria-label', `${path} を写す`);
  copy.addEventListener('click', () => {
    copyPath(path);
  });
  row.append(toggle ?? createElement('span', 'tree-toggle-space'), createElement('span', 'tree-key', label), ': ');
  row.append(createElement('span', `tree-value ${valueClass(nodeValue)}`, summarize(nodeValue)), copy);
  li.append(row, childList);

  const node: TreeNode = { path, value: nodeValue, li, row, toggle, childList, children: [], begin: 0, end: 0, expanded: false };

  if (toggle !== null) {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      if (node.expanded) {
        collapse(state, node);
      } else {
        expand(state, node);
      }
    });
  }

  state.nodes.set(path, node);

  return node;
}

function forget(state: TreeState, node: TreeNode): void {
  for (const child of node.children) {
    forget(state, child);
    state.nodes.delete(child.path);
  }

  node.children.length = 0;
  node.begin = 0;
  node.end = 0;
}

/** 描いた子を、控えと画面の両方から捨てる */
function discardChildren(state: TreeState, node: TreeNode): void {
  forget(state, node);
  node.childList.replaceChildren();
}

function createChildren(state: TreeState, node: TreeNode, entries: readonly [Key, unknown][]): TreeNode[] {
  return entries.map(([key, child]) => createNode(state, childPath(node.path, key), String(key), child));
}

function createMoreItem(label: string, onClick: () => void): HTMLLIElement {
  const item = createElement('li', 'tree-more');

  item.append(createButton('tree-more-button', label, onClick));

  return item;
}

/** 描いた範囲の外に子が残っていれば、先頭に「前の」、末尾に「さらに」のボタンを置く */
function placeMoreButtons(state: TreeState, node: TreeNode, childCount: number): void {
  const rest = childCount - node.end;

  for (const item of node.childList.querySelectorAll(':scope > .tree-more')) {
    item.remove();
  }

  if (node.begin > 0) {
    node.childList.prepend(
      createMoreItem(`前の ${Math.min(node.begin, CHILD_CHUNK)} 件（手前に ${node.begin} 件）`, () => {
        showPrevious(state, node);
      }),
    );
  }

  if (rest > 0) {
    node.childList.append(
      createMoreItem(`さらに ${Math.min(rest, CHILD_CHUNK)} 件（残り ${rest} 件）`, () => {
        showMore(state, node);
      }),
    );
  }
}

/** 子を次の CHILD_CHUNK 件だけ末尾に描く */
function showMore(state: TreeState, node: TreeNode): void {
  const entries = childEntries(node.value);
  const end = Math.min(entries.length, node.end + CHILD_CHUNK);
  const added = createChildren(state, node, entries.slice(node.end, end));

  node.children.push(...added);
  node.childList.append(...added.map((child) => child.li));
  node.end = end;
  placeMoreButtons(state, node, entries.length);
}

/** 子を前の CHILD_CHUNK 件だけ先頭に描く */
function showPrevious(state: TreeState, node: TreeNode): void {
  const entries = childEntries(node.value);
  const begin = Math.max(0, node.begin - CHILD_CHUNK);
  const added = createChildren(state, node, entries.slice(begin, node.begin));

  node.children.unshift(...added);
  node.childList.prepend(...added.map((child) => child.li));
  node.begin = begin;
  placeMoreButtons(state, node, entries.length);
}

/**
 * 描いた子を捨て、index を含む束だけを描く。
 * 手前の子を全部描くと件数に比例して遅くなる（7 万件の末尾への移動で約 7 秒）ため、間は描かない
 */
function showChunkOf(state: TreeState, node: TreeNode, index: number): void {
  discardChildren(state, node);
  // 空の範囲を束の先頭に置き、そこから 1 束描く
  node.begin = index - (index % CHILD_CHUNK);
  node.end = node.begin;
  showMore(state, node);
}

/**
 * index の子を描いた状態にする。描いた範囲の隣の束にあれば描き足し、離れていればその束だけを描く。
 * 描き足しは MAX_REVEALED_CHILDREN 件まで。超えるときは隣の束でも描いた分を捨てる
 */
function showChild(state: TreeState, node: TreeNode, index: number): void {
  if (index >= node.begin && index < node.end) {
    return;
  }

  const isNextChunk = index >= node.end && index < node.end + CHILD_CHUNK;
  const isPreviousChunk = index < node.begin && index >= node.begin - CHILD_CHUNK;
  const canGrow = node.end - node.begin < MAX_REVEALED_CHILDREN;

  if (isNextChunk && canGrow) {
    showMore(state, node);
  } else if (isPreviousChunk && canGrow) {
    showPrevious(state, node);
  } else {
    showChunkOf(state, node, index);
  }
}

function markExpanded(node: TreeNode): void {
  if (node.toggle === null) {
    return;
  }

  node.expanded = true;
  node.childList.hidden = false;
  node.toggle.textContent = '▼';
  node.toggle.setAttribute('aria-expanded', 'true');
}

function expand(state: TreeState, node: TreeNode): void {
  if (node.toggle === null || node.expanded) {
    return;
  }

  showMore(state, node);
  markExpanded(node);
}

// 閉じたら子の描画を捨てる（描くノードの数を開いた階層だけに保つ）
function collapse(state: TreeState, node: TreeNode): void {
  if (node.toggle === null || !node.expanded) {
    return;
  }

  discardChildren(state, node);
  node.expanded = false;
  node.childList.hidden = true;
  node.toggle.textContent = '▶';
  node.toggle.setAttribute('aria-expanded', 'false');
}

/** キーか値（文字列・数値・真偽値）に needle（小文字）を含むか */
function matchesNeedle(key: Key | null, value: unknown, needle: string): boolean {
  const contains = (text: string): boolean => text.toLowerCase().includes(needle);
  const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

  return (typeof key === 'string' && contains(key)) || (isPrimitive && contains(String(value)));
}

/** needle（小文字）に一致するノードのパスを、上から下の順に返す。MAX_SEARCH_MATCHES 件に達したら走査をやめる。入れ子が深くても落ちないよう、再帰でなくスタックで走る */
function searchPaths(root: unknown, needle: string): string[] {
  const found: string[] = [];

  if (needle === '') {
    return found;
  }

  const pending: SearchItem[] = [{ path: ROOT_PATH, key: null, value: root }];

  for (let item = pending.pop(); item !== undefined && found.length < MAX_SEARCH_MATCHES; item = pending.pop()) {
    if (matchesNeedle(item.key, item.value, needle)) {
      found.push(item.path);
    }

    // 逆順に積み、先頭の子から取り出す
    for (const [childKey, child] of childEntries(item.value).reverse()) {
      pending.push({ path: childPath(item.path, childKey), key: childKey, value: child });
    }
  }

  return found;
}

/** 次の一致の番号。検索の直後（NO_CURRENT）は、next なら先頭、prev なら末尾 */
function nextIndex(current: number, step: 1 | -1, length: number): number {
  if (current === NO_CURRENT) {
    return step === 1 ? 0 : length - 1;
  }

  return (current + step + length) % length;
}

/** 検索と強調の管理。ノードの行は rowOf で得る（祖先を開いて描いたうえで返す） */
function createFinder(value: unknown, rowOf: (path: string) => HTMLElement | undefined): Pick<TreeHandle, 'search' | 'next' | 'prev' | 'reveal'> {
  let matches: string[] = [];
  let current = NO_CURRENT;
  let highlighted: HTMLElement | null = null;

  const clearHighlight = (): void => {
    highlighted?.classList.remove('is-current');
    highlighted = null;
  };
  const highlight = (path: string): void => {
    const row = rowOf(path);

    clearHighlight();
    highlighted = row ?? null;
    row?.classList.add('is-current');
    row?.scrollIntoView({ block: 'nearest' });
  };
  const move = (step: 1 | -1): void => {
    if (matches.length === 0) {
      return;
    }

    current = nextIndex(current, step, matches.length);
    highlight(matches[current] ?? ROOT_PATH);
  };

  return {
    search(query) {
      clearHighlight();
      matches = searchPaths(value, query.toLowerCase());
      current = NO_CURRENT;

      return matches.length;
    },
    next() {
      move(1);
    },
    prev() {
      move(-1);
    },
    reveal: highlight,
  };
}

/** ツリーを描く。開いた階層だけ描き、最初は 1 階層目まで開く */
export function renderTree(container: HTMLElement, value: unknown): TreeHandle {
  const state: TreeState = { nodes: new Map() };
  const list = createElement('ul', 'tree');
  const root = createNode(state, ROOT_PATH, ROOT_PATH, value);

  list.setAttribute('role', 'tree');
  list.append(root.li);
  container.replaceChildren(list);
  expand(state, root);

  return {
    expandAll: () => expandAll(state, root),
    collapseAll: () => {
      collapse(state, root);
      expand(state, root);
    },
    ...createFinder(value, (path) => findRow(state, root, path)),
  };
}

/** JSON Lines の行一覧。1 行 ＝ 行番号 ＋ 値の要約。クリックでその行の値をツリーで開く。誤りの行は内容を出す */
export function renderRows(container: HTMLElement, lines: readonly JsonlLine[]): void {
  const list = createElement('ol', 'rows');
  let shown = 0;

  const showMore = (): void => {
    const end = Math.min(lines.length, shown + ROW_CHUNK);

    list.querySelector(':scope > .rows-more')?.remove();

    for (const line of lines.slice(shown, end)) {
      const li = createElement('li', 'rows-item');
      const number = createElement('span', 'rows-line-no', String(line.lineNo));

      if ('error' in line) {
        li.classList.add('is-error');
        li.append(number, createElement('span', 'rows-error', describeLineError(line.lineNo, line.error)));
        list.append(li);
        continue;
      }

      const button = createButton('rows-summary', summarize(line.value));
      const detail = createElement('div', 'rows-detail');
      detail.hidden = true;
      button.addEventListener('click', () => {
        detail.hidden = !detail.hidden;

        if (!detail.hidden && detail.childElementCount === 0) {
          renderTree(detail, line.value);
        }
      });
      li.append(number, button, detail);
      list.append(li);
    }

    shown = end;

    if (shown < lines.length) {
      const item = createElement('li', 'rows-more');
      const more = createButton('rows-more-button', `さらに ${Math.min(lines.length - shown, ROW_CHUNK)} 行`);
      more.addEventListener('click', showMore);
      item.append(more);
      list.append(item);
    }
  };

  showMore();
  container.replaceChildren(list);
}

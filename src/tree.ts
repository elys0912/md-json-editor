// 値をツリーとして描く（開いた階層だけ描く）、検索、パスの写し、JSON Lines の行一覧（詳細設計 3.5、F3-2・F3-5・F5-3）
// キーと値は利用者由来なので textContent でだけ出す（N2-4）
// パスの例：`$.items[2].name`、識別子にならないキーは `$["a b"]`

import { createButton, createElement } from './dom.ts';
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
// 文字列の値の要約の長さ
const MAX_SUMMARY_LENGTH = 200;
const MAX_SEARCH_MATCHES = 1_000;
// JSON Lines の行一覧をこの数ずつ描く（N3-2）
const ROW_CHUNK = 1_000;

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
  // 描いた子の数
  shown: number;
  expanded: boolean;
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

export function childPath(parent: string, key: Key): string {
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

    return name ?? (JSON.parse(quoted ?? '""') as string);
  });
}

/** 値の要約。オブジェクトは `{n}`、配列は `[n]`、文字列は引用符つきで MAX_SUMMARY_LENGTH 文字で切る */
export function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }

  if (isContainer(value)) {
    return `{${Object.keys(value).length}}`;
  }

  if (typeof value === 'string') {
    const cut = value.length > MAX_SUMMARY_LENGTH ? `${value.slice(0, MAX_SUMMARY_LENGTH)}…` : value;

    return `"${cut}"`;
  }

  return String(value);
}

function valueClass(value: unknown): string {
  if (value === null) {
    return 'tree-null';
  }

  return isContainer(value) ? 'tree-container' : `tree-${typeof value}`;
}

function copyPath(path: string): void {
  // クリップボードが使えない環境では何もしない
  void navigator.clipboard.writeText(path).catch(() => undefined);
}

export function renderTree(container: HTMLElement, value: unknown): TreeHandle {
  const nodes = new Map<string, TreeNode>();
  let matches: string[] = [];
  let current = -1;
  let highlighted: HTMLElement | null = null;

  const createNode = (path: string, label: string, nodeValue: unknown): TreeNode => {
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

    const node: TreeNode = { path, value: nodeValue, li, row, toggle, childList, children: [], shown: 0, expanded: false };

    if (toggle !== null) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        if (node.expanded) {
          collapse(node);
        } else {
          expand(node);
        }
      });
    }

    nodes.set(path, node);

    return node;
  };

  const forget = (node: TreeNode): void => {
    for (const child of node.children) {
      forget(child);
      nodes.delete(child.path);
    }

    node.children.length = 0;
    node.shown = 0;
  };

  /** 子を次の CHILD_CHUNK 件だけ描く。残りがあれば「さらに」のボタンを末尾に置く */
  const showMore = (node: TreeNode): void => {
    const entries = childEntries(node.value);
    const end = Math.min(entries.length, node.shown + CHILD_CHUNK);

    node.childList.querySelector(':scope > .tree-more')?.remove();

    for (const [key, child] of entries.slice(node.shown, end)) {
      const childNode = createNode(childPath(node.path, key), String(key), child);

      node.children.push(childNode);
      node.childList.append(childNode.li);
    }

    node.shown = end;

    const rest = entries.length - end;

    if (rest > 0) {
      const item = createElement('li', 'tree-more');
      const more = createButton('tree-more-button', `さらに ${Math.min(rest, CHILD_CHUNK)} 件（残り ${rest} 件）`);
      more.addEventListener('click', () => {
        showMore(node);
      });
      item.append(more);
      node.childList.append(item);
    }
  };

  const expand = (node: TreeNode): void => {
    if (node.toggle === null || node.expanded) {
      return;
    }

    showMore(node);
    node.expanded = true;
    node.childList.hidden = false;
    node.toggle.textContent = '▼';
    node.toggle.setAttribute('aria-expanded', 'true');
  };

  // 閉じたら子の描画を捨てる（描くノードの数を開いた階層だけに保つ）
  const collapse = (node: TreeNode): void => {
    if (node.toggle === null || !node.expanded) {
      return;
    }

    forget(node);
    node.childList.replaceChildren();
    node.expanded = false;
    node.childList.hidden = true;
    node.toggle.textContent = '▶';
    node.toggle.setAttribute('aria-expanded', 'false');
  };

  /** path のノードを描く。祖先を開き、「さらに」の先にあれば描き足す */
  const ensureNode = (path: string): TreeNode | undefined => {
    let node = nodes.get('$');
    let currentPath = '$';

    for (const key of parsePath(path)) {
      if (node === undefined) {
        return undefined;
      }

      const parent = node;
      const index = childEntries(parent.value).findIndex(([entryKey]) => entryKey === key);

      if (index < 0) {
        return undefined;
      }

      expand(parent);

      while (parent.shown <= index) {
        showMore(parent);
      }

      currentPath = childPath(currentPath, key);
      node = nodes.get(currentPath);
    }

    return node;
  };

  const highlight = (path: string): void => {
    const node = ensureNode(path);

    highlighted?.classList.remove('is-current');
    highlighted = node?.row ?? null;
    highlighted?.classList.add('is-current');
    highlighted?.scrollIntoView({ block: 'nearest' });
  };

  const move = (step: 1 | -1): void => {
    if (matches.length === 0) {
      return;
    }

    current = (current + step + matches.length) % matches.length;
    highlight(matches[current] ?? '$');
  };

  const root = createNode('$', '$', value);
  const list = createElement('ul', 'tree');

  list.setAttribute('role', 'tree');
  list.append(root.li);
  container.replaceChildren(list);
  // 最初は 1 階層目まで開く
  expand(root);

  return {
    expandAll() {
      const queue: TreeNode[] = [root];

      for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
        if (nodes.size > MAX_EXPANDED_NODES) {
          return false;
        }

        expand(node);
        queue.push(...node.children);
      }

      return true;
    },
    collapseAll() {
      collapse(root);
      expand(root);
    },
    search(query) {
      const needle = query.toLowerCase();
      const found: string[] = [];
      const matchesText = (text: string): boolean => text.toLowerCase().includes(needle);
      const visit = (path: string, key: Key | null, nodeValue: unknown): void => {
        if (found.length >= MAX_SEARCH_MATCHES) {
          return;
        }

        const isPrimitive = typeof nodeValue === 'string' || typeof nodeValue === 'number' || typeof nodeValue === 'boolean';
        const keyMatches = typeof key === 'string' && matchesText(key);

        if (keyMatches || (isPrimitive && matchesText(String(nodeValue)))) {
          found.push(path);
        }

        for (const [childKey, child] of childEntries(nodeValue)) {
          visit(childPath(path, childKey), childKey, child);
        }
      };

      if (needle !== '') {
        visit('$', null, value);
      }

      matches = found;
      current = -1;

      return found.length;
    },
    next() {
      move(1);
    },
    prev() {
      move(-1);
    },
    reveal(path) {
      highlight(path);
    },
  };
}

function errorText(lineNo: number, error: { column: number; message: string }): string {
  return `${lineNo} 行目 ${error.column} 列：${error.message}`;
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
        li.append(number, createElement('span', 'rows-error', errorText(line.lineNo, line.error)));
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

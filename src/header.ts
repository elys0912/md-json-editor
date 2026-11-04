// ヘッダ：サイドの開閉、文書名（クリックで名前の変更）、種別、表示の切替、操作のメニュー、テーマ（基本 2）
// 文書名は利用者由来なので textContent と value でだけ出す（N2-4）

import { createButton } from './dom.ts';
import type { Kind, Meta, Settings } from './store.ts';

export type Action =
  | 'new-markdown'
  | 'new-json'
  | 'open-file'
  | 'paste'
  | 'download'
  | 'export-html'
  | 'format-2'
  | 'format-4'
  | 'format-tab'
  | 'minify'
  | 'to-lines'
  | 'to-array';

export type ViewName = 'preview' | 'split' | 'edit' | 'tree' | 'text' | 'rows' | 'shape';

const VIEW_LABELS: Readonly<Record<ViewName, string>> = {
  preview: 'プレビュー',
  split: '編集＋プレビュー',
  edit: '編集',
  tree: 'ツリー',
  text: 'テキスト',
  rows: '行一覧',
  shape: '図形',
};

const ACTION_LABELS: readonly [Action, string][] = [
  ['new-markdown', '新規（Markdown）'],
  ['new-json', '新規（JSON）'],
  ['open-file', 'ファイルを開く'],
  ['paste', '貼り付けから開く'],
  ['download', 'ダウンロード'],
  ['export-html', 'HTML で書き出す'],
  ['format-2', '整形（2）'],
  ['format-4', '整形（4）'],
  ['format-tab', '整形（タブ）'],
  ['minify', '圧縮'],
  ['to-lines', 'JSON Lines に変換'],
  ['to-array', '配列に変換'],
];

/** 操作の表示名。空の画面の案内のボタンでも同じ名前を使う */
export function actionLabel(action: Action): string {
  return ACTION_LABELS.find(([candidate]) => candidate === action)?.[1] ?? action;
}

const KINDS: readonly Kind[] = ['markdown', 'json', 'json5', 'jsonl', 'geojson'];
const THEME_LABELS: readonly [Settings['theme'], string][] = [
  ['system', 'OS に合わせる'],
  ['light', 'ライト'],
  ['dark', 'ダーク'],
];

export interface HeaderHandlers {
  readonly toggleSide: () => void;
  readonly rename: (name: string) => void;
  readonly changeView: (view: ViewName) => void;
  readonly changeKind: (kind: Kind) => void;
  readonly changeTheme: (theme: Settings['theme']) => void;
  readonly action: (action: Action) => void;
}

export interface HeaderState {
  readonly meta: Meta | null;
  readonly views: readonly ViewName[];
  readonly view: ViewName | null;
  readonly enabled: ReadonlySet<Action>;
}

export interface Header {
  update(state: HeaderState): void;
  setTheme(theme: Settings['theme']): void;
}

function createSelect<T extends string>(className: string, label: string, options: readonly (readonly [T, string])[], onChange: (value: T) => void): HTMLSelectElement {
  const select = document.createElement('select');

  select.className = className;
  select.setAttribute('aria-label', label);

  for (const [value, text] of options) {
    select.append(new Option(text, value));
  }

  select.addEventListener('change', () => {
    const chosen = options.find(([value]) => value === select.value);

    if (chosen !== undefined) {
      onChange(chosen[0]);
    }
  });

  return select;
}

/** 文書名をその場の入力欄に替える。Enter と入力欄から離れたときに確定、Esc で取り消し */
function startRename(nameButton: HTMLButtonElement, current: string, onRename: (name: string) => void): void {
  const input = document.createElement('input');
  let isDone = false;

  const finish = (shouldCommit: boolean): void => {
    if (isDone) {
      return;
    }

    isDone = true;
    input.replaceWith(nameButton);

    const name = input.value.trim();

    if (shouldCommit && name !== '' && name !== current) {
      onRename(name);
    }
  };

  input.className = 'doc-name-input';
  input.value = current;
  input.setAttribute('aria-label', '文書名');
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      finish(true);
    } else if (event.key === 'Escape') {
      finish(false);
    }
  });
  input.addEventListener('blur', () => {
    finish(true);
  });
  nameButton.replaceWith(input);
  input.focus();
  input.select();
}

/** 操作のメニュー（details）。項目のボタンは種別ごとの有効・無効を切り替えるため Map で返す */
function buildMenu(handlers: HeaderHandlers): { menu: HTMLDetailsElement; kindSelect: HTMLSelectElement; actionButtons: Map<Action, HTMLButtonElement> } {
  const menu = document.createElement('details');
  const summary = document.createElement('summary');
  const menuItems = document.createElement('div');
  const kindLabel = document.createElement('label');
  const kindSelect = createSelect('kind-select', '種別', KINDS.map((kind) => [kind, kind] as const), handlers.changeKind);
  const actionButtons = new Map<Action, HTMLButtonElement>();

  menu.className = 'menu';
  summary.textContent = '操作';
  menuItems.className = 'menu-items';

  for (const [action, label] of ACTION_LABELS) {
    const button = createButton('menu-item', label, () => {
      menu.open = false;
      handlers.action(action);
    });

    button.dataset.action = action;
    actionButtons.set(action, button);
    menuItems.append(button);
  }

  kindLabel.className = 'menu-kind';
  kindLabel.append('種別の変更 ', kindSelect);
  menuItems.append(kindLabel);
  menu.append(summary, menuItems);

  return { menu, kindSelect, actionButtons };
}

export function createHeader(container: HTMLElement, handlers: HeaderHandlers): Header {
  const sideToggle = createButton('side-toggle', '≡', handlers.toggleSide);
  const nameButton = createButton('doc-title', '');
  const kindBadge = document.createElement('span');
  const viewSelect = document.createElement('select');
  const themeSelect = createSelect('theme-select', 'テーマ', THEME_LABELS, handlers.changeTheme);
  const { menu, kindSelect, actionButtons } = buildMenu(handlers);
  let currentName = '';
  let currentViews: readonly ViewName[] = [];

  sideToggle.setAttribute('aria-label', 'サイドの開閉');
  nameButton.title = 'クリックで名前を変更';
  nameButton.addEventListener('click', () => {
    startRename(nameButton, currentName, handlers.rename);
  });
  kindBadge.className = 'doc-kind-badge';
  viewSelect.className = 'view-select';
  viewSelect.setAttribute('aria-label', '表示');
  viewSelect.addEventListener('change', () => {
    const chosen = currentViews.find((view) => view === viewSelect.value);

    if (chosen !== undefined) {
      handlers.changeView(chosen);
    }
  });
  container.replaceChildren(sideToggle, nameButton, kindBadge, viewSelect, menu, themeSelect);

  return {
    update(state) {
      currentName = state.meta?.name ?? '';
      currentViews = state.views;
      nameButton.textContent = currentName;
      nameButton.disabled = state.meta === null;
      kindBadge.textContent = state.meta?.kind ?? '';
      kindSelect.value = state.meta?.kind ?? 'markdown';
      kindSelect.disabled = state.meta === null;
      viewSelect.replaceChildren(...state.views.map((view) => new Option(VIEW_LABELS[view], view)));
      viewSelect.value = state.view ?? '';
      viewSelect.disabled = state.views.length < 2;

      for (const [action, button] of actionButtons) {
        button.disabled = !state.enabled.has(action);
      }
    },
    setTheme(theme) {
      themeSelect.value = theme;
    },
  };
}

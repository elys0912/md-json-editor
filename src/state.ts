// 画面の状態（いま開いている文書、保存の状態、画面の部品）と、種別ごとの決まり、画面に出す文言（詳細設計 3.8、基本 4「画面の状態」）
// 状態は app の 1 つにまとめ、body・documents・actions・main が読み書きする

import type { EditorView } from '@codemirror/view';

import type { Analysis } from './analysis.ts';
import type { Action, Header, ViewName } from './header.ts';
import type { Eol } from './json.ts';
import type { StatusLine } from './status.ts';
import type { Kind, Meta, Settings } from './store.ts';
import type { TreeHandle } from './tree.ts';
import type { PreviewHandle } from './views.ts';

// 狭い画面では編集＋プレビューを出さず、表示切替で片方ずつにする。style.css の @media と同じ境界
export const NARROW_SCREEN_QUERY = '(width < 768px)';

export const VIEWS_BY_KIND: Readonly<Record<Kind, readonly ViewName[]>> = {
  markdown: ['preview', 'split', 'edit'],
  json: ['tree', 'text'],
  json5: ['tree', 'text'],
  jsonl: ['rows', 'tree', 'text'],
  geojson: ['shape', 'tree', 'text'],
};

export const EXTENSION_BY_KIND: Readonly<Record<Kind, string>> = {
  markdown: 'md',
  json: 'json',
  json5: 'json5',
  jsonl: 'jsonl',
  geojson: 'geojson',
};

const REFORMAT_ACTIONS: readonly Action[] = ['format-2', 'format-4', 'format-tab', 'minify'];

// 4 章の文言のうち、画面の配線で出すもの
export const MESSAGES = {
  saved: '保存済み',
  saveFailed: '保存できません（容量）。ダウンロードしてください',
  memoryOnly: 'この環境では保存できません。閉じると内容は消えます',
  unsavedConfirm: '保存できていません。ダウンロードせずに続けますか',
  json5Confirm: 'JSON5 の整形・圧縮ではコメントと数値の書き方が失われます。続けますか',
  updatedElsewhere: '別のタブで更新されました',
  reload: '読み直す',
  reloadConfirm: '読み直すと、まだ保存していない編集が消えます。続けますか',
  deletedElsewhere: '別のタブで削除されました',
  newVersion: '新しい版があります',
  update: '更新',
  versionChanged: '別のタブで新しい版が開かれました。再読込してください',
  pasteFallback: 'Ctrl+V で貼り付けてください',
  partlyExpanded: '一部だけ開きました（描くノードが多すぎるため）',
  emptyGuide: 'ファイルをドロップするか、選ぶか、貼り付けてください',
  openFailed: '文書を開けませんでした',
  deleteFailed: '削除できませんでした',
  shapeGuide: '図形をクリックすると properties を出します',
  deleteConfirm: (name: string) => `「${name}」を削除します`,
  deleteAllConfirm: (count: number) => `すべての文書（${count} 件）を削除します`,
  issueHeading: (count: number) => `誤り・注意 ${count} 件`,
  issueRest: (count: number) => `ほか ${count} 件`,
} as const;

export interface CurrentDoc {
  meta: Meta;
  text: string;
  readonly eol: Eol;
  view: ViewName;
  // 最後に正しく読めた値（F3-3）。文書の切替・種別の変更・読み直しで捨てる
  lastGood: { readonly value: unknown } | null;
  analysis: Analysis;
  // 別のタブで削除された。自動保存を止める
  isDeleted: boolean;
}

export interface Dom {
  readonly app: HTMLElement;
  readonly header: HTMLElement;
  readonly docs: HTMLElement;
  readonly toc: HTMLElement;
  readonly body: HTMLElement;
  readonly properties: HTMLElement;
  readonly errors: HTMLElement;
  readonly status: HTMLElement;
  readonly fileInput: HTMLInputElement;
}

/** 下位のモジュール（body・documents）から上位の操作を呼ぶ口。依存を一方向に保つため、起動時に main.ts が入れる */
export interface AppHandlers {
  readonly runAction: (action: Action) => void;
  readonly openById: (id: string) => void;
  readonly removeDoc: (meta: Meta) => void;
  readonly removeAll: () => void;
  // 間引き中の編集があれば、すぐ解析と表示の更新を行い、保存を始める（表示の切替・整形の前に呼ぶ）
  readonly settlePendingEdit: () => void;
}

export interface AppState {
  readonly dom: Dom;
  readonly header: Header;
  readonly status: StatusLine;
  readonly editor: EditorView;
  readonly handlers: AppHandlers;
  settings: Settings;
  isInMemory: boolean;
  // 別のタブで新しい版が開かれ、DB が閉じられた（以降はメモリで動く）
  isClosedByNewVersion: boolean;
  isPersistent: boolean;
  metas: Meta[];
  current: CurrentDoc | null;
  // 間引き中の自動保存
  timer: ReturnType<typeof setTimeout> | null;
  // 進行中の自動保存。flush はこれを待つ
  pendingSave: Promise<boolean> | null;
  // 最後の保存に失敗した
  hasSaveFailed: boolean;
  tree: TreeHandle | null;
  // 編集＋プレビュー・プレビューの表示のときのプレビュー。編集のたびに中身だけ差し替える
  preview: PreviewHandle | null;
  // 本体を描き直すときに、前の表示のイベント（スクロールの連動など）を外す
  viewEvents: AbortController;
}

export let app: AppState;

export function setApp(next: AppState): void {
  app = next;
}

function isNarrowScreen(): boolean {
  return window.matchMedia(NARROW_SCREEN_QUERY).matches;
}

export function viewsOf(kind: Kind): readonly ViewName[] {
  const views = VIEWS_BY_KIND[kind];

  return isNarrowScreen() ? views.filter((view) => view !== 'split') : views;
}

/** 操作メニューのうち、いまの文書で使えるもの（基本 2 の操作メニューの表） */
export function enabledActions(doc: CurrentDoc | null): Set<Action> {
  const enabled = new Set<Action>(['new-markdown', 'new-json', 'open-file', 'paste']);

  if (doc === null) {
    return enabled;
  }

  const { kind } = doc.meta;
  const isParsed = doc.analysis.isParsed;

  enabled.add('download');

  if (kind === 'markdown') {
    enabled.add('export-html');
  }

  if ((kind === 'json' || kind === 'json5' || kind === 'geojson') && isParsed) {
    REFORMAT_ACTIONS.forEach((action) => enabled.add(action));
  }

  if (kind === 'jsonl') {
    enabled.add('minify');
    enabled.add('to-array');
  }

  if (kind === 'json' && isParsed) {
    enabled.add('to-lines');
  }

  return enabled;
}

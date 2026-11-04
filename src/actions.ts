// 操作メニューとショートカットの操作：新規・開く・貼り付け・ダウンロード・書き出し・整形・圧縮・変換、名前と種別の変更（基本 2）

import { openSearchPanel } from '@codemirror/search';

import { changeView, cycleView, setSaveStatus, updateHeader } from './body.ts';
import { confirmLeave, createDoc, NEW_DOC_BASE_NAME, pasteFromClipboard, settlePendingEdit, showDoc, startSave } from './documents.ts';
import { download, replaceExtension } from './files.ts';
import type { Action } from './header.ts';
import { arrayToLines, format, linesToArray, minify } from './json.ts';
import type { Indent } from './json.ts';
import { exportHtml } from './markdown.ts';
import { app, EXTENSION_BY_KIND, MESSAGES } from './state.ts';
import type { CurrentDoc } from './state.ts';
import { saveDoc } from './store.ts';
import type { Kind } from './store.ts';

const INDENT_BY_ACTION: Partial<Record<Action, Indent>> = { 'format-2': 2, 'format-4': 4, 'format-tab': '\t' };
const MIME_BY_KIND: Readonly<Record<Kind, string>> = {
  markdown: 'text/markdown',
  json: 'application/json',
  json5: 'application/json5',
  jsonl: 'application/jsonl',
  geojson: 'application/geo+json',
};
const HTML_EXTENSION = 'html';
const HTML_MIME = 'text/html';

// 新規の文書の中身と、開く表示（新規は直すために作るので、編集の表示で開く）
const NEW_DOCS = {
  'new-markdown': { kind: 'markdown', text: '', view: 'edit' },
  'new-json': { kind: 'json', text: '{}', view: 'text' },
} as const;

/** 整形・圧縮の結果を、取り消しで戻せるようにエディタへの変更として入れる（基本 6-9） */
function replaceEditorText(text: string): void {
  app.editor.dispatch({ changes: { from: 0, to: app.editor.state.doc.length, insert: text } });
}

function reformat(doc: CurrentDoc, action: Action): void {
  const { kind } = doc.meta;

  // 間引き中の編集を先に解析し、壊れた本文を整形しない（解析に成功しているときだけ行う）
  settlePendingEdit();

  if (kind === 'markdown' || !doc.analysis.isParsed) {
    return;
  }

  // 取り消しで戻せるよう、テキスト表示に切り替えてから行う
  changeView('text');

  if (kind === 'json5' && !window.confirm(MESSAGES.json5Confirm)) {
    return;
  }

  const indent = INDENT_BY_ACTION[action];

  replaceEditorText(indent === undefined || kind === 'jsonl' ? minify(kind, doc.text, doc.eol) : format(kind, doc.text, indent, doc.eol));
}

async function convert(doc: CurrentDoc, toKind: 'json' | 'jsonl'): Promise<void> {
  let text: string;

  settlePendingEdit();

  try {
    text = toKind === 'jsonl' ? arrayToLines(doc.text, doc.eol) : linesToArray(doc.text, doc.eol);
  } catch (error) {
    app.status.notify(error instanceof Error ? error.message : String(error));

    return;
  }

  if (await confirmLeave()) {
    await createDoc(replaceExtension(doc.meta.name, EXTENSION_BY_KIND[toKind]), text, toKind);
  }
}

async function createNewDoc(action: keyof typeof NEW_DOCS): Promise<void> {
  if (!(await confirmLeave())) {
    return;
  }

  const { kind, text, view } = NEW_DOCS[action];

  await createDoc(`${NEW_DOC_BASE_NAME}.${EXTENSION_BY_KIND[kind]}`, text, kind, view);
}

/** いまの文書に対する操作 */
async function runDocAction(doc: CurrentDoc, action: Action): Promise<void> {
  const { name, kind } = doc.meta;

  switch (action) {
    case 'download':
      download(replaceExtension(name, EXTENSION_BY_KIND[kind]), doc.text, MIME_BY_KIND[kind]);
      break;
    case 'export-html':
      download(replaceExtension(name, HTML_EXTENSION), exportHtml(name, doc.text), HTML_MIME);
      break;
    case 'to-lines':
      await convert(doc, 'jsonl');
      break;
    case 'to-array':
      await convert(doc, 'json');
      break;
    default:
      reformat(doc, action);
  }
}

export async function runAction(action: Action): Promise<void> {
  switch (action) {
    case 'new-markdown':
    case 'new-json':
      await createNewDoc(action);

      return;
    case 'open-file':
      app.dom.fileInput.click();

      return;
    case 'paste':
      await pasteFromClipboard();

      return;
  }

  if (app.current !== null) {
    await runDocAction(app.current, action);
  }
}

export async function rename(name: string): Promise<void> {
  const doc = app.current;

  if (doc === null) {
    return;
  }

  doc.meta = { ...doc.meta, name };
  updateHeader();
  await startSave();
}

/** 種別の変更：meta を保存し、表示を種別の既定に戻し、lastGood を捨てて解析し直す。取り消しの履歴は消える。名前は変えない */
export async function changeKind(kind: Kind): Promise<void> {
  const doc = app.current;

  if (doc === null || doc.meta.kind === kind) {
    return;
  }

  if (!(await confirmLeave())) {
    updateHeader();

    return;
  }

  const meta = await saveDoc({ ...doc.meta, kind }, doc.text).catch(() => null);

  showDoc(meta ?? { ...doc.meta, kind }, doc.text);
  app.hasSaveFailed = meta === null;
  setSaveStatus();
}

/** Ctrl+F の宛先（基本 2）。プレビュー・図形はブラウザの検索に任せる */
function handleFind(event: KeyboardEvent): void {
  const doc = app.current;

  if (doc === null) {
    return;
  }

  if (doc.view === 'rows') {
    changeView('tree');
  }

  if (doc.view === 'tree') {
    event.preventDefault();
    app.dom.body.querySelector<HTMLInputElement>('.tree-search')?.focus();
  } else if (doc.view === 'text' || doc.view === 'edit' || doc.view === 'split') {
    event.preventDefault();
    openSearchPanel(app.editor);
  }
}

export function handleShortcut(event: KeyboardEvent): void {
  // エディタが自分で処理したキー（検索・取り消しなど）は扱わない
  if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) {
    return;
  }

  switch (event.key.toLowerCase()) {
    case 's':
      event.preventDefault();
      void runAction('download');
      break;
    case 'o':
      event.preventDefault();
      app.dom.fileInput.click();
      break;
    case 'e':
      event.preventDefault();
      cycleView();
      break;
    case 'f':
      handleFind(event);
      break;
  }
}

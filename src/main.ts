// 起動、画面の組み立て、操作と各モジュールの配線、状態の保持（詳細設計 3.8、基本 2・6）
// 編集の流れ：エディタの変更 → 間引き → analyze（解析と表示の更新）→ saveCurrent（自動保存）
// テストは startApp を呼んで画面を組み立てる。PWA の登録はテスト以外のときだけ行う

import './style.css';
import './export.css';

import type { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';

import { analyze, EMPTY_ANALYSIS } from './analysis.ts';
import type { Analysis, Issue } from './analysis.ts';
import { detectKind } from './detect.ts';
import { createButton, createElement } from './dom.ts';
import { describeFailures, download, findSameDoc, readFile, replaceExtension, uniqueName } from './files.ts';
import type { ReadFailure } from './files.ts';
import { createEditor, goTo, setDocument } from './editor.ts';
import { createHeader } from './header.ts';
import type { Action, Header, ViewName } from './header.ts';
import { arrayToLines, format, linesToArray, minify } from './json.ts';
import type { Eol, Indent } from './json.ts';
import { exportHtml, renderMarkdown } from './markdown.ts';
import type { TocEntry } from './markdown.ts';
import { renderDocList, renderToc } from './side.ts';
import { createStatusLine } from './status.ts';
import type { StatusLine } from './status.ts';
import { deleteAll, deleteDoc, getText, listMeta, loadSettings, openStore, saveDoc, saveSettings } from './store.ts';
import type { Kind, Meta, Settings, StoredDoc } from './store.ts';
import { renderRows } from './tree.ts';
import type { TreeHandle } from './tree.ts';
import { attachScrollSync, createPreview, renderShapeView, renderTreeView, showProperties } from './views.ts';

// 入力が止まってから解析と自動保存をするまで（N3-3）。大きな本文では長くする
const DEBOUNCE_MS = 300;
const LARGE_TEXT_DEBOUNCE_MS = 1_000;
const LARGE_TEXT_LENGTH = 1_000_000;
// 誤りパネルに並べる上限。超えた分は「ほか N 件」
const MAX_LISTED_ISSUES = 100;
// 狭い画面では編集＋プレビューを出さず、表示切替で片方ずつにする
const NARROW_SCREEN_QUERY = '(max-width: 767px)';

const VIEWS_BY_KIND: Readonly<Record<Kind, readonly ViewName[]>> = {
  markdown: ['preview', 'split', 'edit'],
  json: ['tree', 'text'],
  json5: ['tree', 'text'],
  jsonl: ['rows', 'tree', 'text'],
  geojson: ['shape', 'tree', 'text'],
};
const EXTENSION_BY_KIND: Readonly<Record<Kind, string>> = { markdown: 'md', json: 'json', json5: 'json5', jsonl: 'jsonl', geojson: 'geojson' };
const MIME_BY_KIND: Readonly<Record<Kind, string>> = {
  markdown: 'text/markdown',
  json: 'application/json',
  json5: 'application/json5',
  jsonl: 'application/jsonl',
  geojson: 'application/geo+json',
};
const INDENT_BY_ACTION: Partial<Record<Action, Indent>> = { 'format-2': 2, 'format-4': 4, 'format-tab': '\t' };
const REFORMAT_ACTIONS: readonly Action[] = ['format-2', 'format-4', 'format-tab', 'minify'];
const NEW_DOC_BASE_NAME = '無題';

// 4 章の文言のうち、ここで出すもの
const MESSAGES = {
  saved: '保存済み',
  saveFailed: '保存できません（容量）。ダウンロードしてください',
  memoryOnly: 'この環境では保存できません。閉じると内容は消えます',
  unsavedConfirm: '保存できていません。ダウンロードせずに続けますか',
  json5Confirm: 'JSON5 の整形・圧縮ではコメントと数値の書き方が失われます。続けますか',
  updatedElsewhere: '別のタブで更新されました',
  reloadConfirm: '読み直すと、まだ保存していない編集が消えます。続けますか',
  deletedElsewhere: '別のタブで削除されました',
  newVersion: '新しい版があります',
  versionChanged: '別のタブで新しい版が開かれました。再読込してください',
  pasteFallback: 'Ctrl+V で貼り付けてください',
  partlyExpanded: '一部だけ開きました（描くノードが多すぎるため）',
  emptyGuide: 'ファイルをドロップするか、選ぶか、貼り付けてください',
} as const;

interface CurrentDoc {
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

interface Dom {
  readonly app: HTMLElement;
  readonly docs: HTMLElement;
  readonly toc: HTMLElement;
  readonly body: HTMLElement;
  readonly properties: HTMLElement;
  readonly errors: HTMLElement;
  readonly fileInput: HTMLInputElement;
}

interface AppState {
  readonly dom: Dom;
  readonly header: Header;
  readonly status: StatusLine;
  readonly editor: EditorView;
  settings: Settings;
  isInMemory: boolean;
  isPersistent: boolean;
  metas: Meta[];
  current: CurrentDoc | null;
  // 間引き中の自動保存
  timer: ReturnType<typeof setTimeout> | null;
  // 最後の保存に失敗した
  hasSaveFailed: boolean;
  tree: TreeHandle | null;
}

let app: AppState;
// 起動し直したときに前の起動のイベントを外すため
let running: AbortController | null = null;

// ---- 解析 ----

/** 本文を解析し、読めたら lastGood を替える */
function runAnalysis(doc: CurrentDoc): void {
  const { analysis, value } = analyze(doc.meta.kind, doc.text);

  doc.analysis = analysis;

  if (analysis.isParsed && doc.meta.kind !== 'markdown' && doc.meta.kind !== 'jsonl') {
    doc.lastGood = { value };
  }
}

// ---- 表示 ----

function isNarrowScreen(): boolean {
  return window.matchMedia(NARROW_SCREEN_QUERY).matches;
}

function viewsOf(kind: Kind): readonly ViewName[] {
  const views = VIEWS_BY_KIND[kind];

  return isNarrowScreen() ? views.filter((view) => view !== 'split') : views;
}

function enabledActions(doc: CurrentDoc | null): Set<Action> {
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

function updateHeader(): void {
  const doc = app.current;

  app.header.update({
    meta: doc?.meta ?? null,
    views: doc === null ? [] : viewsOf(doc.meta.kind),
    view: doc?.view ?? null,
    enabled: enabledActions(doc),
  });
}

function renderIssues(): void {
  const issues = app.current?.analysis.issues ?? [];
  const panel = app.dom.errors;

  panel.hidden = issues.length === 0;

  if (issues.length === 0) {
    panel.replaceChildren();

    return;
  }

  const list = createElement('ul', 'issue-list');

  for (const issue of issues.slice(0, MAX_LISTED_ISSUES)) {
    const item = createElement('li', `issue is-${issue.level}`);

    item.append(createButton('issue-link', issue.label, () => {
      openIssue(issue);
    }));
    list.append(item);
  }

  const rest = issues.length - MAX_LISTED_ISSUES;

  panel.replaceChildren(createElement('h2', 'issue-heading', `誤り・注意 ${issues.length} 件`), list);

  if (rest > 0) {
    panel.append(createElement('p', 'issue-rest', `ほか ${rest} 件`));
  }
}

/** 誤りの項目を開く。構文の誤りはテキスト表示の位置へ、GeoJSON の構造の誤りはツリーのノードへ */
function openIssue(issue: Issue): void {
  if ('path' in issue.target) {
    const { path } = issue.target;

    changeView('tree');
    app.tree?.reveal(path);

    return;
  }

  changeView(app.current?.meta.kind === 'markdown' ? 'edit' : 'text');
  goTo(app.editor, issue.target.line, issue.target.column);
}

function selectToc(entry: TocEntry): void {
  const doc = app.current;
  const nonce = doc?.analysis.rendered?.nonce;

  app.dom.body.querySelector(`[data-toc="${nonce ?? ''}:${entry.index}"]`)?.scrollIntoView({ block: 'start' });

  if (doc?.view === 'split') {
    goTo(app.editor, entry.line, 1);
  }
}

function updateDerived(): void {
  const doc = app.current;
  const hasPreview = doc?.view === 'preview' || doc?.view === 'split';

  renderToc(app.dom.toc, hasPreview ? (doc.analysis.rendered?.toc ?? null) : null, selectToc);
  renderIssues();
  app.status.setCounts(doc?.text ?? null);
  app.status.setErrors(doc?.analysis.errorSummary ?? '');
  updateHeader();
}

/** ツリーに出す値。JSON Lines は誤りのない行の値の配列、ほかは最後に正しく読めた値（まだ無ければ undefined） */
function treeValueOf(doc: CurrentDoc): unknown {
  if (doc.meta.kind !== 'jsonl') {
    return doc.lastGood?.value;
  }

  return doc.analysis.lines?.flatMap((line) => ('value' in line ? [line.value] : []));
}

function brokenLineCount(doc: CurrentDoc): number {
  return doc.analysis.lines?.filter((line) => 'error' in line).length ?? 0;
}

function renderEmpty(): void {
  const guide = createElement('div', 'empty');

  guide.append(
    createElement('p', 'guide', MESSAGES.emptyGuide),
    createButton('empty-open', 'ファイルを開く', () => {
      app.dom.fileInput.click();
    }),
    createButton('empty-new-markdown', '新規（Markdown）', () => void runAction('new-markdown')),
    createButton('empty-new-json', '新規（JSON）', () => void runAction('new-json')),
  );
  app.dom.body.replaceChildren(guide);
}

/** 本体を作り直す。エディタは 1 つを使い回し、テキストを含む表示のときだけ本体に付ける */
function renderBody(): void {
  const doc = app.current;

  app.tree = null;
  app.dom.properties.hidden = true;
  app.dom.properties.replaceChildren();

  if (doc === null) {
    renderEmpty();
    updateDerived();

    return;
  }

  const body = app.dom.body;

  body.dataset.view = doc.view;

  switch (doc.view) {
    case 'preview':
      body.replaceChildren(createPreview(doc.analysis.rendered ?? renderMarkdown(doc.text)));
      break;
    case 'split': {
      const rendered = doc.analysis.rendered ?? renderMarkdown(doc.text);
      const preview = createPreview(rendered);

      body.replaceChildren(app.editor.dom, preview);
      attachScrollSync(preview, rendered.nonce, app.editor);
      break;
    }
    case 'edit':
    case 'text':
      body.replaceChildren(app.editor.dom);
      break;
    case 'tree': {
      const tree = renderTreeView(treeValueOf(doc), brokenLineCount(doc), () => {
        app.status.notify(MESSAGES.partlyExpanded);
      });

      app.tree = tree.handle;
      body.replaceChildren(tree.element);
      break;
    }
    case 'rows': {
      const container = createElement('div', 'rows-view');

      renderRows(container, doc.analysis.lines ?? []);
      body.replaceChildren(container);
      break;
    }
    case 'shape':
      body.replaceChildren(
        renderShapeView(doc.lastGood, doc.analysis.errorFeatures, (properties, path) => {
          showProperties(app.dom.properties, properties, path);
        }),
      );
      app.dom.properties.hidden = false;
      app.dom.properties.append(createElement('p', 'guide', '図形をクリックすると properties を出します'));
      break;
  }

  updateDerived();
}

function changeView(view: ViewName): void {
  const doc = app.current;

  if (doc === null || doc.view === view) {
    return;
  }

  doc.view = view;
  renderBody();
}

// ---- 保存 ----

function setSaveStatus(): void {
  if (app.isInMemory) {
    app.status.setSave(MESSAGES.memoryOnly);
  } else {
    app.status.setSave(app.hasSaveFailed ? MESSAGES.saveFailed : MESSAGES.saved);
  }
}

async function refreshList(): Promise<void> {
  app.metas = await listMeta();
  renderDocList(app.dom.docs, app.metas, app.current?.meta.id ?? null, {
    persistent: app.isPersistent || app.isInMemory,
    handlers: { open: (id) => void openById(id), remove: (meta) => void removeDoc(meta), removeAll: () => void removeAll() },
  });
}

async function saveCurrent(): Promise<boolean> {
  const doc = app.current;

  if (doc === null || doc.isDeleted) {
    return false;
  }

  try {
    doc.meta = await saveDoc(doc.meta, doc.text);
    app.hasSaveFailed = false;
  } catch {
    app.hasSaveFailed = true;
  }

  setSaveStatus();
  await refreshList();

  return !app.hasSaveFailed;
}

function commitEdit(): Promise<boolean> {
  const doc = app.current;

  app.timer = null;

  if (doc === null) {
    return Promise.resolve(true);
  }

  runAnalysis(doc);
  updateDerived();

  if (doc.view === 'split') {
    const rendered = doc.analysis.rendered ?? renderMarkdown(doc.text);
    const preview = createPreview(rendered);
    const old = app.dom.body.querySelector('.preview');

    if (old !== null) {
      preview.scrollTop = old.scrollTop;
      old.replaceWith(preview);
      attachScrollSync(preview, rendered.nonce, app.editor);
    }
  }

  return saveCurrent();
}

function onEditorChange(text: string): void {
  if (app.current === null) {
    return;
  }

  app.current.text = text;

  if (app.timer !== null) {
    clearTimeout(app.timer);
  }

  app.timer = setTimeout(() => void commitEdit(), text.length > LARGE_TEXT_LENGTH ? LARGE_TEXT_DEBOUNCE_MS : DEBOUNCE_MS);
}

/** 保留中の自動保存をすぐ行い、成否を返す。別のタブで削除された文書は保存せずに失敗を返す */
async function flush(): Promise<boolean> {
  if (app.current === null) {
    return true;
  }

  if (app.current.isDeleted) {
    return false;
  }

  if (app.timer !== null) {
    clearTimeout(app.timer);

    return commitEdit();
  }

  return app.hasSaveFailed ? saveCurrent() : true;
}

/**
 * 文書から離れる前の確認（基本 6-5）。flush が失敗したとき、メモリだけで動いているときの［更新］の前に確認を出す。
 * メモリだけのときの切替は内容が残るので確認しない
 */
async function confirmLeave(isForUpdate = false): Promise<boolean> {
  const isFlushed = await flush();

  if (isFlushed && !(isForUpdate && app.isInMemory)) {
    return true;
  }

  return window.confirm(MESSAGES.unsavedConfirm);
}

// ---- 文書を開く・作る ----

function detectEol(text: string): Eol {
  return /\r?\n/.exec(text)?.[0] === '\r\n' ? '\r\n' : '\n';
}

function showDoc(meta: Meta, text: string, view?: ViewName): void {
  const doc: CurrentDoc = {
    meta,
    text,
    eol: detectEol(text),
    view: view ?? VIEWS_BY_KIND[meta.kind][0] ?? 'text',
    lastGood: null,
    analysis: EMPTY_ANALYSIS,
    isDeleted: false,
  };

  app.current = doc;
  app.hasSaveFailed = false;
  runAnalysis(doc);
  setDocument(app.editor, text, meta.kind, doc.eol);
  app.settings = { ...app.settings, lastDocId: meta.id };
  saveSettings(app.settings);
  renderBody();
  void refreshList();
}

async function openById(id: string): Promise<void> {
  if (app.current?.meta.id === id || !(await confirmLeave())) {
    return;
  }

  const meta = app.metas.find((candidate) => candidate.id === id);
  const text = await getText(id);

  if (meta !== undefined && text !== undefined) {
    showDoc(meta, text);
  }
}

/** 新しい文書を保存して開く。保存に失敗しても開いて編集を続けられるようにする（N4-2） */
async function createDoc(name: string, text: string, kind: Kind, view?: ViewName): Promise<void> {
  const header = { id: crypto.randomUUID(), name: uniqueName(name, new Set(app.metas.map((meta) => meta.name))), kind };
  let meta: Meta = { ...header, size: 0, updatedAt: Date.now() };
  let isSaved = true;

  try {
    meta = await saveDoc(header, text);
  } catch {
    isSaved = false;
  }

  showDoc(meta, text, view);
  app.hasSaveFailed = !isSaved;
  setSaveStatus();
}

async function openText(text: string): Promise<void> {
  const { kind, note } = detectKind(null, text);

  await createDoc(`${NEW_DOC_BASE_NAME}.${EXTENSION_BY_KIND[kind]}`, text, kind);

  if (note !== undefined) {
    app.status.notify(note);
  }
}

/** 複数のファイルを順に開き、最後に開けた文書を出す。開けなかったものは状態行にまとめて出す */
async function openFiles(files: readonly File[]): Promise<void> {
  if (files.length === 0 || !(await confirmLeave())) {
    return;
  }

  const failures: ReadFailure[] = [];
  let note: string | undefined;

  for (const file of files) {
    const result = await readFile(file);

    if (!result.ok) {
      failures.push({ name: file.name, reason: result.reason });
      continue;
    }

    const same = await findSameDoc(app.metas, file.name, result.text);

    if (same !== undefined) {
      showDoc(same, result.text);
      continue;
    }

    const detected = detectKind(file.name, result.text);

    note = detected.note;
    await createDoc(file.name, result.text, detected.kind);
    app.metas = await listMeta();
  }

  if (failures.length > 0) {
    app.status.notify(describeFailures(failures, files.length === 1));
  } else if (note !== undefined) {
    app.status.notify(note);
  }
}

async function pasteFromClipboard(): Promise<void> {
  let text: string;

  try {
    text = await navigator.clipboard.readText();
  } catch {
    app.status.notify(MESSAGES.pasteFallback);

    return;
  }

  if (text !== '' && (await confirmLeave())) {
    await openText(text);
  }
}

// ---- 操作 ----

/** 整形・圧縮の結果を、取り消しで戻せるようにエディタへの変更として入れる（基本 6-9） */
function replaceEditorText(text: string): void {
  app.editor.dispatch({ changes: { from: 0, to: app.editor.state.doc.length, insert: text } });
}

function reformat(doc: CurrentDoc, action: Action): void {
  const { kind } = doc.meta;

  if (kind === 'markdown') {
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

async function runAction(action: Action): Promise<void> {
  const doc = app.current;

  switch (action) {
    case 'new-markdown':
    case 'new-json':
      if (await confirmLeave()) {
        const isMarkdown = action === 'new-markdown';

        await createDoc(`${NEW_DOC_BASE_NAME}.${isMarkdown ? 'md' : 'json'}`, isMarkdown ? '' : '{}', isMarkdown ? 'markdown' : 'json', isMarkdown ? 'edit' : 'text');
      }

      return;
    case 'open-file':
      app.dom.fileInput.click();

      return;
    case 'paste':
      await pasteFromClipboard();

      return;
  }

  if (doc === null) {
    return;
  }

  switch (action) {
    case 'download':
      download(replaceExtension(doc.meta.name, EXTENSION_BY_KIND[doc.meta.kind]), doc.text, MIME_BY_KIND[doc.meta.kind]);
      break;
    case 'export-html':
      download(replaceExtension(doc.meta.name, 'html'), exportHtml(doc.meta.name, doc.text), 'text/html');
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

async function rename(name: string): Promise<void> {
  const doc = app.current;

  if (doc === null) {
    return;
  }

  doc.meta = { ...doc.meta, name };
  await saveCurrent();
  updateHeader();
}

/** 種別の変更：meta を保存し、表示を種別の既定に戻し、lastGood を捨てて解析し直す。取り消しの履歴は消える。名前は変えない */
async function changeKind(kind: Kind): Promise<void> {
  const doc = app.current;

  if (doc === null || doc.meta.kind === kind) {
    return;
  }

  if (!(await confirmLeave())) {
    updateHeader();

    return;
  }

  showDoc({ ...doc.meta, kind }, doc.text);
  await saveCurrent();
}

async function removeDoc(meta: Meta): Promise<void> {
  if (!window.confirm(`「${meta.name}」を削除します`)) {
    return;
  }

  await deleteDoc(meta.id);

  if (app.current?.meta.id === meta.id) {
    await openFirstOrEmpty();
  } else {
    await refreshList();
  }
}

async function removeAll(): Promise<void> {
  if (!window.confirm(`すべての文書（${app.metas.length} 件）を削除します`)) {
    return;
  }

  await deleteAll();
  await openFirstOrEmpty();
}

async function openFirstOrEmpty(): Promise<void> {
  if (app.timer !== null) {
    clearTimeout(app.timer);
    app.timer = null;
  }

  app.current = null;
  app.metas = await listMeta();

  const first = app.metas[0];
  const text = first === undefined ? undefined : await getText(first.id);

  if (first !== undefined && text !== undefined) {
    showDoc(first, text);

    return;
  }

  renderBody();
  await refreshList();
}

function cycleView(): void {
  const doc = app.current;

  if (doc === null) {
    return;
  }

  const views = viewsOf(doc.meta.kind);

  changeView(views[(views.indexOf(doc.view) + 1) % views.length] ?? doc.view);
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

function handleShortcut(event: KeyboardEvent): void {
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

// ---- 別のタブ・版の更新 ----

async function reloadCurrent(): Promise<void> {
  const doc = app.current;
  const hasPendingEdits = app.timer !== null || app.hasSaveFailed;

  if (doc === null || (hasPendingEdits && !window.confirm(MESSAGES.reloadConfirm))) {
    return;
  }

  if (app.timer !== null) {
    clearTimeout(app.timer);
    app.timer = null;
  }

  app.metas = await listMeta();

  const meta = app.metas.find((candidate) => candidate.id === doc.meta.id);
  const text = await getText(doc.meta.id);

  if (meta !== undefined && text !== undefined) {
    showDoc(meta, text);
  }

  app.status.notify('');
}

const storeEvents = {
  onSaved(id: string): void {
    if (app.current?.meta.id === id) {
      app.status.notify(MESSAGES.updatedElsewhere, { label: '読み直す', run: () => void reloadCurrent() });
    }

    void refreshList();
  },
  onDeleted(id: string | null): void {
    const doc = app.current;

    if (doc !== null && (id === null || id === doc.meta.id)) {
      doc.isDeleted = true;

      if (app.timer !== null) {
        clearTimeout(app.timer);
        app.timer = null;
      }

      app.status.notify(MESSAGES.deletedElsewhere);
    }

    void refreshList();
  },
  async beforeClose(): Promise<StoredDoc | null> {
    await flush();
    app.isInMemory = true;
    setSaveStatus();
    app.status.notify(MESSAGES.versionChanged);

    return app.current === null ? null : { meta: app.current.meta, text: app.current.text };
  },
};

/** 新しい版があるときの［更新］。flush と確認のあとに読み直す（N1-3） */
function offerUpdate(update: () => Promise<void>): void {
  app.status.notify(MESSAGES.newVersion, {
    label: '更新',
    run: () => {
      void confirmLeave(true).then((isConfirmed) => (isConfirmed ? update() : undefined));
    },
  });
}

// ---- 起動 ----

function applyTheme(theme: Settings['theme']): void {
  document.documentElement.dataset.theme = theme;
}

function buildDom(root: HTMLElement): Dom & { header: HTMLElement; status: HTMLElement } {
  const appElement = createElement('div', 'app');
  const header = createElement('header', 'header');
  const side = createElement('aside', 'side');
  const docs = createElement('section', 'docs');
  const toc = createElement('nav', 'toc');
  const main = createElement('main', 'main');
  const body = createElement('div', 'body');
  const properties = createElement('aside', 'properties');
  const errors = createElement('section', 'errors');
  const status = createElement('footer', 'status');
  const fileInput = createElement('input', 'file-input');

  toc.setAttribute('aria-label', '目次');
  errors.setAttribute('aria-label', '誤り・注意');
  properties.setAttribute('aria-label', 'properties');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  side.append(docs, toc);
  main.append(body, properties, errors);
  appElement.append(header, side, main, status, fileInput);
  root.replaceChildren(appElement);

  return { app: appElement, header, docs, toc, body, properties, errors, status, fileInput };
}

function isInsideEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-editor, input, textarea, [contenteditable="true"]') !== null;
}

function attachWindowEvents(signal: AbortSignal): void {
  window.addEventListener('keydown', handleShortcut, { signal });
  window.addEventListener(
    'paste',
    (event) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';

      // エディタの中の貼り付けはエディタに任せる
      if (isInsideEditable(event.target) || text === '') {
        return;
      }

      event.preventDefault();
      void confirmLeave().then((isConfirmed) => (isConfirmed ? openText(text) : undefined));
    },
    { signal },
  );
  // 画面全体がドロップ先
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
  }, { signal });
  window.addEventListener(
    'drop',
    (event) => {
      event.preventDefault();
      void openFiles([...(event.dataTransfer?.files ?? [])]);
    },
    { signal },
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') {
        void flush();
      }
    },
    { signal },
  );
  // pagehide では確認できないので flush だけ
  window.addEventListener('pagehide', () => void flush(), { signal });
}

/** 画面を組み立てて起動する。起動し直すときも呼ぶ（前の起動のイベントは外す） */
export async function startApp(root: HTMLElement): Promise<{ offerUpdate: typeof offerUpdate }> {
  running?.abort();
  running = new AbortController();

  const settings = loadSettings();
  const dom = buildDom(root);
  const editor = createEditor(createElement('div', 'editor-holder'), onEditorChange);
  const header = createHeader(dom.header, {
    toggleSide() {
      app.settings = { ...app.settings, sideOpen: !app.settings.sideOpen };
      app.dom.app.classList.toggle('side-closed', !app.settings.sideOpen);
      saveSettings(app.settings);
    },
    rename: (name) => void rename(name),
    changeView,
    changeKind: (kind) => void changeKind(kind),
    changeTheme(theme) {
      app.settings = { ...app.settings, theme };
      applyTheme(theme);
      saveSettings(app.settings);
    },
    action: (action) => void runAction(action),
  });

  app = {
    dom,
    header,
    status: createStatusLine(dom.status),
    editor,
    settings,
    isInMemory: false,
    isPersistent: false,
    metas: [],
    current: null,
    timer: null,
    hasSaveFailed: false,
    tree: null,
  };
  applyTheme(settings.theme);
  header.setTheme(settings.theme);
  dom.app.classList.toggle('side-closed', !settings.sideOpen);
  dom.fileInput.addEventListener('change', () => {
    const files = [...(dom.fileInput.files ?? [])];

    dom.fileInput.value = '';
    void openFiles(files);
  });
  attachWindowEvents(running.signal);

  const opened = await openStore(storeEvents);

  app.isInMemory = opened.inMemory;
  app.isPersistent = opened.persistent;

  if (app.isInMemory) {
    setSaveStatus();
  }

  app.metas = await listMeta();

  const first = app.metas.find((meta) => meta.id === settings.lastDocId) ?? app.metas[0];
  const text = first === undefined ? undefined : await getText(first.id);

  if (first !== undefined && text !== undefined) {
    showDoc(first, text);
  } else {
    renderBody();
    await refreshList();
  }

  return { offerUpdate };
}

if (import.meta.env.MODE !== 'test') {
  const root = document.querySelector<HTMLElement>('#app');

  if (root !== null) {
    void startApp(root).then(async ({ offerUpdate: onNeedRefresh }) => {
      const { registerPwa } = await import('./pwa.ts');

      registerPwa(onNeedRefresh);
    });
  }
}

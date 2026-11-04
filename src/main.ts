// 起動：画面の組み立て、状態の用意、画面全体のイベント（キー・貼り付け・ドロップ・離れるとき）と別タブの通知の配線（詳細設計 3.8）
// 表示は body.ts、保存と文書の出し入れは documents.ts、操作は actions.ts にある
// テストは startApp を呼んで画面を組み立てる。PWA の登録はテスト以外のときだけ行う

import './style.css';
import './export.css';

import { changeKind, handleShortcut, rename, runAction } from './actions.ts';
import { changeView, refreshList, renderBody, setSaveStatus, updateHeader } from './body.ts';
import { createElement } from './dom.ts';
import {
  confirmLeave,
  flush,
  markDeleted,
  onEditorChange,
  openById,
  openFiles,
  openText,
  reloadCurrent,
  removeAll,
  removeDoc,
  settlePendingEdit,
  showDoc,
} from './documents.ts';
import { createEditor } from './editor.ts';
import { createHeader } from './header.ts';
import type { Header } from './header.ts';
import { app, MESSAGES, NARROW_SCREEN_QUERY, setApp } from './state.ts';
import type { AppState, Dom } from './state.ts';
import { createStatusLine } from './status.ts';
import { getText, listMeta, loadSettings, openStore, saveSettings } from './store.ts';
import type { Settings, StoredDoc, StoreEvents } from './store.ts';

// 起動し直したときに前の起動のイベントとエディタを片付けるため
let running: { readonly events: AbortController; readonly state: AppState } | null = null;

function buildDom(root: HTMLElement): Dom {
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

function applyTheme(theme: Settings['theme']): void {
  document.documentElement.dataset.theme = theme;
}

function updateSettings(change: Partial<Settings>): void {
  app.settings = { ...app.settings, ...change };
  saveSettings(app.settings);
}

function buildHeader(dom: Dom): Header {
  return createHeader(dom.header, {
    toggleSide() {
      updateSettings({ sideOpen: !app.settings.sideOpen });
      app.dom.app.classList.toggle('side-closed', !app.settings.sideOpen);
    },
    rename: (name) => void rename(name),
    changeView,
    changeKind: (kind) => void changeKind(kind),
    changeTheme(theme) {
      updateSettings({ theme });
      applyTheme(theme);
    },
    action: (action) => void runAction(action),
  });
}

function createAppState(root: HTMLElement, settings: Settings): AppState {
  const dom = buildDom(root);

  return {
    dom,
    header: buildHeader(dom),
    status: createStatusLine(dom.status),
    editor: createEditor(createElement('div', 'editor-holder'), onEditorChange),
    handlers: {
      runAction: (action) => void runAction(action),
      openById: (id) => void openById(id),
      removeDoc: (meta) => void removeDoc(meta),
      removeAll: () => void removeAll(),
      settlePendingEdit,
    },
    settings,
    isInMemory: false,
    isClosedByNewVersion: false,
    isPersistent: false,
    metas: [],
    current: null,
    timer: null,
    pendingSave: null,
    hasSaveFailed: false,
    tree: null,
    preview: null,
    viewEvents: new AbortController(),
  };
}

const storeEvents: StoreEvents = {
  onSaved(id) {
    if (app.current?.meta.id === id) {
      app.status.notify(MESSAGES.updatedElsewhere, { label: MESSAGES.reload, run: () => void reloadCurrent() });
    }

    void refreshList();
  },
  onDeleted(id) {
    markDeleted(id);
    void refreshList();
  },
  async beforeClose(): Promise<StoredDoc | null> {
    await flush();

    return app.current === null ? null : { meta: app.current.meta, text: app.current.text };
  },
  afterClose() {
    app.isInMemory = true;
    app.isClosedByNewVersion = true;
    setSaveStatus();
    void refreshList();
  },
};

/** 新しい版があるときの［更新］。flush と確認のあとに読み直す（N1-3） */
function offerUpdate(update: () => Promise<void>): void {
  app.status.notify(MESSAGES.newVersion, {
    label: MESSAGES.update,
    run: () => {
      void confirmLeave(true).then((isConfirmed) => (isConfirmed ? update() : undefined));
    },
  });
}

function isInsideEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-editor, input, textarea, [contenteditable="true"]') !== null;
}

function handlePaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain') ?? '';

  // エディタや入力欄の中の貼り付けはそちらに任せる
  if (isInsideEditable(event.target) || text === '') {
    return;
  }

  event.preventDefault();
  void confirmLeave().then((isConfirmed) => (isConfirmed ? openText(text) : undefined));
}

/** 狭い画面に変わったら、編集＋プレビューを片方（プレビュー）にする */
function handleScreenWidthChange(): void {
  if (window.matchMedia(NARROW_SCREEN_QUERY).matches && app.current?.view === 'split') {
    changeView('preview');
  } else {
    updateHeader();
  }
}

function attachWindowEvents(signal: AbortSignal): void {
  window.addEventListener('keydown', handleShortcut, { signal });
  window.addEventListener('paste', handlePaste, { signal });
  // 画面全体がドロップ先
  window.addEventListener(
    'dragover',
    (event) => {
      event.preventDefault();
    },
    { signal },
  );
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
  window.matchMedia(NARROW_SCREEN_QUERY).addEventListener('change', handleScreenWidthChange, { signal });
  app.dom.fileInput.addEventListener(
    'change',
    () => {
      const files = [...(app.dom.fileInput.files ?? [])];

      app.dom.fileInput.value = '';
      void openFiles(files);
    },
    { signal },
  );
}

/** 最後に開いていた文書（なければ一覧の先頭）を開く。0 件なら案内を出す */
async function openInitialDoc(): Promise<void> {
  app.metas = await listMeta();

  const first = app.metas.find((meta) => meta.id === app.settings.lastDocId) ?? app.metas[0];
  const text = first === undefined ? undefined : await getText(first.id);

  if (first !== undefined && text !== undefined) {
    showDoc(first, text);

    return;
  }

  renderBody();
  setSaveStatus();
  await refreshList();
}

/** 画面を組み立てて起動する。起動し直すときも呼ぶ（前の起動のイベントとエディタは片付ける） */
export async function startApp(root: HTMLElement): Promise<{ offerUpdate: typeof offerUpdate }> {
  running?.events.abort();
  running?.state.viewEvents.abort();
  running?.state.editor.destroy();

  const settings = loadSettings();
  const state = createAppState(root, settings);
  const events = new AbortController();

  running = { events, state };
  setApp(state);
  applyTheme(settings.theme);
  state.header.setTheme(settings.theme);
  state.dom.app.classList.toggle('side-closed', !settings.sideOpen);

  const opened = await openStore(storeEvents);

  app.isInMemory = opened.inMemory;
  void opened.persistent.then((isPersistent) => {
    app.isPersistent = isPersistent;
    void refreshList();
  });
  // ドロップや貼り付けを受けるのは、保存先が決まってから（それより前に作った文書は openStore で消えるため）
  attachWindowEvents(events.signal);
  await openInitialDoc();

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

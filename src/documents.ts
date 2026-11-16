// 文書の保存・開く・作る・削除・読み直し（基本 5・6、詳細設計 3.8）
// 編集の流れ：onEditorChange → 間引き → commitEdit（解析と表示の更新）→ startSave（自動保存）

import { EMPTY_ANALYSIS } from './analysis.ts';
import { applyAnalysis, refreshList, renderBody, runAnalysis, setSaveStatus } from './body.ts';
import { detectKind } from './detect.ts';
import { setDocument } from './editor.ts';
import { describeFailures, findSameDoc, readFile, uniqueName } from './files.ts';
import type { ReadFailure } from './files.ts';
import type { ViewName } from './header.ts';
import type { Eol } from './json.ts';
import { app, EXTENSION_BY_KIND, MESSAGES, VIEWS_BY_KIND } from './state.ts';
import type { CurrentDoc } from './state.ts';
import { buildMeta, deleteAll, deleteDoc, getText, listMeta, saveDoc, saveSettings } from './store.ts';
import type { DocHeader, Kind, Meta } from './store.ts';

// 入力が止まってから解析と自動保存をするまで（N3-3）。1 MB を超える本文では長くする
const DEBOUNCE_MS = 300;
const LONG_DEBOUNCE_MS = 1_000;
const LONG_DEBOUNCE_TEXT_LENGTH = 1_000_000;

export const NEW_DOC_BASE_NAME = '無題';

// ---- 保存 ----

/** いまの文書を保存する。保存の途中で文書が切り替わったら、結果は切替先の状態に書かない */
async function saveCurrent(): Promise<boolean> {
  const doc = app.current;

  if (doc === null || doc.isDeleted) {
    return false;
  }

  const isSaved = await saveDoc(doc.meta, doc.text).then(
    (meta) => {
      doc.meta = meta;

      return true;
    },
    () => false,
  );

  if (doc === app.current) {
    app.hasSaveFailed = !isSaved;
    setSaveStatus();
  }

  await refreshList();

  return isSaved;
}

/** 保存を始め、進行中の保存として持つ（flush が待てるように） */
export function startSave(): Promise<boolean> {
  const saving = saveCurrent();

  app.pendingSave = saving;
  void saving.finally(() => {
    if (app.pendingSave === saving) {
      app.pendingSave = null;
    }
  });

  return saving;
}

function clearPendingTimer(): void {
  if (app.timer !== null) {
    clearTimeout(app.timer);
    app.timer = null;
  }
}

function commitEdit(): Promise<boolean> {
  const doc = app.current;

  app.timer = null;

  if (doc === null) {
    return Promise.resolve(true);
  }

  applyAnalysis(doc);

  return startSave();
}

export function onEditorChange(text: string): void {
  if (app.current === null) {
    return;
  }

  app.current.text = text;
  clearPendingTimer();
  app.timer = setTimeout(() => void commitEdit(), text.length > LONG_DEBOUNCE_TEXT_LENGTH ? LONG_DEBOUNCE_MS : DEBOUNCE_MS);
}

export function settlePendingEdit(): void {
  if (app.timer !== null) {
    clearPendingTimer();
    void commitEdit();
  }
}

/** 保留中・進行中の自動保存を済ませ、成否を返す。別のタブで削除された文書は保存せずに失敗を返す */
export async function flush(): Promise<boolean> {
  if (app.current === null) {
    return true;
  }

  if (app.current.isDeleted) {
    return false;
  }

  if (app.timer !== null) {
    clearPendingTimer();

    return commitEdit();
  }

  if (app.pendingSave !== null) {
    return app.pendingSave;
  }

  return app.hasSaveFailed ? startSave() : true;
}

/**
 * 文書から離れる前の確認（基本 6-5）。flush が失敗したとき、メモリだけで動いているときの［更新］の前に確認を出す。
 * メモリだけのときの切替は内容が残るので確認しない
 */
export async function confirmLeave(isForUpdate = false): Promise<boolean> {
  const isFlushed = await flush();

  if (isFlushed && !(isForUpdate && app.isInMemory)) {
    return true;
  }

  return window.confirm(MESSAGES.unsavedConfirm);
}

// ---- 開く・作る ----

function detectEol(text: string): Eol {
  return /\r?\n/.exec(text)?.[0] === '\r\n' ? '\r\n' : '\n';
}

/** 文書を開く。表示は指定が無ければ種別の既定。lastGood と取り消しの履歴は作り直す */
export function showDoc(meta: Meta, text: string, view?: ViewName): void {
  const doc: CurrentDoc = {
    meta,
    text,
    eol: detectEol(text),
    view: view ?? VIEWS_BY_KIND[meta.kind][0] ?? 'text',
    lastGood: null,
    analysis: EMPTY_ANALYSIS,
    isDeleted: false,
  };

  clearPendingTimer();
  app.current = doc;
  app.hasSaveFailed = false;
  runAnalysis(doc);
  setDocument(app.editor, text, meta.kind, doc.eol);
  app.settings = { ...app.settings, lastDocId: meta.id };
  saveSettings(app.settings);
  renderBody();
  setSaveStatus();
  void refreshList();
}

export async function openById(id: string): Promise<void> {
  if (app.current?.meta.id === id || !(await confirmLeave())) {
    return;
  }

  const meta = app.metas.find((candidate) => candidate.id === id);
  const text = await getText(id);

  if (meta === undefined || text === undefined) {
    app.status.notify(MESSAGES.openFailed);

    return;
  }

  showDoc(meta, text);
}

/** 保存して開く。保存に失敗しても開いて編集を続けられるようにする（N4-2）。種別の変更でも使う */
export async function saveAndShow(header: DocHeader, text: string, view?: ViewName): Promise<void> {
  const saved = await saveDoc(header, text).catch(() => null);

  showDoc(saved ?? buildMeta(header, text), text, view);
  app.hasSaveFailed = saved === null;
  setSaveStatus();
}

/** 新しい文書を保存して開く */
export async function createDoc(name: string, text: string, kind: Kind, view?: ViewName): Promise<void> {
  const docHeader = { id: crypto.randomUUID(), name: uniqueName(name, new Set(app.metas.map((meta) => meta.name))), kind };

  await saveAndShow(docHeader, text, view);
}

export async function openText(text: string): Promise<void> {
  const { kind, note } = detectKind(null, text);

  await createDoc(`${NEW_DOC_BASE_NAME}.${EXTENSION_BY_KIND[kind]}`, text, kind);

  if (note !== undefined) {
    app.status.notify(note);
  }
}

/** 複数のファイルを順に開き、最後に開けた文書を出す。開けなかったものは状態行にまとめて出す */
export async function openFiles(files: readonly File[]): Promise<void> {
  if (files.length === 0 || !(await confirmLeave())) {
    return;
  }

  const failures: ReadFailure[] = [];
  // 案内の文 → その案内が付いたファイルの名前
  const namesByNote = new Map<string, string[]>();

  for (const file of files) {
    const readResult = await readFile(file);

    if (!readResult.ok) {
      failures.push({ name: file.name, reason: readResult.reason });
      continue;
    }

    const same = await findSameDoc(app.metas, file.name, readResult.text);

    if (same !== undefined) {
      showDoc(same, readResult.text);
      continue;
    }

    const detected = detectKind(file.name, readResult.text);

    if (detected.note !== undefined) {
      namesByNote.set(detected.note, [...(namesByNote.get(detected.note) ?? []), file.name]);
    }
    await createDoc(file.name, readResult.text, detected.kind);
    app.metas = await listMeta();
  }

  if (failures.length > 0) {
    app.status.notify(describeFailures(failures, files.length === 1));
  } else if (namesByNote.size > 0) {
    app.status.notify(describeNotes(namesByNote, files.length === 1));
  }
}

/** 開いたときの案内。1 件だけ選んだときは案内だけ、複数のときはファイル名を付けて 1 つにまとめる */
function describeNotes(namesByNote: ReadonlyMap<string, readonly string[]>, isSingleFile: boolean): string {
  if (isSingleFile) {
    return [...namesByNote.keys()].join(' ');
  }

  return [...namesByNote].map(([note, names]) => `${names.join('・')}：${note}`).join(' ／ ');
}

export async function pasteFromClipboard(): Promise<void> {
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

// ---- 削除・読み直し ----

/** preferredId の文書（なければ一覧の先頭）を開く。0 件なら案内を出す。起動のときと、開いていた文書を削除したときに使う */
export async function openFirstOrEmpty(preferredId: string | null = null): Promise<void> {
  clearPendingTimer();
  app.current = null;
  app.metas = await listMeta();

  const first = app.metas.find((meta) => meta.id === preferredId) ?? app.metas[0];
  const text = first === undefined ? undefined : await getText(first.id);

  if (first !== undefined && text !== undefined) {
    showDoc(first, text);

    return;
  }

  renderBody();
  setSaveStatus();
  await refreshList();
}

export async function removeDoc(meta: Meta): Promise<void> {
  if (!window.confirm(MESSAGES.deleteConfirm(meta.name))) {
    return;
  }

  try {
    await deleteDoc(meta.id);
  } catch {
    app.status.notify(MESSAGES.deleteFailed);

    return;
  }

  if (app.current?.meta.id === meta.id) {
    await openFirstOrEmpty();
  } else {
    await refreshList();
  }
}

export async function removeAll(): Promise<void> {
  if (!window.confirm(MESSAGES.deleteAllConfirm(app.metas.length))) {
    return;
  }

  try {
    await deleteAll();
  } catch {
    app.status.notify(MESSAGES.deleteFailed);

    return;
  }

  await openFirstOrEmpty();
}

/** 別のタブで更新された文書を読み直す。保留中の編集があれば確認を出す（基本 6-7） */
export async function reloadCurrent(): Promise<void> {
  const doc = app.current;
  const hasPendingEdits = app.timer !== null || app.hasSaveFailed;

  if (doc === null || (hasPendingEdits && !window.confirm(MESSAGES.reloadConfirm))) {
    return;
  }

  clearPendingTimer();
  app.metas = await listMeta();

  const meta = app.metas.find((candidate) => candidate.id === doc.meta.id);
  const text = await getText(doc.meta.id);

  if (meta === undefined || text === undefined) {
    app.status.notify(MESSAGES.openFailed);

    return;
  }

  showDoc(meta, text);
  app.status.notify('');
}

/** 別のタブで削除された。いま開いている文書なら自動保存を止める（本文は画面に残るのでダウンロードはできる） */
export function markDeleted(id: string | null): void {
  const doc = app.current;

  if (doc !== null && (id === null || id === doc.meta.id)) {
    doc.isDeleted = true;
    clearPendingTimer();
    app.status.notify(MESSAGES.deletedElsewhere);
  }
}

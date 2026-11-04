// 文書の保存（IndexedDB。使えないときはメモリ）、永続化の要求、別タブとの通知、設定（localStorage）
// 詳細設計 3.1、基本 4。IndexedDB を直接扱うのはこのファイルだけ（N5-1）

export type Kind = 'markdown' | 'json' | 'json5' | 'jsonl' | 'geojson';

export interface Meta {
  readonly id: string;
  readonly name: string;
  readonly kind: Kind;
  // 本文の UTF-8 のバイト数
  readonly size: number;
  // ミリ秒
  readonly updatedAt: number;
}

/** 保存のときに呼び出し側が渡す部分。size と updatedAt は保存の時点で決める */
export type DocHeader = Pick<Meta, 'id' | 'name' | 'kind'>;

export interface StoredDoc {
  readonly meta: Meta;
  readonly text: string;
}

export interface Settings {
  readonly theme: 'light' | 'dark' | 'system';
  readonly lastDocId: string | null;
  readonly sideOpen: boolean;
}

export interface StoreEvents {
  // 別のタブで保存された
  onSaved(id: string): void;
  // 別のタブで削除された（null はすべて削除）
  onDeleted(id: string | null): void;
  // 版の更新で DB を閉じる直前。呼び出し側が flush し、いま開いている文書を返す
  beforeClose(): Promise<StoredDoc | null>;
}

const DB_NAME = 'md-json-editor';
// 版を上げるときは openDatabase の onupgradeneeded に版ごとの移行を足す
const DB_VERSION = 1;
const META_STORE = 'meta';
const BODY_STORE = 'body';
const CHANNEL_NAME = 'md-json-editor';
const SETTINGS_KEY = 'md-json-editor:settings';

const DEFAULT_SETTINGS: Settings = { theme: 'system', lastDocId: null, sideOpen: true };
const THEMES: readonly Settings['theme'][] = ['light', 'dark', 'system'];

type ChannelMessage = { type: 'saved'; id: string } | { type: 'deleted'; id: string | null };

interface BodyRecord {
  readonly id: string;
  readonly text: string;
}

// db が null のときはメモリで動く（IndexedDB が使えない、または版の更新で閉じた）
let db: IDBDatabase | null = null;
const memory = new Map<string, StoredDoc>();
let channel: BroadcastChannel | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB の要求に失敗した'));
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB のトランザクションに失敗した'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB のトランザクションが中断された'));
    };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = (event) => {
    // 版 1：作成のみ
    if (event.oldVersion < 1) {
      request.result.createObjectStore(META_STORE, { keyPath: 'id' });
      request.result.createObjectStore(BODY_STORE, { keyPath: 'id' });
    }
  };

  return requestToPromise(request);
}

async function requestPersistence(): Promise<boolean> {
  // navigator.storage が無い環境（N0-1）では求めない
  if (!('storage' in navigator) || typeof navigator.storage.persist !== 'function') {
    return false;
  }

  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

function isChannelMessage(data: unknown): data is ChannelMessage {
  if (typeof data !== 'object' || data === null || !('type' in data) || !('id' in data)) {
    return false;
  }

  return (data.type === 'saved' && typeof data.id === 'string') || (data.type === 'deleted' && (typeof data.id === 'string' || data.id === null));
}

function openChannel(events: StoreEvents): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }

  const opened = new BroadcastChannel(CHANNEL_NAME);

  opened.onmessage = (event: MessageEvent<unknown>) => {
    if (!isChannelMessage(event.data)) {
      return;
    }

    if (event.data.type === 'saved') {
      events.onSaved(event.data.id);
    } else {
      events.onDeleted(event.data.id);
    }
  };

  return opened;
}

function broadcast(message: ChannelMessage): void {
  // メモリで動いているときは channel が null なので送らない
  channel?.postMessage(message);
}

function closeStore(): void {
  db?.close();
  db = null;
  channel?.close();
  channel = null;
  memory.clear();
}

/** 版の更新で DB を閉じる。閉じる前に、いま開いている文書だけをメモリに写す（一覧はその 1 件になる） */
async function moveToMemory(events: StoreEvents): Promise<void> {
  const current = await events.beforeClose();

  closeStore();

  if (current !== null) {
    memory.set(current.meta.id, current);
  }
}

/** DB を開く。開けなければメモリで動き、inMemory: true を返す。起動し直すときも呼ぶ（前の状態は捨てる） */
export async function openStore(events: StoreEvents): Promise<{ persistent: boolean; inMemory: boolean }> {
  closeStore();

  try {
    db = await openDatabase();
  } catch {
    db = null;
  }

  if (db !== null) {
    db.onversionchange = () => {
      void moveToMemory(events);
    };
    channel = openChannel(events);
  }

  const persistent = await requestPersistence();

  return { persistent, inMemory: db === null };
}

function byUpdatedAtDesc(a: Meta, b: Meta): number {
  return b.updatedAt - a.updatedAt;
}

/** updatedAt の降順。本文は読まない */
export async function listMeta(): Promise<Meta[]> {
  if (db === null) {
    return [...memory.values()].map((doc) => doc.meta).sort(byUpdatedAtDesc);
  }

  const metas = await requestToPromise(db.transaction(META_STORE).objectStore(META_STORE).getAll() as IDBRequest<Meta[]>);

  return metas.sort(byUpdatedAtDesc);
}

export async function getText(id: string): Promise<string | undefined> {
  if (db === null) {
    return memory.get(id)?.text;
  }

  const record = await requestToPromise(db.transaction(BODY_STORE).objectStore(BODY_STORE).get(id) as IDBRequest<BodyRecord | undefined>);

  return record?.text;
}

/** meta と本文を 1 つのトランザクションで保存し、保存した meta を返す。失敗は例外のまま投げる */
export async function saveDoc(header: DocHeader, text: string): Promise<Meta> {
  const meta: Meta = { ...header, size: new TextEncoder().encode(text).length, updatedAt: Date.now() };

  if (db === null) {
    memory.set(meta.id, { meta, text });

    return meta;
  }

  const transaction = db.transaction([META_STORE, BODY_STORE], 'readwrite');
  const done = transactionDone(transaction);

  transaction.objectStore(META_STORE).put(meta);
  transaction.objectStore(BODY_STORE).put({ id: meta.id, text } satisfies BodyRecord);
  await done;
  broadcast({ type: 'saved', id: meta.id });

  return meta;
}

export async function deleteDoc(id: string): Promise<void> {
  if (db === null) {
    memory.delete(id);

    return;
  }

  const transaction = db.transaction([META_STORE, BODY_STORE], 'readwrite');
  const done = transactionDone(transaction);

  transaction.objectStore(META_STORE).delete(id);
  transaction.objectStore(BODY_STORE).delete(id);
  await done;
  broadcast({ type: 'deleted', id });
}

export async function deleteAll(): Promise<void> {
  if (db === null) {
    memory.clear();

    return;
  }

  const transaction = db.transaction([META_STORE, BODY_STORE], 'readwrite');
  const done = transactionDone(transaction);

  transaction.objectStore(META_STORE).clear();
  transaction.objectStore(BODY_STORE).clear();
  await done;
  broadcast({ type: 'deleted', id: null });
}

/** 壊れている項目は既定値にする */
export function loadSettings(): Settings {
  let stored: unknown;

  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    return DEFAULT_SETTINGS;
  }

  if (typeof stored !== 'object' || stored === null) {
    return DEFAULT_SETTINGS;
  }

  const fields: Partial<Record<keyof Settings, unknown>> = stored;

  return {
    theme: THEMES.find((theme) => theme === fields.theme) ?? DEFAULT_SETTINGS.theme,
    lastDocId: typeof fields.lastDocId === 'string' ? fields.lastDocId : DEFAULT_SETTINGS.lastDocId,
    sideOpen: typeof fields.sideOpen === 'boolean' ? fields.sideOpen : DEFAULT_SETTINGS.sideOpen,
  };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage が使えない環境では設定を保たない。文書の保存とは別なので知らせない
  }
}

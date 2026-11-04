// ユースケースのテストの共通の操作。画面を組み立て、利用者の操作（ファイルの選択・クリック・キー）で進める（詳細設計 5）

import { EditorView } from '@codemirror/view';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, vi } from 'vitest';

import { startApp } from '../src/main.ts';

import { createdBlobs } from './setup.ts';

// fixtures の中身（UTF-8 の文字列）。BOM 付きと UTF-8 以外のファイルはバイト列が要るので、テストの中で作る
const FIXTURE_TEXTS = import.meta.glob<string>('./fixtures/*', { query: '?raw', import: 'default', eager: true });

// テストごとに空の IndexedDB と localStorage から始める
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

export async function start(): Promise<HTMLElement> {
  const root = document.createElement('div');

  document.body.replaceChildren(root);
  await startApp(root);

  return root;
}

export function fixtureText(name: string): string {
  const text = FIXTURE_TEXTS[`./fixtures/${name}`];

  if (text === undefined) {
    throw new Error(`fixtures/${name} が無い`);
  }

  return text;
}

export function fixture(name: string): File {
  return new File([fixtureText(name)], name);
}

/** 要素を 1 つ取る。無ければ例外。type を渡すと、その種類の要素であることも確かめる */
export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string, type?: new () => T): T {
  const element = root.querySelector(selector);

  if (element === null || (type !== undefined && !(element instanceof type))) {
    throw new Error(`${selector} が無い`);
  }

  return element as T;
}

export function texts(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((element) => element.textContent);
}

/** ファイルの入力でファイルを選び、文書が開くまで待つ */
export async function chooseFiles(root: HTMLElement, files: File[], expectedName?: string): Promise<void> {
  const input = query(root, '.file-input', HTMLInputElement);

  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));

  const name = expectedName ?? files.at(-1)?.name;

  await vi.waitFor(() => {
    expect(query(root, '.doc-title').textContent).toBe(name);
  });
}

export function click(root: ParentNode, selector: string): void {
  query(root, selector).click();
}

export function runAction(root: HTMLElement, action: string): void {
  click(root, `[data-action="${action}"]`);
}

export function pressKey(key: string, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
}

export function editorOf(root: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(query(root, '.cm-editor'));

  if (view === null) {
    throw new Error('エディタが無い');
  }

  return view;
}

/** 本文を置き換える。jsdom では contenteditable へのキー入力で文字が入らないため、変更を直接入れる */
export function replaceText(root: HTMLElement, text: string): void {
  const view = editorOf(root);

  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

export function insertAtEnd(root: HTMLElement, text: string): void {
  const view = editorOf(root);

  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

export function selectOption(root: HTMLElement, selector: string, value: string): void {
  const select = query(root, selector, HTMLSelectElement);

  select.value = value;
  select.dispatchEvent(new Event('change'));
}

export async function statusShows(root: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(query(root, '.status').textContent).toContain(text);
  });
}

export async function downloadedText(): Promise<string> {
  const blob = createdBlobs.at(-1);

  if (blob === undefined) {
    throw new Error('ダウンロードされていない');
  }

  return await blob.text();
}

export function docNames(root: HTMLElement): string[] {
  return texts(root, '.doc-item .doc-name');
}

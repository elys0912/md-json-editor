// jsdom に無い API の補い（詳細設計 5）
// navigator.storage は補わない。無い環境の扱い（N0-1）をそのまま通すため
// navigator.clipboard と confirm はテストごとに差し替える

import 'fake-indexeddb/auto';

import { afterEach, vi } from 'vitest';

// CodeMirror が座標の計算に使う。jsdom では値が出ないので空の値を返す
const EMPTY_RECT: DOMRect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
const EMPTY_RECT_LIST: DOMRectList = Object.assign([], { item: () => null });

Range.prototype.getClientRects = (): DOMRectList => EMPTY_RECT_LIST;
Range.prototype.getBoundingClientRect = (): DOMRect => EMPTY_RECT;

Element.prototype.scrollIntoView = function scrollIntoView(): void {
  // jsdom はスクロールしない。呼ばれたかどうかは spy で確かめる
};

// 常に一致しない。OS のダークの設定は無いものとして扱う
window.matchMedia = (query: string): MediaQueryList =>
  Object.assign(new EventTarget(), {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
  });

/** URL.createObjectURL に渡された Blob。ダウンロードの中身の確認に使う */
export const createdBlobs: Blob[] = [];

URL.createObjectURL = (blob: Blob | MediaSource): string => {
  createdBlobs.push(blob as Blob);

  return `blob:test/${createdBlobs.length}`;
};
URL.revokeObjectURL = (): void => undefined;

// ダウンロードのリンクのクリックは、jsdom が実装していない移動になるので何もしない。ほかのリンクのクリックはそのまま通す
// eslint-disable-next-line @typescript-eslint/unbound-method -- 呼ぶときに call で this を渡す
const originalAnchorClick = HTMLAnchorElement.prototype.click;

HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
  if (!this.hasAttribute('download')) {
    originalAnchorClick.call(this);
  }
};

afterEach(() => {
  createdBlobs.length = 0;
  vi.restoreAllMocks();
});

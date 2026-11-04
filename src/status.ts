// 状態行：文字数・行数／誤りの件数／保存の状態／通知（基本 2）。通知は［読み直す］などのボタンを 1 つ持てる

import { createButton, createElement } from './dom.ts';

export interface StatusLine {
  setCounts(text: string | null): void;
  setErrors(message: string): void;
  setSave(message: string): void;
  notify(message: string, action?: { label: string; run: () => void }): void;
}

export function createStatusLine(container: HTMLElement): StatusLine {
  const counts = createElement('span', 'status-counts');
  const errors = createElement('span', 'status-errors');
  const save = createElement('span', 'status-save');
  const notice = createElement('span', 'status-notice');

  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  container.replaceChildren(counts, errors, save, notice);

  return {
    setCounts(text) {
      // 文字数はコードポイントで数える（サロゲートペアを 1 文字に）
      counts.textContent = text === null ? '' : `${Array.from(text).length} 文字・${text.split(/\r\n|\n/).length} 行`;
    },
    setErrors(message) {
      errors.textContent = message;
    },
    setSave(message) {
      save.textContent = message;
    },
    notify(message, action) {
      notice.replaceChildren(message);

      if (action === undefined) {
        return;
      }

      notice.append(createButton('status-action', action.label, action.run));
    },
  };
}

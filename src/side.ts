// サイド：文書の一覧（名前・種別・更新日時・大きさ、合計、すべて削除、永続化の注意）と目次（基本 2、F1-4、F2-5）
// 名前は利用者由来なので textContent でだけ出す（N2-4）

import { createButton, createElement } from './dom.ts';
import type { TocEntry } from './markdown.ts';
import type { Meta } from './store.ts';

export interface DocListHandlers {
  readonly open: (id: string) => void;
  readonly remove: (meta: Meta) => void;
  readonly removeAll: () => void;
}

const KILOBYTE = 1024;
const MEGABYTE = KILOBYTE * 1024;

export const PERSIST_NOTE = 'ブラウザが消す場合があります。大事な文書はダウンロードで控えを';

/** バイト数の表示。例：512 → `512 B`、1536 → `1.5 KB` */
export function formatSize(bytes: number): string {
  if (bytes < KILOBYTE) {
    return `${bytes} B`;
  }

  return bytes < MEGABYTE ? `${(bytes / KILOBYTE).toFixed(1)} KB` : `${(bytes / MEGABYTE).toFixed(1)} MB`;
}

export function renderDocList(
  container: HTMLElement,
  metas: readonly Meta[],
  currentId: string | null,
  options: { persistent: boolean; handlers: DocListHandlers },
): void {
  const list = document.createElement('ul');

  list.className = 'doc-list';

  for (const meta of metas) {
    const item = document.createElement('li');
    const open = createButton('doc-open', '', () => {
      options.handlers.open(meta.id);
    });
    const remove = createButton('doc-remove', '×', () => {
      options.handlers.remove(meta);
    });

    item.className = 'doc-item';
    item.dataset.id = meta.id;
    item.classList.toggle('is-current', meta.id === currentId);
    open.append(
      createElement('span', 'doc-name', meta.name),
      createElement('span', 'doc-kind', meta.kind),
      createElement('span', 'doc-updated', new Date(meta.updatedAt).toLocaleString('ja-JP')),
      createElement('span', 'doc-size', formatSize(meta.size)),
    );
    remove.title = '削除';
    remove.setAttribute('aria-label', `${meta.name} を削除`);
    item.append(open, remove);
    list.append(item);
  }

  const total = metas.reduce((sum, meta) => sum + meta.size, 0);
  const footer = document.createElement('div');

  footer.className = 'doc-footer';
  footer.append(createElement('span', 'doc-total', `${metas.length} 件・合計 ${formatSize(total)}`));

  if (metas.length > 0) {
    footer.append(createButton('doc-remove-all', 'すべて削除', options.handlers.removeAll));
  }

  container.replaceChildren(createElement('h2', 'side-heading', '文書'), list, footer);

  if (!options.persistent) {
    container.append(createElement('p', 'doc-persist-note', PERSIST_NOTE));
  }
}

export function renderToc(container: HTMLElement, toc: readonly TocEntry[] | null, onSelect: (entry: TocEntry) => void): void {
  if (toc === null || toc.length === 0) {
    container.replaceChildren();
    container.hidden = true;

    return;
  }

  const list = document.createElement('ul');

  list.className = 'toc-list';

  for (const entry of toc) {
    const item = document.createElement('li');

    item.className = `toc-item toc-level-${entry.level}`;
    item.append(
      createButton('toc-link', entry.text, () => {
        onSelect(entry);
      }),
    );
    list.append(item);
  }

  container.hidden = false;
  container.replaceChildren(createElement('h2', 'side-heading', '目次'), list);
}

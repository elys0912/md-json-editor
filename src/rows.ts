// JSON Lines の行一覧（F5-3）。1 行 ＝ 行番号 ＋ 値の要約。クリックでその行の値をツリーで開く。誤りの行は内容を出す
// 値は利用者由来なので textContent でだけ出す（N2-4）

import { createButton, createElement } from './dom.ts';
import { describeLineError } from './json.ts';
import type { JsonlLine } from './json.ts';
import { renderTree, summarize } from './tree.ts';

// 行をこの数ずつ描く（N3-2）
const ROW_CHUNK = 1_000;

function createRowItem(line: JsonlLine): HTMLLIElement {
  const li = createElement('li', 'rows-item');
  const number = createElement('span', 'rows-line-no', String(line.lineNo));

  if ('error' in line) {
    li.classList.add('is-error');
    li.append(number, createElement('span', 'rows-error', describeLineError(line.lineNo, line.error)));

    return li;
  }

  const button = createButton('rows-summary', summarize(line.value));
  const detail = createElement('div', 'rows-detail');

  detail.hidden = true;
  button.addEventListener('click', () => {
    detail.hidden = !detail.hidden;

    if (!detail.hidden && detail.childElementCount === 0) {
      renderTree(detail, line.value);
    }
  });
  li.append(number, button, detail);

  return li;
}

export function renderRows(container: HTMLElement, lines: readonly JsonlLine[]): void {
  const list = createElement('ol', 'rows');
  let shown = 0;

  const showMore = (): void => {
    const end = Math.min(lines.length, shown + ROW_CHUNK);

    list.querySelector(':scope > .rows-more')?.remove();
    list.append(...lines.slice(shown, end).map(createRowItem));
    shown = end;

    if (shown < lines.length) {
      const item = createElement('li', 'rows-more');

      item.append(createButton('rows-more-button', `さらに ${Math.min(lines.length - shown, ROW_CHUNK)} 行`, showMore));
      list.append(item);
    }
  };

  showMore();
  container.replaceChildren(list);
}

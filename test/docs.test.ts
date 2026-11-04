// UC10〜12：貼り付け・BOM・UTF-8 以外の読込、文書の一覧の操作とテーマ、保存できない環境（基本 10）

import { describe, expect, it, vi } from 'vitest';

import { chooseFiles, click, docNames, insertAtEnd, query, runAction, selectOption, start, statusShows, texts } from './app.ts';

// UTF-8 の BOM と、Shift_JIS の「見出し」（UTF-8 としては読めない）
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const SHIFT_JIS_HEADING = new Uint8Array([0x8c, 0xa9, 0x8f, 0x6f, 0x82, 0xb5]);

function paste(text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });

  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  document.body.dispatchEvent(event);
}

async function titleBecomes(root: HTMLElement, name: string): Promise<void> {
  await vi.waitFor(() => {
    expect(query(root, '.doc-title').textContent).toBe(name);
  });
}

function openDoc(root: HTMLElement, name: string): void {
  const item = [...root.querySelectorAll<HTMLElement>('.doc-item')].find((element) => element.querySelector('.doc-name')?.textContent === name);

  item?.querySelector<HTMLButtonElement>('.doc-open')?.click();
}

describe('UC10 貼り付けた内容を新しい文書として開く。BOM 付き・UTF-8 以外のファイルを開く。同じファイルを開き直す', () => {
  it('種別を推定して開き、BOM は除き、UTF-8 以外は理由を出し、同じファイルは増やさない', async () => {
    const root = await start();

    paste('{"a":1}\n{"a":2}\n');
    await titleBecomes(root, '無題.jsonl');
    paste('{"a":1}');
    await titleBecomes(root, '無題.json');
    paste('# 見出し');
    await titleBecomes(root, '無題.md');

    expect(texts(root, '.doc-item .doc-kind')).toEqual(['markdown', 'json', 'jsonl']);

    const bomJson = (): File => new File([BOM, '{"a": 1}'], 'bom.json');

    await chooseFiles(root, [bomJson(), new File([SHIFT_JIS_HEADING], 'sjis.md')], 'bom.json');
    await statusShows(root, '1 件を開けませんでした：sjis.md（UTF-8 ではありません）');
    expect(query(root, '.errors').hidden).toBe(true);
    expect(texts(root, '.tree-key')).toEqual(['$', 'a']);
    expect(docNames(root)).toHaveLength(4);

    await chooseFiles(root, [bomJson()]);
    expect(docNames(root)).toHaveLength(4);
  });
});

describe('UC11 新規作成し、一覧で切り替え、名前・種別を変え、削除する。テーマを変え、起動し直しても保たれる', () => {
  it('一覧の並び・名前・種別・件数が操作どおりになり、ダークが保たれる', async () => {
    let root = await start();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    runAction(root, 'new-markdown');
    await titleBecomes(root, '無題.md');
    runAction(root, 'new-json');
    await titleBecomes(root, '無題.json');
    runAction(root, 'new-markdown');
    await titleBecomes(root, '無題 2.md');
    expect(docNames(root)).toEqual(['無題 2.md', '無題.json', '無題.md']);

    openDoc(root, '無題.md');
    await titleBecomes(root, '無題.md');
    click(root, '.doc-title');

    const input = query(root, '.doc-name-input', HTMLInputElement);

    input.value = 'メモ.md';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => {
      expect(docNames(root)).toEqual(['メモ.md', '無題 2.md', '無題.json']);
    });

    selectOption(root, '.kind-select', 'json5');
    await vi.waitFor(() => {
      expect(query(root, '.doc-item.is-current .doc-kind').textContent).toBe('json5');
    });
    expect(query(root, '.doc-kind-badge').textContent).toBe('json5');

    query(root, '.doc-item.is-current .doc-remove').click();
    await vi.waitFor(() => {
      expect(docNames(root)).toEqual(['無題 2.md', '無題.json']);
    });
    expect(confirm).toHaveBeenCalledWith('「メモ.md」を削除します');

    click(root, '.doc-remove-all');
    await vi.waitFor(() => {
      expect(docNames(root)).toEqual([]);
    });
    expect(confirm).toHaveBeenCalledWith('すべての文書（2 件）を削除します');
    expect(query(root, '.empty .guide').textContent).toBe('ファイルをドロップするか、選ぶか、貼り付けてください');

    selectOption(root, '.theme-select', 'dark');
    root = await start();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(query(root, '.theme-select', HTMLSelectElement).value).toBe('dark');
  });
});

describe('UC12 保存できない環境・容量超過でも編集を続けられ、離れる前に確認が出る', () => {
  it('IndexedDB が開けないときはメモリで動き、一覧・切替・編集が使え、切替で確認は出ない', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('blocked');
    });

    const root = await start();
    const confirm = vi.spyOn(window, 'confirm');

    await statusShows(root, 'この環境では保存できません。閉じると内容は消えます');
    runAction(root, 'new-markdown');
    await titleBecomes(root, '無題.md');
    runAction(root, 'new-json');
    await titleBecomes(root, '無題.json');
    insertAtEnd(root, ' ');
    openDoc(root, '無題.md');
    await titleBecomes(root, '無題.md');

    expect(docNames(root)).toEqual(['無題.json', '無題.md']);
    expect(confirm).not.toHaveBeenCalled();
    expect(query(root, '.status').textContent).not.toContain('保存済み');
  });

  it('容量超過では理由を出して編集を続けられ、切替の前に確認が出て、断ると切り替わらない', async () => {
    const root = await start();

    runAction(root, 'new-markdown');
    await titleBecomes(root, '無題.md');
    runAction(root, 'new-json');
    await titleBecomes(root, '無題.json');

    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    insertAtEnd(root, ' ');
    await statusShows(root, '保存できません（容量）。ダウンロードしてください');
    insertAtEnd(root, ' ');
    openDoc(root, '無題.md');

    await vi.waitFor(() => {
      expect(confirm).toHaveBeenCalledWith('保存できていません。ダウンロードせずに続けますか');
    });
    expect(query(root, '.doc-title').textContent).toBe('無題.json');
  });
});

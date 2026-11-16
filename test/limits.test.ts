// 上限・別タブ・離れるときの保存。ユースケースの流れでは通らない振る舞い（N2・N3・基本 6）

import { afterEach, describe, expect, it, vi } from 'vitest';

import { chooseFiles, insertAtEnd, query, runAction, start, statusShows } from './app.ts';

const CHANNEL_NAME = 'md-json-editor';
const DB_NAME = 'md-json-editor';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
// 描く位置の総数の上限（N3-2）を 1 つ超える数
const OVER_DRAWN_POSITIONS = 500_001;
// jsonc-parser の再帰が上限に達する深さ
const TOO_DEEP = 20_000;
// 入力の間引き（300 ミリ秒）より短い待ち。これより早く保存されれば、間引きを待たずに保存したと分かる
const BEFORE_DEBOUNCE_MS = 150;
// 入力の間引き（300 ミリ秒）が済むまでの待ち
const AFTER_DEBOUNCE_MS = 400;

/** ファイルの入力でファイルを選ぶ。開けないファイルを選ぶときは、文書が開くのを待たない */
function selectFiles(root: HTMLElement, files: File[]): void {
  const input = query(root, '.file-input', HTMLInputElement);

  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

async function newJsonDoc(root: HTMLElement): Promise<string> {
  runAction(root, 'new-json');
  await vi.waitFor(() => {
    expect(query(root, '.doc-title').textContent).toBe('無題.json');
  });

  return query(root, '.doc-item.is-current').dataset.id ?? '';
}

describe('上限', () => {
  it('50 MB を超えるファイルは開かず、理由を出す', async () => {
    const root = await start();
    const big = new File(['{}'], 'big.json');

    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    selectFiles(root, [big]);

    await statusShows(root, '「big.json」は大きすぎます（上限 50 MB）');
  });

  it('位置が 50 万を超える GeoJSON は図形を描かず、ツリーへ案内する', async () => {
    const root = await start();
    const coordinates = Array.from({ length: OVER_DRAWN_POSITIONS }, () => '[0,0]').join(',');

    await chooseFiles(root, [new File([`{"type":"MultiPoint","coordinates":[${coordinates}]}`], 'many.geojson')]);

    expect(query(root, '.shape-view').textContent).toContain('大きすぎるため図形を描きません（位置 500001 個、上限 50 万）');
    expect(root.querySelector('svg')).toBeNull();
  });

  it('入れ子が深すぎて誤りの位置を取れない JSON は、誤り 1 件として出す', async () => {
    const root = await start();
    const unclosed = `${'['.repeat(TOO_DEEP)}${']'.repeat(TOO_DEEP - 1)}`;

    await chooseFiles(root, [new File([unclosed], 'deep.json')]);

    expect(query(root, '.issue-link').textContent).toBe('1 行 1 列：入れ子が深すぎるため読めません');
  });
});

describe('別のタブ', () => {
  it('開いている文書が別のタブで保存されたら知らせ、削除されたら知らせる', async () => {
    const root = await start();
    const id = await newJsonDoc(root);
    const otherTab = new BroadcastChannel(CHANNEL_NAME);

    otherTab.postMessage({ type: 'saved', id });
    await statusShows(root, '別のタブで更新されました');
    expect(query(root, '.status-action').textContent).toBe('読み直す');

    otherTab.postMessage({ type: 'deleted', id });
    await statusShows(root, '別のタブで削除されました');
    otherTab.close();
  });

  it('別のタブで新しい版の DB が開かれたら、メモリへ移ってその旨を出す', async () => {
    const root = await start();

    await newJsonDoc(root);
    indexedDB.open(DB_NAME, 2);

    await statusShows(root, '別のタブで新しい版が開かれました。再読込してください');
  });
});

describe('離れるときの保存', () => {
  // 保存されなかったときに残る間引きのタイマーが、次のテストの文書を保存して結果を変えないよう、済むまで待つ
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, AFTER_DEBOUNCE_MS));
  });

  it('ページを離れる（pagehide）と、入力の間引きを待たずに保存する', async () => {
    const root = await start();

    await newJsonDoc(root);
    insertAtEnd(root, ' ');
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(
      () => {
        expect(query(root, '.doc-item.is-current .doc-size').textContent).toBe('3 B');
      },
      { timeout: BEFORE_DEBOUNCE_MS },
    );
  });

  it('タブが隠れる（visibilitychange）と、入力の間引きを待たずに保存する', async () => {
    const root = await start();

    await newJsonDoc(root);
    insertAtEnd(root, ' ');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(
      () => {
        expect(query(root, '.doc-item.is-current .doc-size').textContent).toBe('3 B');
      },
      { timeout: BEFORE_DEBOUNCE_MS },
    );
  });
});

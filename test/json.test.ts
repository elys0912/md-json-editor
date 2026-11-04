// UC4〜8：JSON をツリーで読む・誤りを直す・整形する、JSON5 を読む、JSON Lines を読んで変換する（基本 10）

import { describe, expect, it, vi } from 'vitest';

import {
  chooseFiles,
  click,
  docNames,
  editorOf,
  fixture,
  fixtureText,
  insertAtEnd,
  pressKey,
  query,
  replaceText,
  runAction,
  start,
  statusShows,
  texts,
} from './app.ts';

const DANGER = '<img src=x onerror=alert(1)>';

describe('UC4 危険な文字列を含む JSON をツリーで読み、全開・全閉、検索してパスを写す', () => {
  it('どこにも HTML として出ず、検索した該当の祖先が開き、パスを写せる', async () => {
    const root = await start();
    const json = JSON.stringify({ items: [{ name: 'a' }, { name: 'b' }, { name: DANGER }], [DANGER]: DANGER });
    const writeText = vi.fn(() => Promise.resolve());

    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await chooseFiles(root, [new File([json], `${DANGER}.json`)]);

    expect(root.querySelector('img')).toBeNull();
    expect(texts(root, '.tree-key')).toContain(DANGER);

    const collapsedCount = root.querySelectorAll('.tree-node').length;

    click(root, '.tree-expand');
    expect(root.querySelectorAll('.tree-node').length).toBeGreaterThan(collapsedCount);
    expect(root.querySelector('img')).toBeNull();
    click(root, '.tree-collapse');
    expect(root.querySelectorAll('.tree-node').length).toBe(collapsedCount);

    const search = query(root, '.tree-search', HTMLInputElement);

    search.value = 'name';
    search.dispatchEvent(new Event('input'));
    expect(query(root, '.tree-count').textContent).toBe('3 件');

    click(root, '.tree-next');
    click(root, '.tree-next');
    click(root, '.tree-next');

    const current = query(root, '.tree-row.is-current');

    expect(current.querySelector('.tree-value')?.textContent).toBe(`"${DANGER}"`);
    query(current, '.tree-copy').click();
    expect(writeText).toHaveBeenCalledWith('$.items[2].name');
  });
});

describe('UC5 正しい JSON を壊すとツリーは前のまま誤りが出る。壊れた JSON の誤りの位置へ移って直す', () => {
  it('壊したあともツリーは前の内容で、誤りパネルに誤りが出る', async () => {
    const root = await start();

    await chooseFiles(root, [new File(['{"a": 1}'], 'ok.json')]);
    pressKey('e');
    insertAtEnd(root, ',');
    // 間引きの 300ms を待たずにツリーへ切り替えても、壊した後の誤りが出る
    pressKey('e');

    expect(texts(root, '.tree-key')).toContain('a');
    expect(query(root, '.errors').textContent).toContain('1 行 9 列：余分な内容があります');
  });

  it('末尾のカンマの位置を示し、項目のクリックでテキストの該当の位置へ移り、直すとツリーが描かれる', async () => {
    const root = await start();

    await chooseFiles(root, [new File(['[1,2,]'], 'broken.json')]);

    expect(texts(root, '.issue-link')).toEqual(['1 行 6 列：末尾のカンマは使えません']);
    expect(query(root, '.body .guide').textContent).toContain('まだ正しく読めていない');

    click(root, '.issue-link');
    expect(query(root, '.body').dataset.view).toBe('text');
    expect(editorOf(root).state.selection.main.head).toBe(5);

    replaceText(root, '[1,2]');
    await vi.waitFor(() => {
      expect(query(root, '.errors').hidden).toBe(true);
    });
    pressKey('e');
    expect(texts(root, '.tree-value')).toContain('1');
  });
});

describe('UC6 JSON を整形・圧縮し、取り消しで戻す', () => {
  it('数値と文字列の書き方が変わらず、インデントが指定どおりで、4 回の取り消しで開いた時の本文に戻る', async () => {
    const root = await start();
    const original = fixtureText('escapes.json');
    // バックスラッシュ＋u0041。ソースに書くと文字に化ける環境があるため組み立てる
    const escaped = `"${String.fromCharCode(92)}u0041"`;
    const keepsNotation = (text: string): boolean =>
      text.includes('12345678901234567890') && text.includes('1.0') && text.includes(escaped);

    await chooseFiles(root, [fixture('escapes.json')]);
    const view = () => editorOf(root);

    runAction(root, 'format-2');
    expect(view().state.sliceDoc(0)).toContain('\n  "big": ');
    expect(keepsNotation(view().state.sliceDoc(0))).toBe(true);
    runAction(root, 'format-4');
    expect(view().state.sliceDoc(0)).toContain('\n    "big": ');
    runAction(root, 'format-tab');
    expect(view().state.sliceDoc(0)).toContain('\n\t"big": ');
    runAction(root, 'minify');
    expect(view().state.sliceDoc(0)).toBe(`{"big":12345678901234567890,"float":1.0,"escaped":${escaped}}`);

    for (let i = 0; i < 4; i += 1) {
      pressKey('z', view().contentDOM);
    }

    expect(view().state.sliceDoc(0)).toBe(original);
  });
});

describe('UC7 JSON5 の設定ファイルを読み、整形の確認でコメントが消えると知る', () => {
  it('ツリーで読め、確認を断ると本文は変わらず、受けるとコメントの消えた整形結果になる', async () => {
    const root = await start();
    const original = fixtureText('config.json5');
    const confirm = vi.spyOn(window, 'confirm');

    await chooseFiles(root, [fixture('config.json5')]);
    expect(texts(root, '.tree-key')).toEqual(['$', 'name', 'list']);

    confirm.mockReturnValueOnce(false);
    runAction(root, 'format-2');
    expect(confirm).toHaveBeenCalledWith('JSON5 の整形・圧縮ではコメントと数値の書き方が失われます。続けますか');
    expect(editorOf(root).state.sliceDoc(0)).toBe(original);

    confirm.mockReturnValueOnce(true);
    runAction(root, 'format-2');
    expect(editorOf(root).state.sliceDoc(0)).toBe("{\n  name: 'app',\n  list: [\n    1,\n    2,\n  ],\n}");
  });
});

describe('UC8 JSON Lines のログを読み、誤りのある行を見つけ、全行のツリーで見て、配列に変換する', () => {
  it('誤りの行を示し、直すまで変換できず、直すと配列と JSON Lines を行き来できる', async () => {
    const root = await start();
    const fixed = fixtureText('log.ndjson').replace('{"id":3,"msg":\n', '{"id":3,"msg":"c"}\n');

    await chooseFiles(root, [fixture('log.ndjson')]);
    expect(query(root, '.body').dataset.view).toBe('rows');
    expect(texts(root, '.rows-item.is-error .rows-line-no')).toEqual(['3']);
    expect(query(root, '.status-errors').textContent).toBe('誤りのある行：1 件');

    pressKey('f');
    expect(query(root, '.body').dataset.view).toBe('tree');
    expect(document.activeElement).toBe(query(root, '.tree-search'));
    expect(query(root, '.tree-excluded').textContent).toBe('誤りのある 1 行を除いた');

    runAction(root, 'to-array');
    await statusShows(root, '誤りのある行があるため変換できません（3 行目）');

    pressKey('e');
    replaceText(root, fixed);
    await vi.waitFor(() => {
      expect(query(root, '.status-errors').textContent).toBe('');
    });
    runAction(root, 'to-array');
    await vi.waitFor(() => {
      expect(query(root, '.doc-title').textContent).toBe('log.json');
    });
    // 元の文書の保存と変換の結果の保存が同じミリ秒になると、一覧の順は決まらない。中身だけを比べる
    expect(docNames(root).sort()).toEqual(['log.json', 'log.ndjson']);

    runAction(root, 'to-lines');
    await vi.waitFor(() => {
      expect(query(root, '.doc-title').textContent).toBe('log.jsonl');
    });
    pressKey('e');
    pressKey('e');
    expect(editorOf(root).state.sliceDoc(0)).toBe(fixed);
  });
});

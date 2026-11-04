// UC1〜3：Markdown を読む・直して保存する・危険な HTML を無害化する（基本 10）

import { describe, expect, it, vi } from 'vitest';

import { chooseFiles, downloadedText, fixture, insertAtEnd, pressKey, query, runAction, start, statusShows, texts } from './app.ts';

describe('UC1 Markdown ファイルを選んで読み、目次とページ内リンクで移動する', () => {
  it('プレビューで開き、目次と本文のリンクで見出しへ移る', async () => {
    const root = await start();

    await chooseFiles(root, [fixture('sample.md')]);

    const preview = query(root, '.preview');

    expect(preview.querySelector('table')).not.toBeNull();
    expect(preview.querySelector('input[type="checkbox"][disabled]')).not.toBeNull();
    expect(preview.querySelector('code .hljs-keyword')).not.toBeNull();
    expect(texts(root, '.toc-link')).toEqual(['見出し1', '見出し2', '見出し3', '見出し4']);
    // sample.md は 180 文字（改行を含む）・25 行。h4 の見出し5 は目次に入れない
    expect(query(root, '.status-counts').textContent).toBe('180 文字・25 行');

    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    const heading2 = query(preview, 'h2');

    query(root, '.toc-item:nth-child(2) .toc-link').click();
    query(preview, 'a[href^="#"]').click();

    expect(scrolled.mock.contexts).toEqual([heading2, heading2]);
  });
});

describe('UC2 CRLF の Markdown を編集＋プレビューで直し、起動し直しても残る', () => {
  it('入力がプレビューに追従し、保存した本文が起動し直しても残り、CRLF のままダウンロードできる', async () => {
    let root = await start();

    await chooseFiles(root, [fixture('crlf.md')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    pressKey('e');
    expect(query(root, '.body').dataset.view).toBe('split');

    insertAtEnd(root, '追記\r\n');
    await vi.advanceTimersByTimeAsync(300);
    await statusShows(root, '保存済み');
    expect(query(root, '.preview').textContent).toContain('追記');
    vi.useRealTimers();

    root = await start();
    await vi.waitFor(() => {
      expect(query(root, '.preview').textContent).toContain('追記');
    });
    pressKey('s');

    expect(await downloadedText()).toBe('# タイトル\r\n\r\n本文\r\n追記\r\n');  });
});

describe('UC3 危険な HTML を含む Markdown を読み、HTML で書き出す', () => {
  function expectSanitized(container: ParentNode): void {
    expect(container.querySelector('script, style, form, label, button, input[type="text"]')).toBeNull();
    expect(container.querySelector('[onerror], [style], [href^="javascript:"]')).toBeNull();
    expect(container.querySelector('#app')).toBeNull();
    expect(container.querySelector('#user-content-app')).not.toBeNull();
    expect(container.querySelector('input.task-list-item-checkbox[type="checkbox"][disabled]')).not.toBeNull();
    expect(container.querySelector('a[href="https://example.com/"]')?.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('a[href="https://example.com/"]')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('a[href^="#"]')?.hasAttribute('target')).toBe(false);
  }

  it('プレビューと書き出しの両方に危険な部分が無く、書き出しの CSP が title より前にある', async () => {
    const root = await start();

    await chooseFiles(root, [fixture('danger.md')]);
    expectSanitized(query(root, '.preview'));

    runAction(root, 'export-html');

    const html = await downloadedText();
    const exported = new DOMParser().parseFromString(html, 'text/html');

    expectSanitized(query(exported, '.markdown-body'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'));
  });

  it('利用者の書いた data-line は、スクロールの連動の印として拾わない', async () => {
    const root = await start();

    await chooseFiles(root, [fixture('danger.md')]);

    const preview = query(root, '.preview');
    const nonce = query(preview, 'h1').dataset.line?.split(':')[0] ?? '';
    const fake = [...preview.querySelectorAll<HTMLElement>('[data-line]')].find((element) => element.textContent === '偽の印');

    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake?.dataset.line?.startsWith(`${nonce}:`)).toBe(false);
  });
});

// 画面の配置の確認。jsdom は配置を計算しないので、テスト（npm test）では確かめられない点を、実際のブラウザで測る。
// 「編集＋プレビュー」で 2 つの欄が並んで枠に収まること、それぞれがスクロールして連動すること、
// ダークのテーマで行番号の欄が暗い色になることを見る。
//
// 使い方：npm run build && npm run preview を動かしたまま、別の端末で npm run check:layout
//   引数で開く URL を変えられる（既定は preview の URL）。例：node scripts/check-layout.mjs https://example.com/md-json-editor/
// Chrome をヘッドレスで起動し、DevTools Protocol で操作する。依存は無い（Node.js の fetch と WebSocket だけ）。
// Chrome は、環境変数 CHROME_PATH があればそれを、無ければ OS ごとの既定の場所を使う。
// 問題が 1 件でもあれば、終了コード 1 で終わる。CI では動かしていない。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_URL = 'http://localhost:4173/md-json-editor/';
const DEFAULT_CHROME_PATHS = {
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux: 'google-chrome',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};
const WINDOW = { width: 1400, height: 900 };

// 画面より長く、1 行も長い文書。長い行で編集側の列が広がらないことも確かめる
const LONG_DOCUMENT = Array.from({ length: 400 }, (_, i) => `## 節 ${i}\n\n本文の段落 ${i}。${'あいうえお'.repeat(20)}\n`).join('\n');
const DOCUMENT_NAME = 'layout-check.md';

/** 表示の切り替えの選択肢の位置（プレビュー、編集＋プレビュー、編集の順）と、テーマの選択肢の位置（OS、ライト、ダークの順） */
const SPLIT_VIEW_INDEX = 1;
const DARK_THEME_INDEX = 2;

/** 並んだ 2 つの欄の幅の差と、枠からのはみ出しとして許す誤差（px） */
const TOLERANCE_PX = 2;

/** 行番号の欄の背景がこれより明るければ、ダークのテーマが効いていないとみなす（0〜255 の平均） */
const DARK_BACKGROUND_MAX = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const url = process.argv[2] ?? DEFAULT_URL;
const chromePath = process.env.CHROME_PATH ?? DEFAULT_CHROME_PATHS[process.platform];
const workDir = mkdtempSync(path.join(tmpdir(), 'layout-check-'));
const documentFile = path.join(workDir, DOCUMENT_NAME);
writeFileSync(documentFile, LONG_DOCUMENT);

const port = 19000 + Math.floor(Math.random() * 900);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(workDir, 'profile')}`,
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** 起動した Chrome のページにつなぐ。つながるまで少し待つ */
async function connectToPage() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === 'page');
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => socket.addEventListener('open', resolve));

        return socket;
      }
    } catch {
      // まだ起動していない
    }
    await sleep(200);
  }
  throw new Error(`Chrome に接続できない（${chromePath}）`);
}

const problems = [];
const expect = (isOk, message, detail) => {
  console.log(`${isOk ? 'ok  ' : 'NG  '}${message}${isOk ? '' : `：${JSON.stringify(detail)}`}`);
  if (!isOk) problems.push(message);
};

try {
  const socket = await connectToPage();
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  const evaluate = async (expression) => {
    const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);

    return result.result.value;
  };
  const selectOption = (selector, index) =>
    evaluate(`(() => { const s = document.querySelector('${selector}'); s.selectedIndex = ${index}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  await send('Emulation.setDeviceMetricsOverride', { ...WINDOW, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(3000);

  // 文書を開いて「編集＋プレビュー」にする
  const { result: input } = await send('Runtime.evaluate', { expression: `document.querySelector('input[type="file"]')` });
  await send('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [documentFile] });
  await sleep(2000);
  expect((await evaluate(`document.querySelector('.doc-title')?.textContent`)) === DOCUMENT_NAME, '文書が開く', url);
  await selectOption('.view-select', SPLIT_VIEW_INDEX);
  await sleep(1500);

  const layout = await evaluate(`(() => {
    const box = (selector) => { const el = document.querySelector(selector); const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height, scrollMax: el.scrollHeight - el.clientHeight }; };
    return { body: box('.main .body'), editor: box('.cm-editor'), scroller: box('.cm-scroller'), preview: box('.preview') };
  })()`);
  expect(Math.abs(layout.editor.width - layout.preview.width) <= TOLERANCE_PX, '編集とプレビューの幅がそろう', layout);
  expect(layout.preview.right <= layout.body.right + TOLERANCE_PX, 'プレビューが枠の右へはみ出さない', layout);
  expect(layout.editor.height <= layout.body.height + TOLERANCE_PX, '編集が枠の高さに収まる', layout);
  expect(layout.preview.height <= layout.body.height + TOLERANCE_PX, 'プレビューが枠の高さに収まる', layout);
  expect(layout.scroller.scrollMax > 0, '編集がスクロールできる', layout);
  expect(layout.preview.scrollMax > 0, 'プレビューがスクロールできる', layout);

  // スクロールの連動
  const scrollTops = `({ editor: document.querySelector('.cm-scroller').scrollTop, preview: document.querySelector('.preview').scrollTop })`;
  await evaluate(`(() => { const e = document.querySelector('.cm-scroller'); e.scrollTop = (e.scrollHeight - e.clientHeight) / 2; })()`);
  await sleep(1500);
  const afterEditorScroll = await evaluate(scrollTops);
  expect(afterEditorScroll.preview > 0, '編集を動かすと、プレビューが動く', afterEditorScroll);
  await evaluate(`(() => { const p = document.querySelector('.preview'); p.scrollTop = (p.scrollHeight - p.clientHeight) * 0.9; })()`);
  await sleep(1500);
  const afterPreviewScroll = await evaluate(scrollTops);
  expect(afterPreviewScroll.editor > afterEditorScroll.editor, 'プレビューを動かすと、編集が動く', afterPreviewScroll);

  // ダークのテーマで、行番号の欄が暗い色になる
  await selectOption('.theme-select', DARK_THEME_INDEX);
  await sleep(500);
  const gutterBackground = await evaluate(`getComputedStyle(document.querySelector('.cm-gutters')).backgroundColor`);
  const [red, green, blue] = gutterBackground.match(/\d+/g).map(Number);
  expect((red + green + blue) / 3 <= DARK_BACKGROUND_MAX, 'ダークのテーマで、行番号の欄が暗い', gutterBackground);

  socket.close();
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (problems.length > 0) {
  console.error(`配置の問題が ${problems.length} 件ある`);
  process.exit(1);
}
console.log('配置の確認：問題なし');

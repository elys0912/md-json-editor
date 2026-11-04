// 本体・誤りパネル・目次・ヘッダ・状態行・文書の一覧の描画と、表示の切替（基本 2、詳細設計 3.8）
// 本体は表示ごとの組み立て（VIEW_BUILDERS）で作り直す。エディタは 1 つを使い回し、テキストを含む表示のときだけ付ける

import { analyze } from './analysis.ts';
import type { Issue } from './analysis.ts';
import { createButton, createElement } from './dom.ts';
import { goTo } from './editor.ts';
import { actionLabel } from './header.ts';
import type { ViewName } from './header.ts';
import { renderMarkdown } from './markdown.ts';
import type { RenderedMarkdown, TocEntry } from './markdown.ts';
import { renderDocList, renderToc } from './side.ts';
import { app, enabledActions, MESSAGES, viewsOf } from './state.ts';
import type { CurrentDoc } from './state.ts';
import { listMeta } from './store.ts';
import { renderRows } from './tree.ts';
import { attachScrollSync, createPreview, renderShapeView, renderTreeView, showProperties } from './views.ts';
import type { PreviewHandle } from './views.ts';

// 誤りパネルに並べる上限。超えた分は「ほか N 件」
const MAX_LISTED_ISSUES = 100;

/** 本文を解析し、読めたら lastGood を替える（json・json5・geojson のときだけ。jsonl は行ごと、markdown は値を持たない） */
export function runAnalysis(doc: CurrentDoc): void {
  const { analysis, value } = analyze(doc.meta.kind, doc.text);

  doc.analysis = analysis;

  if (analysis.isParsed && doc.meta.kind !== 'markdown' && doc.meta.kind !== 'jsonl') {
    doc.lastGood = { value };
  }
}

export function updateHeader(): void {
  const doc = app.current;

  app.header.update({
    meta: doc?.meta ?? null,
    views: doc === null ? [] : viewsOf(doc.meta.kind),
    view: doc?.view ?? null,
    enabled: enabledActions(doc),
  });
}

/** 誤りの項目を開く。構文の誤りはテキスト表示の位置へ、GeoJSON の構造の誤りはツリーのノードへ */
function openIssue(issue: Issue): void {
  if ('path' in issue.target) {
    const { path } = issue.target;

    changeView('tree');
    app.tree?.reveal(path);

    return;
  }

  changeView('text');
  goTo(app.editor, issue.target.line, issue.target.column);
}

function renderIssues(): void {
  const issues = app.current?.analysis.issues ?? [];
  const panel = app.dom.errors;

  panel.hidden = issues.length === 0;

  if (issues.length === 0) {
    panel.replaceChildren();

    return;
  }

  const list = createElement('ul', 'issue-list');

  for (const issue of issues.slice(0, MAX_LISTED_ISSUES)) {
    const item = createElement('li', `issue is-${issue.level}`);

    item.append(
      createButton('issue-link', issue.label, () => {
        openIssue(issue);
      }),
    );
    list.append(item);
  }

  const rest = issues.length - MAX_LISTED_ISSUES;

  panel.replaceChildren(createElement('h2', 'issue-heading', MESSAGES.issueHeading(issues.length)), list);

  if (rest > 0) {
    panel.append(createElement('p', 'issue-rest', MESSAGES.issueRest(rest)));
  }
}

function selectToc(entry: TocEntry): void {
  const doc = app.current;
  const nonce = doc?.analysis.rendered?.nonce ?? '';

  app.dom.body.querySelector(`[data-toc="${nonce}:${entry.index}"]`)?.scrollIntoView({ block: 'start' });

  if (doc?.view === 'split') {
    goTo(app.editor, entry.line, 1);
  }
}

/** 解析の結果から作るもの（目次・誤りパネル・状態行・ヘッダ）を描き直す */
export function updateDerived(): void {
  const doc = app.current;
  const hasPreview = doc?.view === 'preview' || doc?.view === 'split';

  renderToc(app.dom.toc, hasPreview ? (doc.analysis.rendered?.toc ?? null) : null, selectToc);
  renderIssues();
  app.status.setCounts(doc?.text ?? null);
  app.status.setErrors(doc?.analysis.errorSummary ?? '');
  updateHeader();
}

/** 保存欄の表示。版の更新で閉じたとき・メモリだけのときはその旨を出し続ける */
export function setSaveStatus(): void {
  if (app.isClosedByNewVersion) {
    app.status.setSave(MESSAGES.versionChanged);
  } else if (app.isInMemory) {
    app.status.setSave(MESSAGES.memoryOnly);
  } else if (app.current === null) {
    app.status.setSave('');
  } else {
    app.status.setSave(app.hasSaveFailed ? MESSAGES.saveFailed : MESSAGES.saved);
  }
}

export async function refreshList(): Promise<void> {
  app.metas = await listMeta();
  renderDocList(app.dom.docs, app.metas, app.current?.meta.id ?? null, {
    persistent: app.isPersistent || app.isInMemory,
    handlers: { open: app.handlers.openById, remove: app.handlers.removeDoc, removeAll: app.handlers.removeAll },
  });
}

// markdown の解析は常に rendered を持つ。種別を変えた直後など無いときだけ描き直す
function renderedOf(doc: CurrentDoc): RenderedMarkdown {
  return doc.analysis.rendered ?? renderMarkdown(doc.text);
}

function showPreview(doc: CurrentDoc): PreviewHandle {
  app.preview = createPreview(renderedOf(doc));

  return app.preview;
}

/** ツリーに出す値。JSON Lines は誤りのない行の値の配列、ほかは最後に正しく読めた値（まだ無ければ undefined） */
function treeValueOf(doc: CurrentDoc): unknown {
  if (doc.meta.kind !== 'jsonl') {
    return doc.lastGood?.value;
  }

  return doc.analysis.lines?.flatMap((line) => ('value' in line ? [line.value] : []));
}

function buildTreeView(doc: CurrentDoc): Node[] {
  const brokenCount = doc.analysis.lines?.filter((line) => 'error' in line).length ?? 0;
  const tree = renderTreeView(treeValueOf(doc), brokenCount, () => {
    app.status.notify(MESSAGES.partlyExpanded);
  });

  app.tree = tree.handle;

  return [tree.element];
}

function buildRowsView(doc: CurrentDoc): Node[] {
  const container = createElement('div', 'rows-view');

  renderRows(container, doc.analysis.lines ?? []);

  return [container];
}

function buildShapeView(doc: CurrentDoc): Node[] {
  const panel = app.dom.properties;

  panel.hidden = false;
  panel.append(createElement('p', 'guide', MESSAGES.shapeGuide));

  return [
    renderShapeView(doc.lastGood, doc.analysis.errorFeatures, (properties, path) => {
      showProperties(panel, properties, path);
    }),
  ];
}

const VIEW_BUILDERS: Readonly<Record<ViewName, (doc: CurrentDoc) => Node[]>> = {
  preview: (doc) => [showPreview(doc).element],
  split: (doc) => {
    const preview = showPreview(doc);

    attachScrollSync(preview, app.editor, app.viewEvents.signal);

    return [app.editor.dom, preview.element];
  },
  edit: () => [app.editor.dom],
  text: () => [app.editor.dom],
  tree: buildTreeView,
  rows: buildRowsView,
  shape: buildShapeView,
};

function renderEmpty(): void {
  const guide = createElement('div', 'empty');

  guide.append(
    createElement('p', 'guide', MESSAGES.emptyGuide),
    createButton('empty-open', actionLabel('open-file'), () => {
      app.handlers.runAction('open-file');
    }),
    createButton('empty-new-markdown', actionLabel('new-markdown'), () => {
      app.handlers.runAction('new-markdown');
    }),
    createButton('empty-new-json', actionLabel('new-json'), () => {
      app.handlers.runAction('new-json');
    }),
  );
  app.dom.body.replaceChildren(guide);
}

/** 本体を作り直す。前の表示のイベント（スクロールの連動など）は外す */
export function renderBody(): void {
  const doc = app.current;
  const body = app.dom.body;

  app.viewEvents.abort();
  app.viewEvents = new AbortController();
  app.tree = null;
  app.preview = null;
  app.dom.properties.hidden = true;
  app.dom.properties.replaceChildren();

  if (doc === null) {
    delete body.dataset.view;
    renderEmpty();
  } else {
    body.dataset.view = doc.view;
    body.replaceChildren(...VIEW_BUILDERS[doc.view](doc));
  }

  updateDerived();
}

/** 解析し直して、解析から作るものとプレビューを更新する（編集の間引きの後） */
export function applyAnalysis(doc: CurrentDoc): void {
  runAnalysis(doc);
  updateDerived();

  if (doc.view === 'split') {
    app.preview?.update(renderedOf(doc));
  }
}

export function changeView(view: ViewName): void {
  const doc = app.current;

  if (doc === null || doc.view === view) {
    return;
  }

  // 間引き中の編集を先に解析し、古い内容で描かない
  app.handlers.settlePendingEdit();
  doc.view = view;
  renderBody();
}

export function cycleView(): void {
  const doc = app.current;

  if (doc === null) {
    return;
  }

  const views = viewsOf(doc.meta.kind);

  changeView(views[(views.indexOf(doc.view) + 1) % views.length] ?? doc.view);
}

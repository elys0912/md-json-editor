// Markdown → 無害化済みの HTML、目次の抽出、単体の HTML の書き出し（詳細設計 3.3、F2-3〜F2-6）
// innerHTML に入れてよいのは renderMarkdown の html だけ（DOMPurify 済み。N2-4）

import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import MarkdownIt from 'markdown-it';
import type { StateCore } from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

import exportCss from './export.css?raw';

export interface TocEntry {
  readonly level: 1 | 2 | 3;
  readonly text: string;
  // GitHub と同じ作り方のアンカー名。ページ内リンク（`#…`）の照合に使う
  readonly slug: string;
  // data-toc の連番
  readonly index: number;
  // 見出しの行（1 始まり）
  readonly line: number;
}

export interface RenderedMarkdown {
  readonly html: string;
  // data-line・data-toc の値の頭に付ける印。利用者の HTML の同名の属性と区別する
  readonly nonce: string;
  readonly toc: readonly TocEntry[];
}

// 色付けする言語（よく使うものだけ。未登録・指定なしは色付けしない）
const LANGUAGES = { bash, css, diff, java, javascript, json, markdown: markdownLanguage, python, sql, typescript, xml, yaml };

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

// 目次に入れる見出しの段
const TOC_LEVELS: Readonly<Record<string, TocEntry['level']>> = { h1: 1, h2: 2, h3: 3 };

// DOMPurify の既定の許可リストから、さらに除くもの（F2-4）
const FORBID_TAGS = [
  'style',
  'form',
  'button',
  'textarea',
  'select',
  'option',
  'optgroup',
  'label',
  'fieldset',
  'legend',
  'output',
  'datalist',
  'meter',
  'progress',
];
const FORBID_ATTR = ['style', 'action', 'formaction'];
const TASK_CHECKBOX_CLASS = 'task-list-item-checkbox';
const EXTERNAL_LINK_PATTERN = /^https?:/i;

// 書き出す HTML の CSP。外部画像だけ許し、スクリプトとフォームの送信を禁じる
const EXPORT_CSP = "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

// markdown-it の env（文字列のキーの辞書）として渡すので、interface でなく type にする（interface は索引の型に代入できない）
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type RenderEnv = {
  readonly nonce: string;
  readonly toc: TocEntry[];
};

/** 見出しの文字からアンカー名を作る（GitHub と同じ）。`\w` は日本語を消すので Unicode の文字・数字のクラスを使う。例：`Hello World!` → `hello-world` */
export function slugify(text: string, used: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  const count = used.get(base) ?? 0;

  used.set(base, count + 1);

  return count === 0 ? base : `${base}-${count}`;
}

/** ブロックのトークンに元の行（data-line）と、見出し h1〜h3 に目次の連番（data-toc）を付ける core のルール */
function markSourceLines(state: StateCore): void {
  const env = state.env as RenderEnv;
  const usedSlugs = new Map<string, number>();

  state.tokens.forEach((token, i) => {
    if (token.map === null || token.nesting === -1) {
      return;
    }

    const line = token.map[0] + 1;

    token.attrSet('data-line', `${env.nonce}:${line}`);

    const level = token.type === 'heading_open' ? TOC_LEVELS[token.tag] : undefined;

    if (level === undefined) {
      return;
    }

    const inline = state.tokens[i + 1];
    const text = (inline?.children ?? [])
      .filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content)
      .join('');
    const index = env.toc.length;

    token.attrSet('data-toc', `${env.nonce}:${index}`);
    env.toc.push({ level, text, slug: slugify(text, usedSlugs), index, line });
  });
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight: (code, language) => (hljs.getLanguage(language) === undefined ? '' : hljs.highlight(code, { language, ignoreIllegals: true }).value),
});

md.use(taskLists, { enabled: false });
md.core.ruler.push('source_lines', markSourceLines);

// フックはモジュールの読込時に 1 回だけ登録する
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'input' || !(node instanceof Element)) {
    return;
  }

  // タスクリストの操作できないチェックボックスだけを残す
  const isTaskCheckbox =
    node.getAttribute('type')?.toLowerCase() === 'checkbox' && node.hasAttribute('disabled') && node.classList.contains(TASK_CHECKBOX_CLASS);

  if (!isTaskCheckbox) {
    node.remove();
  }
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof HTMLAnchorElement && EXTERNAL_LINK_PATTERN.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR, SANITIZE_NAMED_PROPS: true });
}

export function renderMarkdown(text: string): RenderedMarkdown {
  const env: RenderEnv = { nonce: crypto.randomUUID(), toc: [] };
  const html = sanitize(md.render(text, env));

  return { html, nonce: env.nonce, toc: env.toc };
}

/** スタイル込みの単体の HTML 文書。CSP の meta を title より前に置く。ページ内リンクは見出しへ飛ばない（既知の制限） */
export function exportHtml(name: string, text: string): string {
  const { html } = renderMarkdown(text);

  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${md.utils.escapeHtml(name)}</title>`,
    `<style>${exportCss}</style>`,
    '</head>',
    '<body>',
    `<article class="markdown-body">${html}</article>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

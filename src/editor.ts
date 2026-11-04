// CodeMirror の生成、本文・言語・改行の差し替え、誤りの位置への移動（詳細設計 3.7）
// 改行は CodeMirror の既定では LF にそろうので、lineSeparator を入れて sliceDoc(0) で元の改行のまま取り出す（F1-7）

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';

import type { Eol } from './json.ts';
import type { Kind } from './store.ts';

type ChangeListener = (text: string) => void;

// 色は style.css の CSS 変数で与える（ライト・ダーク共通）
const highlightStyle = HighlightStyle.define([
  { tag: [tags.heading], color: 'var(--syntax-heading)', fontWeight: 'bold' },
  { tag: [tags.strong], fontWeight: 'bold' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--syntax-link)' },
  { tag: [tags.propertyName], color: 'var(--syntax-key)' },
  { tag: [tags.string], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-literal)' },
  { tag: [tags.comment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.monospace, tags.processingInstruction], color: 'var(--syntax-code)' },
]);

// setDocument で拡張を作り直すときに使う。エディタは画面に 1 つだけ
const listeners = new WeakMap<EditorView, ChangeListener>();

function buildExtensions(kind: Kind, eol: Eol, onChange: ChangeListener): Extension[] {
  return [
    lineNumbers(),
    history(),
    search({ top: true }),
    highlightSelectionMatches(),
    bracketMatching(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    // json5 もコメント部分の色が崩れるだけなので JSON の言語で色付けする
    kind === 'markdown' ? markdown() : json(),
    syntaxHighlighting(highlightStyle),
    EditorState.lineSeparator.of(eol),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChange(update.state.sliceDoc(0));
      }
    }),
  ];
}

export function createEditor(parent: HTMLElement, onChange: ChangeListener): EditorView {
  const view = new EditorView({ parent, state: EditorState.create({ extensions: buildExtensions('markdown', '\n', onChange) }) });

  listeners.set(view, onChange);

  return view;
}

/** 本文・言語・改行を差し替える。CodeMirror 6 には履歴だけを消す API が無いので、状態を作り直す（取り消しの履歴も消える） */
export function setDocument(view: EditorView, text: string, kind: Kind, eol: Eol): void {
  const onChange = listeners.get(view) ?? (() => undefined);

  view.setState(EditorState.create({ doc: text, extensions: buildExtensions(kind, eol, onChange) }));
}

/** 行・列（1 始まり）へカーソルを移してスクロールする。範囲の外は端に寄せる */
export function goTo(view: EditorView, line: number, column: number): void {
  const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
  const position = target.from + Math.min(Math.max(0, column - 1), target.length);

  view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  view.focus();
}

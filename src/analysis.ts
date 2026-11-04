// 文書の本文の解析：種別ごとに解析し、誤りパネルと状態行に出す誤り・注意をまとめる（基本 6-2・6-3、4 章の文言）

import { validateGeoJson } from './geojson.ts';
import { describeLineError, parse, parseLines } from './json.ts';
import type { JsonlLine, SingleValueKind } from './json.ts';
import { renderMarkdown } from './markdown.ts';
import type { RenderedMarkdown } from './markdown.ts';
import type { Kind } from './store.ts';

export interface Issue {
  readonly label: string;
  readonly level: 'error' | 'warning';
  // テキストの位置（構文の誤り）か、ツリーのパス（GeoJSON の構造）
  readonly target: { readonly line: number; readonly column: number } | { readonly path: string };
}

export interface Analysis {
  readonly issues: readonly Issue[];
  // 状態行に出す件数。誤りが無ければ空
  readonly errorSummary: string;
  // 値として読めた（jsonl と markdown は常に true）
  readonly isParsed: boolean;
  readonly rendered: RenderedMarkdown | null;
  readonly lines: readonly JsonlLine[] | null;
  // 誤りのある GeoJSON の Feature のパス。図形では描かない
  readonly errorFeatures: ReadonlySet<string>;
}

export const EMPTY_ANALYSIS: Analysis = { issues: [], errorSummary: '', isParsed: true, rendered: null, lines: null, errorFeatures: new Set<string>() };

const SINGLE_ERROR_SUMMARY = '誤り 1 件';
// 入れ子が深く、解析や検証が再帰の深さの上限（RangeError）に達したとき。位置は先頭を指す
const NESTING_TOO_DEEP_LABEL = '1 行 1 列：入れ子が深すぎるため読めません';

function parseErrorIssue(label: string, line: number, column: number): Issue {
  return { label, level: 'error', target: { line, column } };
}

/** 読めなかった本文の解析結果。誤りは位置つきの 1 件 */
function unreadableAnalysis(label: string, line: number, column: number): Analysis {
  return { ...EMPTY_ANALYSIS, issues: [parseErrorIssue(label, line, column)], errorSummary: SINGLE_ERROR_SUMMARY, isParsed: false };
}

function analyzeSingleValue(kind: SingleValueKind, text: string): { analysis: Analysis; value?: unknown } {
  const parsed = parse(kind, text);

  if (!parsed.ok) {
    const { line, column, message } = parsed.error;
    return { analysis: unreadableAnalysis(`${line} 行 ${column} 列：${message}`, line, column) };
  }

  if (kind !== 'geojson') {
    return { analysis: EMPTY_ANALYSIS, value: parsed.value };
  }

  const geo = validateGeoJson(parsed.value);
  const issues = geo.issues.map((issue): Issue => ({
    label: `${issue.level === 'warning' ? '注意 ' : ''}${issue.path}：${issue.message}`,
    level: issue.level,
    target: { path: issue.path },
  }));
  const errorCount = geo.issues.filter((issue) => issue.level === 'error').length;
  const warningCount = geo.issues.length - errorCount;
  const errorSummary = geo.issues.length === 0 ? '' : `誤り ${errorCount} 件・注意 ${warningCount} 件`;

  return { analysis: { ...EMPTY_ANALYSIS, issues, errorSummary, errorFeatures: geo.errorFeatures }, value: parsed.value };
}

function analyzeBody(kind: Kind, text: string): { analysis: Analysis; value?: unknown } {
  if (kind === 'markdown') {
    return { analysis: { ...EMPTY_ANALYSIS, rendered: renderMarkdown(text) } };
  }

  if (kind !== 'jsonl') {
    return analyzeSingleValue(kind, text);
  }

  const lines = parseLines(text);
  const issues = lines.flatMap((line) =>
    'error' in line ? [parseErrorIssue(describeLineError(line.lineNo, line.error), line.lineNo, line.error.column)] : [],
  );

  return { analysis: { ...EMPTY_ANALYSIS, lines, issues, errorSummary: issues.length === 0 ? '' : `誤りのある行：${issues.length} 件` } };
}

/** 本文を解析する。json・json5・geojson で読めたときは value に値を返す。入れ子が深すぎて解析や検証が RangeError になったときは、誤り 1 件として返す */
export function analyze(kind: Kind, text: string): { analysis: Analysis; value?: unknown } {
  try {
    return analyzeBody(kind, text);
  } catch (error) {
    if (error instanceof RangeError) {
      return { analysis: unreadableAnalysis(NESTING_TOO_DEEP_LABEL, 1, 1) };
    }

    throw error;
  }
}

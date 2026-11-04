// JSON・JSON5・JSON Lines の解析（誤りの行・列つき）、整形・圧縮、配列 ⇔ JSON Lines の変換（詳細設計 3.4）
// 行・列は 1 始まり。整形・圧縮は値を JSON.parse → JSON.stringify で通さない（2^53 超の整数、`1.0`、`"\u0041"` の書き方を保つ）

import { applyEdits, createScanner, format as formatEdits, parse as parseTolerant, parseTree, printParseErrorCode } from 'jsonc-parser';
import type { ParseError as JsoncParseError } from 'jsonc-parser';
import JSON5 from 'json5';

import type { Kind } from './store.ts';

export interface ParseError {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ParseError };

export type JsonlLine = { readonly lineNo: number; readonly value: unknown } | { readonly lineNo: number; readonly error: ParseError };

/** 1 つの値を持つ種別（jsonl と markdown 以外） */
export type SingleValueKind = Extract<Kind, 'json' | 'json5' | 'geojson'>;

export type Indent = 2 | 4 | '\t';
export type Eol = '\n' | '\r\n';

// jsonc-parser の SyntaxKind の値。const enum は isolatedModules では参照できないため、使う値だけ写す
const TOKEN_COMMA = 5;
const TOKEN_CLOSE_BRACE = 2;
const TOKEN_CLOSE_BRACKET = 4;
const TOKEN_EOF = 17;

// jsonc-parser の誤りの種類（printParseErrorCode の名前）→ 4 章の文言
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ValueExpected: '値がありません',
  CommaExpected: 'カンマがありません',
  CloseBraceExpected: '} がありません',
  CloseBracketExpected: '] がありません',
  ColonExpected: ': がありません',
  PropertyNameExpected: 'キーがありません',
  UnexpectedEndOfString: '文字列が閉じていません',
  EndOfFileExpected: '余分な内容があります',
  InvalidCommentToken: 'コメントは使えません（JSON5 として開くには種別を変更）',
  InvalidSymbol: 'JSON では使えない書き方です（単引用符・NaN など。JSON5 として開くには種別を変更）',
  InvalidEscapeCharacter: '不正なエスケープです',
  InvalidUnicode: '不正な \\u の書き方です',
  InvalidNumberFormat: '数値の書き方が違います',
  InvalidCharacter: '文字列に使えない文字があります',
};
const TRAILING_COMMA_MESSAGE = '末尾のカンマは使えません';
const OTHER_ERROR_MESSAGE = '構文の誤りです';

export const NOT_ARRAY_MESSAGE = '最上位が配列ではないため変換できません';

/** 文字列の offset（0 始まり）を 1 始まりの行・列に直す */
function toLineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;

  return { line: before.split('\n').length, column: offset - lineStart + 1 };
}

/**
 * 末尾のカンマか。jsonc-parser に種類が無いので、誤りの位置のトークンが `]` か `}` で、その前のトークンが `,` のときとする。
 * 例：`[1,2,]` は当たる。`[1,,2]` は位置のトークンが `,` なので当たらない
 */
function isTrailingComma(text: string, offset: number): boolean {
  const scanner = createScanner(text, true);
  let previous: number | undefined;

  for (let token: number = scanner.scan(); token !== TOKEN_EOF; token = scanner.scan()) {
    if (scanner.getTokenOffset() === offset) {
      return previous === TOKEN_COMMA && (token === TOKEN_CLOSE_BRACKET || token === TOKEN_CLOSE_BRACE);
    }

    previous = token;
  }

  return false;
}

function describeJsonError(text: string, error: JsoncParseError): string {
  const name = printParseErrorCode(error.error);
  const mayBeTrailingComma = name === 'ValueExpected' || name === 'PropertyNameExpected';

  if (mayBeTrailingComma && isTrailingComma(text, error.offset)) {
    return TRAILING_COMMA_MESSAGE;
  }

  return ERROR_MESSAGES[name] ?? OTHER_ERROR_MESSAGE;
}

/** JSON として解析する。JSON.parse の文言はブラウザごとに違うので、誤りは jsonc-parser で取り直す */
function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const errors: JsoncParseError[] = [];

    parseTolerant(text, errors, { disallowComments: true, allowTrailingComma: false });

    const first = errors[0];

    if (first === undefined) {
      return { ok: false, error: { line: 1, column: 1, message: OTHER_ERROR_MESSAGE } };
    }

    return { ok: false, error: { ...toLineColumn(text, first.offset), message: describeJsonError(text, first) } };
  }
}

function parseJson5(text: string): Parsed {
  try {
    return { ok: true, value: JSON5.parse(text) };
  } catch (error) {
    // json5 の SyntaxError は lineNumber と columnNumber を持つ。columnNumber は 0 になる場合がある
    const { lineNumber, columnNumber, message } = error as SyntaxError & { lineNumber?: number; columnNumber?: number };

    return {
      ok: false,
      error: { line: lineNumber ?? 1, column: Math.max(1, columnNumber ?? 1), message: `JSON5 として読めません（${message}）` },
    };
  }
}

export function parse(kind: SingleValueKind, text: string): Parsed {
  return kind === 'json5' ? parseJson5(text) : parseJson(text);
}

/** JSON Lines の空白だけでない行。lineNo は元の行の番号 */
function splitJsonLines(text: string): { lineNo: number; text: string }[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ lineNo: index + 1, text: line }))
    .filter((line) => line.text.trim() !== '');
}

/** JSON Lines を行ごとに解析する。空白だけの行は飛ばす。列は行の中の位置 */
export function parseLines(text: string): JsonlLine[] {
  return splitJsonLines(text).map((line) => {
    const parsed = parseJson(line.text);

    return parsed.ok ? { lineNo: line.lineNo, value: parsed.value } : { lineNo: line.lineNo, error: parsed.error };
  });
}

/** JSON の空白を除く。トークンの元の文字列をつなぐ（getTokenValue はエスケープを解くので使わない） */
function minifyJson(text: string): string {
  const scanner = createScanner(text, true);
  const tokens: string[] = [];

  for (let token: number = scanner.scan(); token !== TOKEN_EOF; token = scanner.scan()) {
    tokens.push(text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
  }

  return tokens.join('');
}

function replaceEol(text: string, eol: Eol): string {
  return text.replace(/\r?\n/g, eol);
}

/** 整形。json・geojson は解析に成功しているときだけ呼ぶ。json5 はコメントと数値の書き方が失われる（確認は呼び出し側） */
export function format(kind: SingleValueKind, text: string, indent: Indent, eol: Eol): string {
  if (kind === 'json5') {
    return replaceEol(JSON5.stringify(JSON5.parse(text), null, indent), eol);
  }

  const insertSpaces = indent !== '\t';
  const edits = formatEdits(text, undefined, { insertSpaces, tabSize: insertSpaces ? indent : 1, eol });

  return applyEdits(text, edits);
}

/** 圧縮。jsonl は誤りのない行だけを行ごとに圧縮し、誤りのある行と空行は元のまま残す */
export function minify(kind: Exclude<Kind, 'markdown'>, text: string, eol: Eol): string {
  if (kind === 'json5') {
    return JSON5.stringify(JSON5.parse(text));
  }

  if (kind !== 'jsonl') {
    return minifyJson(text);
  }

  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() !== '' && parseJson(line).ok ? minifyJson(line) : line))
    .join(eol);
}

/** JSON の配列を JSON Lines にする。要素ごとに圧縮し、末尾にも改行を 1 つ付ける（JSON Lines の慣例）。最上位が配列でなければ例外 */
export function arrayToLines(text: string, eol: Eol): string {
  const root = parseTree(text);

  if (root?.type !== 'array') {
    throw new Error(NOT_ARRAY_MESSAGE);
  }

  return (root.children ?? []).map((element) => minifyJson(text.slice(element.offset, element.offset + element.length)) + eol).join('');
}

/** JSON Lines を JSON の配列にする（インデント 2 で整形）。誤りのある行が 1 つでもあれば例外 */
export function linesToArray(text: string, eol: Eol): string {
  const lines = splitJsonLines(text);
  const broken = lines.find((line) => !parseJson(line.text).ok);

  if (broken !== undefined) {
    throw new Error(`誤りのある行があるため変換できません（${broken.lineNo} 行目）`);
  }

  return format('json', `[${lines.map((line) => line.text).join(',')}]`, 2, eol);
}

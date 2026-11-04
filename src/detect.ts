// ファイル名と内容から種別を決める（基本 5「種別の判定」、詳細設計 3.2）
// 例：`a.json` で `{"type":"FeatureCollection",…}` → geojson。拡張子なしの `{a:1}` → json5（案内つき）。拡張子なしの `# 見出し` → markdown

import JSON5 from 'json5';

import { GEOJSON_TYPES } from './geojson.ts';
import type { Kind } from './store.ts';

const KIND_BY_EXTENSION: Readonly<Record<string, Kind>> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'markdown',
  json5: 'json5',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  geojson: 'geojson',
};

export const JSON5_NOTE = 'JSON5 として開きました。JSON のつもりなら種別を変更してください';

// これを超える本文（文字数）は、JSON Lines と JSON5 の試行を先頭の行だけで判断する（全文の試行は重いため）
const LARGE_TEXT_LENGTH = 5 * 1024 * 1024;
const LARGE_TEXT_SAMPLE_LINES = 100;

// JSON Lines と推定するのに要る、空でない行の数
const MIN_JSONL_LINES = 2;

/** 解釈できれば値、できなければ undefined を返す。JSON の値に undefined は無いので区別できる */
function tryParse(parser: (text: string) => unknown, text: string): unknown {
  try {
    return parser(text);
  } catch {
    return undefined;
  }
}

function isObjectOrArray(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isGeoJson(value: unknown): boolean {
  if (!isObjectOrArray(value) || Array.isArray(value) || !('type' in value)) {
    return false;
  }

  return GEOJSON_TYPES.some((type) => type === value.type);
}

function extensionOf(name: string | null): string | undefined {
  const dot = name?.lastIndexOf('.') ?? -1;

  return dot < 0 ? undefined : name?.slice(dot + 1).toLowerCase();
}

function looksLikeJsonLines(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');

  return lines.length >= MIN_JSONL_LINES && lines.every((line) => isObjectOrArray(tryParse(JSON.parse, line)));
}

/** 拡張子が無い・不明（貼り付けを含む）ときに内容で推定する */
function detectByContent(text: string): { kind: Kind; note?: string } {
  const json = tryParse(JSON.parse, text);

  if (isObjectOrArray(json)) {
    return { kind: isGeoJson(json) ? 'geojson' : 'json' };
  }

  const sample = text.length > LARGE_TEXT_LENGTH ? text.split(/\r?\n/, LARGE_TEXT_SAMPLE_LINES).join('\n') : text;

  if (looksLikeJsonLines(sample)) {
    return { kind: 'jsonl' };
  }

  // 末尾のカンマのある壊れた JSON もここに来るので、案内を添える
  if (isObjectOrArray(tryParse(JSON5.parse, sample))) {
    return { kind: 'json5', note: JSON5_NOTE };
  }

  return { kind: 'markdown' };
}

export function detectKind(name: string | null, text: string): { kind: Kind; note?: string } {
  const extension = extensionOf(name);

  if (extension === 'json') {
    // 解釈に失敗したときは json のまま開き、誤りを示す
    return { kind: isGeoJson(tryParse(JSON.parse, text)) ? 'geojson' : 'json' };
  }

  const byExtension = extension === undefined ? undefined : KIND_BY_EXTENSION[extension];

  return byExtension === undefined ? detectByContent(text) : { kind: byExtension };
}

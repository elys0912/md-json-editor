// ファイルの読込（UTF-8 だけ、50 MB まで）とダウンロード、文書の名前の組み立て（基本 5「読込」、F1-1・F1-5・F1-7）

import { getText } from './store.ts';
import type { Meta } from './store.ts';

const BYTES_PER_MB = 1024 * 1024;
// 開けるファイルの上限（F1-7）
const MAX_FILE_BYTES = 50 * BYTES_PER_MB;

// ダウンロード用の URL を解放するまでの時間。ダウンロードの開始は非同期で、保存先の確認が出る場合もあるため、読み終えるまで 1 分待つ
const REVOKE_URL_DELAY_MS = 60_000;

// 'read' はファイルの読込そのものの失敗（ファイルが消された・権限がないなど）
export type ReadFailureReason = 'utf8' | 'size' | 'read';

const REASON_TEXTS: Readonly<Record<ReadFailureReason, string>> = {
  utf8: 'UTF-8 ではありません',
  size: `大きすぎます（上限 ${MAX_FILE_BYTES / BYTES_PER_MB} MB）`,
  read: '読み込めませんでした',
};

export interface ReadFailure {
  readonly name: string;
  readonly reason: ReadFailureReason;
}

/** 拡張子を替えた名前。拡張子が無ければ足す。例：`a.json` と md → `a.md` */
export function replaceExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');

  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/** 同名があれば「無題 2.md」のように番号を付ける */
export function uniqueName(name: string, existingNames: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;

  for (let n = 2; existingNames.has(candidate); n += 1) {
    candidate = `${base} ${n}${extension}`;
  }

  return candidate;
}

export async function readFile(file: File): Promise<{ ok: true; text: string } | { ok: false; reason: ReadFailureReason }> {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: 'size' };
  }

  const buffer = await file.arrayBuffer().catch(() => null);

  if (buffer === null) {
    return { ok: false, reason: 'read' };
  }

  try {
    // TextDecoder は既定で先頭の BOM を除く。改行は変えない
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
  } catch {
    return { ok: false, reason: 'utf8' };
  }
}

/** 同じ名前で本文も同じ文書があれば、その meta を返す（F1-1）。名前と大きさで絞ってから本文を比べる */
export async function findSameDoc(metas: readonly Meta[], name: string, text: string): Promise<Meta | undefined> {
  const size = new TextEncoder().encode(text).length;

  for (const meta of metas.filter((candidate) => candidate.name === name && candidate.size === size)) {
    if ((await getText(meta.id)) === text) {
      return meta;
    }
  }

  return undefined;
}

/** 開けなかったファイルの知らせ。1 件だけ選んだときと、複数を選んだときで形を変える（4 章「読込の失敗」） */
export function describeFailures(failures: readonly ReadFailure[], isSingleFile: boolean): string {
  const [first] = failures;

  if (isSingleFile && first !== undefined) {
    return first.reason === 'size' ? `「${first.name}」は${REASON_TEXTS.size}` : `「${first.name}」を開けません（${REASON_TEXTS[first.reason]}）`;
  }

  return `${failures.length} 件を開けませんでした：${failures.map((failure) => `${failure.name}（${REASON_TEXTS[failure.reason]}）`).join('、')}`;
}

export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');

  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_URL_DELAY_MS);
}

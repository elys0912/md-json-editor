// 値の中の位置を表すパスの書き方。ツリーと GeoJSON の検証・描画が同じ形を使う（誤りパネルからツリーのノードへ移るため）
// 例：`$.items[2].name`、識別子にならないキーは `$["a b"]`

export type PathKey = string | number;

// パスの起点（文書全体）
export const ROOT_PATH = '$';

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

export function childPath(parent: string, key: PathKey): string {
  if (typeof key === 'number') {
    return `${parent}[${key}]`;
  }

  return IDENTIFIER_PATTERN.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

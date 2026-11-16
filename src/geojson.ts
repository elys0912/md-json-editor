// GeoJSON の構造の検証（RFC 7946、F5-5、詳細設計 3.6）。描画は geojson-view.ts
// 誤り（MUST に反する）のある Feature は描かない。注意の Feature は描く

import { childPath, ROOT_PATH } from './path.ts';

export const GEOJSON_TYPES = [
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
  'Feature',
  'FeatureCollection',
] as const;

const GEOMETRY_TYPES: readonly string[] = GEOJSON_TYPES.filter((type) => type !== 'Feature' && type !== 'FeatureCollection');

export interface GeoIssue {
  readonly path: string;
  readonly level: 'error' | 'warning';
  readonly message: string;
}

// 位置の数値の個数。2 個未満は誤り、4 個以上は注意（RFC 7946 3.1.1 は 3 個までを勧める）
const MIN_POSITION_VALUES = 2;
const MAX_RECOMMENDED_POSITION_VALUES = 3;
const MIN_LINE_POSITIONS = 2;
const MIN_RING_POSITIONS = 4;
export const LONGITUDE_LIMIT = 180;
export const LATITUDE_LIMIT = 90;

export type Position = readonly number[];

/** 検証の途中の状態。誤りのある Feature のパスは、Feature の中のどこで誤りが出ても Feature の単位で集める */
interface Validation {
  readonly issues: GeoIssue[];
  readonly errorFeatures: Set<string>;
  featurePath: string | null;
}

/** ジオメトリ 1 つ分の注意の数。範囲外・数値の個数・向きの注意は、ジオメトリの単位で 1 件にまとめる */
interface WarningCounts {
  outOfRange: number;
  extraValues: number;
  wrongWinding: boolean;
}

/** これから検証するジオメトリ（GeometryCollection の子） */
interface PendingGeometry {
  readonly path: string;
  readonly geometry: unknown;
}

/** FeatureCollection の i 番目の Feature のパス。検証と描画で同じ形を使う */
export function featurePath(index: number): string {
  return childPath(childPath(ROOT_PATH, 'features'), index);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  // `1e999` は Infinity になるので、isFinite で外す
  return typeof value === 'number' && Number.isFinite(value);
}

function addError(state: Validation, path: string, message: string): void {
  state.issues.push({ path, level: 'error', message });

  if (state.featurePath !== null) {
    state.errorFeatures.add(state.featurePath);
  }
}

function addWarning(state: Validation, path: string, message: string): void {
  state.issues.push({ path, level: 'warning', message });
}

/** 位置の検証。誤りなら addError して false を返す。範囲外・4 個以上は counts に数え、呼び出し側がまとめて注意にする */
function checkPosition(state: Validation, path: string, value: unknown, counts: WarningCounts): value is Position {
  if (!Array.isArray(value) || value.length < MIN_POSITION_VALUES) {
    addError(state, path, '位置は 2 個以上の数値の配列にします');

    return false;
  }

  if (!value.every(isFiniteNumber)) {
    addError(state, path, '位置に数値でない値があります');

    return false;
  }

  const [longitude = 0, latitude = 0] = value;

  if (Math.abs(longitude) > LONGITUDE_LIMIT || Math.abs(latitude) > LATITUDE_LIMIT) {
    counts.outOfRange += 1;
  }

  if (value.length > MAX_RECOMMENDED_POSITION_VALUES) {
    counts.extraValues += 1;
  }

  return true;
}

/** 符号付き面積（x＝経度、y＝緯度）。正なら反時計回り */
function signedArea(ring: readonly Position[]): number {
  let doubled = 0;

  for (let i = 0; i + 1 < ring.length; i += 1) {
    const [x1 = 0, y1 = 0] = ring[i] ?? [];
    const [x2 = 0, y2 = 0] = ring[i + 1] ?? [];

    doubled += x1 * y2 - x2 * y1;
  }

  return doubled / 2;
}

function samePosition(a: Position | undefined, b: Position | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }

  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/** 位置の配列（線・リング）の検証。すべて正しく、個数が足りていれば位置の配列を返す。誤りなら null */
function checkLine(state: Validation, counts: WarningCounts, linePath: string, line: unknown, minPositions: number): Position[] | null {
  if (!Array.isArray(line)) {
    addError(state, linePath, '位置の配列にします');

    return null;
  }

  const positions: Position[] = [];

  for (const [i, position] of line.entries()) {
    if (checkPosition(state, `${linePath}[${i}]`, position, counts)) {
      positions.push(position);
    }
  }

  if (positions.length !== line.length) {
    return null;
  }

  if (line.length < minPositions) {
    addError(state, linePath, minPositions === MIN_RING_POSITIONS ? 'リングの位置が 4 個未満です' : '線の位置が 2 個未満です');

    return null;
  }

  return positions;
}

/** リングの検証。閉じていること、向き（外側のリングは反時計回り、穴は時計回り）を確かめる */
function checkRing(state: Validation, counts: WarningCounts, ringPath: string, ring: unknown, isOuter: boolean): void {
  const positions = checkLine(state, counts, ringPath, ring, MIN_RING_POSITIONS);

  if (positions === null) {
    return;
  }

  if (!samePosition(positions[0], positions.at(-1))) {
    addError(state, ringPath, 'リングの最初と最後の位置が違います');

    return;
  }

  // 右手則：外側のリング（0 番）は反時計回り、穴は時計回り
  const isCounterClockwise = signedArea(positions) > 0;

  if (isCounterClockwise !== isOuter) {
    counts.wrongWinding = true;
  }
}

function checkPolygon(state: Validation, counts: WarningCounts, polygonPath: string, rings: unknown): void {
  if (!Array.isArray(rings)) {
    addError(state, polygonPath, 'リングの配列にします');

    return;
  }

  rings.forEach((ring, i) => {
    checkRing(state, counts, `${polygonPath}[${i}]`, ring, i === 0);
  });
}

function reportWarnings(state: Validation, path: string, counts: WarningCounts): void {
  if (counts.outOfRange > 0) {
    addWarning(state, path, `範囲外の位置 ${counts.outOfRange} 個（経度 -180〜180、緯度 -90〜90）`);
  }

  if (counts.extraValues > 0) {
    addWarning(state, path, `数値が 4 個以上の位置 ${counts.extraValues} 個`);
  }

  if (counts.wrongWinding) {
    addWarning(state, path, 'ポリゴンの向きが右手則と逆です（外側は反時計回り、穴は時計回り）');
  }
}

/** coordinates を型ごとの深さで検証する。注意はジオメトリの単位にまとめる */
function checkCoordinates(state: Validation, type: string, path: string, coordinates: unknown[]): void {
  const counts: WarningCounts = { outOfRange: 0, extraValues: 0, wrongWinding: false };

  switch (type) {
    case 'Point':
      checkPosition(state, path, coordinates, counts);
      break;
    case 'MultiPoint':
      coordinates.forEach((position, i) => checkPosition(state, `${path}[${i}]`, position, counts));
      break;
    case 'LineString':
      checkLine(state, counts, path, coordinates, MIN_LINE_POSITIONS);
      break;
    case 'MultiLineString':
      coordinates.forEach((line, i) => checkLine(state, counts, `${path}[${i}]`, line, MIN_LINE_POSITIONS));
      break;
    case 'Polygon':
      checkPolygon(state, counts, path, coordinates);
      break;
    case 'MultiPolygon':
      coordinates.forEach((polygon, i) => {
        checkPolygon(state, counts, `${path}[${i}]`, polygon);
      });
      break;
  }

  reportWarnings(state, path, counts);
}

/** ジオメトリ 1 つを検証する。GeometryCollection は自身を検証せず、子を返す */
function checkSingleGeometry(state: Validation, path: string, geometry: unknown): PendingGeometry[] {
  if (!isRecord(geometry) || typeof geometry.type !== 'string' || !GEOMETRY_TYPES.includes(geometry.type)) {
    addError(state, path, 'ジオメトリではありません');

    return [];
  }

  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries)) {
      addError(state, `${path}.geometries`, 'geometries が無いか配列ではありません');

      return [];
    }

    return geometry.geometries.map((child: unknown, i): PendingGeometry => ({ path: `${path}.geometries[${i}]`, geometry: child }));
  }

  const coordinatesPath = `${path}.coordinates`;

  if (!Array.isArray(geometry.coordinates)) {
    addError(state, coordinatesPath, 'coordinates が無いか配列ではありません');

    return [];
  }

  // 空の配列は許される。描かず、位置と個数の確認もしない
  if (geometry.coordinates.length === 0) {
    addWarning(state, coordinatesPath, '座標が空です');

    return [];
  }

  checkCoordinates(state, geometry.type, coordinatesPath, geometry.coordinates);

  return [];
}

/** ジオメトリを検証する。GeometryCollection は入れ子が深くても落ちないよう、再帰でなくスタックで子を順に検証する */
function checkGeometry(state: Validation, rootPath: string, rootGeometry: unknown): void {
  const pending: PendingGeometry[] = [{ path: rootPath, geometry: rootGeometry }];

  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    // 逆順に積み、先頭の子から検証する
    for (const child of checkSingleGeometry(state, item.path, item.geometry).reverse()) {
      pending.push(child);
    }
  }
}

function checkFeature(state: Validation, path: string, feature: unknown): void {
  // Feature でない要素の誤りも、その要素の単位で集める（描かないため）
  state.featurePath = path;

  if (!isRecord(feature) || feature.type !== 'Feature') {
    addError(state, path, 'Feature ではありません');
    state.featurePath = null;

    return;
  }

  if (!('geometry' in feature)) {
    addError(state, path, 'geometry がありません');
  } else if (feature.geometry !== null) {
    checkGeometry(state, `${path}.geometry`, feature.geometry);
  }

  if (!('properties' in feature)) {
    addError(state, path, 'properties がありません');
  } else if (feature.properties !== null && !isRecord(feature.properties)) {
    addError(state, `${path}.properties`, 'properties はオブジェクトか null にします');
  }

  if ('id' in feature && typeof feature.id !== 'string' && typeof feature.id !== 'number') {
    addWarning(state, `${path}.id`, 'id が文字列でも数値でもありません');
  }

  state.featurePath = null;
}

/** 誤りと注意の一覧と、誤りのある Feature のパスの集合を返す。パスは `$.features[3].geometry` の形 */
export function validateGeoJson(value: unknown): { issues: GeoIssue[]; errorFeatures: ReadonlySet<string> } {
  const state: Validation = { issues: [], errorFeatures: new Set(), featurePath: null };

  if (!isRecord(value) || !GEOJSON_TYPES.some((type) => type === value.type)) {
    addError(state, ROOT_PATH, 'type が GeoJSON の型名ではありません');
  } else if (value.type === 'FeatureCollection') {
    if (Array.isArray(value.features)) {
      value.features.forEach((feature, i) => {
        checkFeature(state, featurePath(i), feature);
      });
    } else {
      addError(state, `${ROOT_PATH}.features`, 'features が無いか配列ではありません');
    }
  } else if (value.type === 'Feature') {
    checkFeature(state, ROOT_PATH, value);
  } else {
    // 単体のジオメトリも、誤りがあれば描かないよう Feature と同じく集合に入れる
    state.featurePath = ROOT_PATH;
    checkGeometry(state, ROOT_PATH, value);
  }

  return { issues: state.issues, errorFeatures: state.errorFeatures };
}

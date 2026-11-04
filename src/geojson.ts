// GeoJSON の構造の検証（RFC 7946、F5-5）と、背景地図なしの SVG での描画（F5-6、詳細設計 3.6、基本 7）
// 誤り（MUST に反する）のある Feature は描かない。注意の Feature は描く

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
const LONGITUDE_LIMIT = 180;
const LATITUDE_LIMIT = 90;

// 描く位置の総数の上限（N3-2）
export const MAX_DRAWN_POSITIONS = 500_000;

// パスの起点（文書全体）
const ROOT_PATH = '$';

type Position = readonly number[];

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
function featurePath(index: number): string {
  return `${ROOT_PATH}.features[${index}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
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

// ---- 描画 ----

const SVG_NS = 'http://www.w3.org/2000/svg';
// 緯度の cos の下限（極付近で縦横比が崩れないように）
const MIN_LATITUDE_COS = 0.01;
// 範囲の幅か高さが 0 のときに足す量（経緯度のとき 0.01 度、投影座標のとき 1）
const DEGENERATE_PAD_DEGREES = 0.01;
const DEGENERATE_PAD_PROJECTED = 1;
const POINT_STROKE_PX = 8;
const LINE_STROKE_PX = 2;
const HIT_STROKE_PX = 12;
// ドラッグとクリックを分けるしきい値（mousedown から mouseup までの移動）
const CLICK_MOVE_LIMIT_PX = 4;
const WHEEL_ZOOM_STEP = 1.2;
// 画面上の大きさの下限。大きさが 0 の環境（jsdom など）で 0 除算にしない
const MIN_CLIENT_SIZE_PX = 1;

type ShapeKind = 'point' | 'line' | 'polygon';

/** 描く図形 1 つ。lines は線・リングの単位の位置の配列（点は長さ 1 の線） */
interface Shape {
  readonly kind: ShapeKind;
  readonly lines: Position[][];
}

interface DrawItem {
  readonly path: string;
  readonly properties: unknown;
  readonly shapes: Shape[];
}

interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 拡大・移動で書き換える現在の表示範囲 */
interface PanZoomState {
  view: ViewBox;
}

interface Drag {
  readonly startX: number;
  readonly startY: number;
  readonly viewX: number;
  readonly viewY: number;
  moved: boolean;
}

function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isPositionList(value: unknown): value is Position[] {
  return Array.isArray(value) && value.every(isPosition);
}

function isPositionListList(value: unknown): value is Position[][] {
  return Array.isArray(value) && value.every(isPositionList);
}

function isPositionListListList(value: unknown): value is Position[][][] {
  return Array.isArray(value) && value.every(isPositionListList);
}

/** GeometryCollection 以外のジオメトリの図形。形の合わないものと、空の座標は描かない */
function shapesOfCoordinates(type: unknown, coordinates: unknown): Shape[] {
  if (Array.isArray(coordinates) && coordinates.length === 0) {
    return [];
  }

  switch (type) {
    case 'Point':
      return isPosition(coordinates) ? [{ kind: 'point', lines: [[coordinates]] }] : [];
    case 'MultiPoint':
      return isPositionList(coordinates) ? [{ kind: 'point', lines: coordinates.map((position) => [position]) }] : [];
    case 'LineString':
      return isPositionList(coordinates) ? [{ kind: 'line', lines: [coordinates] }] : [];
    case 'MultiLineString':
      return isPositionListList(coordinates) ? [{ kind: 'line', lines: coordinates }] : [];
    case 'Polygon':
      return isPositionListList(coordinates) ? [{ kind: 'polygon', lines: coordinates }] : [];
    case 'MultiPolygon':
      return isPositionListListList(coordinates) ? coordinates.map((rings): Shape => ({ kind: 'polygon', lines: rings })) : [];
    default:
      return [];
  }
}

/** ジオメトリを図形に直す。GeometryCollection は中身を順に。入れ子が深くても落ちないよう、再帰でなくスタックで走る */
function flattenGeometry(root: Record<string, unknown>): Shape[] {
  const shapes: Shape[] = [];
  const pending = [root];

  for (let geometry = pending.pop(); geometry !== undefined; geometry = pending.pop()) {
    if (geometry.type !== 'GeometryCollection') {
      // MultiPolygon は図形が多くなりうるので、スプレッドでなく 1 つずつ足す（引数の数の上限を避ける）
      for (const shape of shapesOfCoordinates(geometry.type, geometry.coordinates)) {
        shapes.push(shape);
      }

      continue;
    }

    const children = Array.isArray(geometry.geometries) ? geometry.geometries.filter(isRecord) : [];

    // 逆順に積み、先頭の子から取り出す
    for (const child of children.reverse()) {
      pending.push(child);
    }
  }

  return shapes;
}

function toDrawItem(path: string, feature: Record<string, unknown>): DrawItem {
  return {
    path,
    properties: feature.properties ?? null,
    shapes: isRecord(feature.geometry) ? flattenGeometry(feature.geometry) : [],
  };
}

/** 描く Feature（または単体のジオメトリ）を集める。誤りのある Feature は除く */
function collectDrawItems(value: Record<string, unknown>, errorFeatures: ReadonlySet<string>): DrawItem[] {
  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
    return value.features.flatMap((feature: unknown, i) => {
      const path = featurePath(i);

      return isRecord(feature) && !errorFeatures.has(path) ? [toDrawItem(path, feature)] : [];
    });
  }

  if (errorFeatures.has(ROOT_PATH)) {
    return [];
  }

  return value.type === 'Feature' ? [toDrawItem(ROOT_PATH, value)] : [{ path: ROOT_PATH, properties: null, shapes: flattenGeometry(value) }];
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }

  return element;
}

function setView(svg: SVGSVGElement, state: PanZoomState, view: ViewBox): void {
  state.view = view;
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
}

/** 画面上の位置を、SVG の座標（viewBox の座標）に直す。getScreenCTM が無い・使えないとき（jsdom など）は null */
function toSvgPoint(svg: SVGSVGElement, event: MouseEvent): { x: number; y: number } | null {
  if (typeof svg.getScreenCTM !== 'function') {
    return null;
  }

  const matrix = svg.getScreenCTM();

  if (matrix === null) {
    return null;
  }

  // preserveAspectRatio の余白を含む変換の逆行列で、画面の位置から SVG の座標を求める
  const inverse = matrix.inverse();

  return {
    x: inverse.a * event.clientX + inverse.c * event.clientY + inverse.e,
    y: inverse.b * event.clientX + inverse.d * event.clientY + inverse.f,
  };
}

/** カーソル位置を中心に拡大・縮小する */
function attachWheelZoom(svg: SVGSVGElement, state: PanZoomState): void {
  svg.addEventListener('wheel', (event) => {
    event.preventDefault();

    const cursor = toSvgPoint(svg, event);

    if (cursor === null) {
      return;
    }

    const { view } = state;
    const factor = event.deltaY < 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;

    setView(svg, state, {
      x: cursor.x - (cursor.x - view.x) * factor,
      y: cursor.y - (cursor.y - view.y) * factor,
      width: view.width * factor,
      height: view.height * factor,
    });
  });
}

/** 画面の 1 ピクセルあたりの viewBox の長さ。preserveAspectRatio が meet なので、縦横の大きいほうの比で表示される */
function unitsPerPixel(svg: SVGSVGElement, view: ViewBox): number {
  return Math.max(view.width / Math.max(MIN_CLIENT_SIZE_PX, svg.clientWidth), view.height / Math.max(MIN_CLIENT_SIZE_PX, svg.clientHeight));
}

/** ドラッグで移動する。移動が小さいときだけクリックとして通す */
function attachDrag(svg: SVGSVGElement, state: PanZoomState): void {
  let drag: Drag | null = null;

  svg.addEventListener('mousedown', (event) => {
    drag = { startX: event.clientX, startY: event.clientY, viewX: state.view.x, viewY: state.view.y, moved: false };
  });
  svg.addEventListener('mousemove', (event) => {
    if (drag === null) {
      return;
    }

    // SVG の外でボタンを離した
    if (event.buttons === 0) {
      drag = null;

      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const scale = unitsPerPixel(svg, state.view);

    drag.moved ||= Math.hypot(dx, dy) >= CLICK_MOVE_LIMIT_PX;
    setView(svg, state, { ...state.view, x: drag.viewX - dx * scale, y: drag.viewY - dy * scale });
  });
  // ドラッグの後のクリックは図形の選択にしない
  svg.addEventListener(
    'click',
    (event) => {
      if (drag?.moved === true) {
        event.stopPropagation();
      }

      drag = null;
    },
    true,
  );
  svg.addEventListener('mouseup', () => {
    if (drag?.moved !== true) {
      drag = null;
    }
  });
}

/** 拡大（カーソル位置中心）、ドラッグで移動、ダブルクリックで全体表示 */
function attachPanZoom(svg: SVGSVGElement, initial: ViewBox): void {
  const state: PanZoomState = { view: initial };

  attachWheelZoom(svg, state);
  attachDrag(svg, state);
  svg.addEventListener('dblclick', () => {
    setView(svg, state, initial);
  });
}

/** 描く位置全体の範囲。位置が 1 つも無いときは原点だけの範囲 */
function computeBounds(positions: readonly Position[]): Bounds {
  if (positions.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const [x = 0, y = 0] of positions) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  return { minX, maxX, minY, maxY };
}

/** 全体が収まる表示範囲と、位置を SVG の座標の文字列（`x y`）にする関数。y は上下を反転する */
function fitView(bounds: Bounds): { initial: ViewBox; toPoint: (position: Position) => string } {
  // 経緯度に収まるときだけ中心緯度の cos で縦横比を補う。投影座標のときは補わない
  const isGeographic =
    bounds.minX >= -LONGITUDE_LIMIT && bounds.maxX <= LONGITUDE_LIMIT && bounds.minY >= -LATITUDE_LIMIT && bounds.maxY <= LATITUDE_LIMIT;
  const centerLatitude = (bounds.minY + bounds.maxY) / 2;
  const cos = isGeographic ? Math.max(MIN_LATITUDE_COS, Math.cos((centerLatitude * Math.PI) / 180)) : 1;
  const pad = isGeographic ? DEGENERATE_PAD_DEGREES : DEGENERATE_PAD_PROJECTED;

  // 幅か高さが 0（点 1 つ、水平・垂直の線）のときは pad を足し、中心に置く
  const spanX = (bounds.maxX - bounds.minX) * cos;
  const spanY = bounds.maxY - bounds.minY;
  const width = spanX > 0 ? spanX : pad * cos;
  const height = spanY > 0 ? spanY : pad;

  return {
    initial: {
      x: ((bounds.minX + bounds.maxX) / 2) * cos - width / 2,
      y: -(bounds.minY + bounds.maxY) / 2 - height / 2,
      width,
      height,
    },
    toPoint: ([x = 0, y = 0]) => `${x * cos} ${-y}`,
  };
}

/** 図形の path の d 属性 */
function buildPathData(shape: Shape, toPoint: (position: Position) => string): string {
  return shape.lines
    .filter((line) => line.length > 0)
    .map((line) => {
      const head = line[0] ?? [];
      // 点は長さ 0 の線にして、round の線端で丸を描く
      const body = shape.kind === 'point' ? `M${toPoint(head)}z` : `M${line.map(toPoint).join('L')}`;

      return shape.kind === 'polygon' ? `${body}z` : body;
    })
    .join('');
}

function createShapeElements(shape: Shape, d: string): SVGPathElement[] {
  const common = { d, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

  if (shape.kind === 'polygon') {
    return [createSvgElement('path', { ...common, class: 'geo-polygon', 'fill-rule': 'evenodd', 'stroke-width': String(LINE_STROKE_PX) })];
  }

  const strokeWidth = shape.kind === 'point' ? POINT_STROKE_PX : LINE_STROKE_PX;

  return [
    createSvgElement('path', { ...common, class: `geo-${shape.kind}`, fill: 'none', 'stroke-width': String(strokeWidth) }),
    // 当たり判定：同じ形を透明・太めに重ねる
    createSvgElement('path', { ...common, class: 'geo-hit', fill: 'none', stroke: 'transparent', 'stroke-width': String(HIT_STROKE_PX) }),
  ];
}

/** Feature 1 つ分の図形をまとめた g。クリックで onSelect に properties とパスを渡す */
function createItemGroup(
  item: DrawItem,
  toPoint: (position: Position) => string,
  onSelect: (properties: unknown, path: string) => void,
): SVGGElement {
  const group = createSvgElement('g', { 'data-path': item.path });

  for (const shape of item.shapes) {
    group.append(...createShapeElements(shape, buildPathData(shape, toPoint)));
  }

  group.addEventListener('click', () => {
    onSelect(item.properties, item.path);
  });

  return group;
}

/**
 * 図形を描く。位置の総数が上限を超えたら描かずに { drawn: false, count } を返す。
 * 図形のクリックで、その Feature の properties とパスを onSelect に渡す
 */
export function renderGeoJson(
  container: HTMLElement,
  value: unknown,
  errorFeatures: ReadonlySet<string>,
  onSelect: (properties: unknown, path: string) => void,
): { drawn: true } | { drawn: false; count: number } {
  container.replaceChildren();

  if (!isRecord(value)) {
    return { drawn: true };
  }

  const items = collectDrawItems(value, errorFeatures);
  const allPositions = items.flatMap((item) => item.shapes.flatMap((shape) => shape.lines.flat()));

  if (allPositions.length > MAX_DRAWN_POSITIONS) {
    return { drawn: false, count: allPositions.length };
  }

  const { initial, toPoint } = fitView(computeBounds(allPositions));
  const svg = createSvgElement('svg', {
    class: 'geo',
    viewBox: `${initial.x} ${initial.y} ${initial.width} ${initial.height}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  for (const item of items) {
    svg.append(createItemGroup(item, toPoint, onSelect));
  }

  attachPanZoom(svg, initial);
  container.append(svg);

  return { drawn: true };
}

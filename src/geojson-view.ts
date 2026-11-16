// GeoJSON を背景地図なしの SVG で描く（F5-6、詳細設計 3.6、基本 7）。拡大・移動・図形の選択
// 検証で誤りのあった Feature は描かない（geojson.ts の errorFeatures）

import { featurePath, isFiniteNumber, isRecord, LATITUDE_LIMIT, LONGITUDE_LIMIT } from './geojson.ts';
import type { Position } from './geojson.ts';
import { ROOT_PATH } from './path.ts';

// 描く位置の総数の上限（N3-2）
export const MAX_DRAWN_POSITIONS = 500_000;

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

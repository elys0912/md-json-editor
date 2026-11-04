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

type Position = readonly number[];

/** 検証の途中の状態。誤りのある Feature のパスは、Feature の中のどこで誤りが出ても Feature の単位で集める */
interface Validation {
  readonly issues: GeoIssue[];
  readonly errorFeatures: Set<string>;
  featurePath: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** 位置の検証。誤りなら addError して false を返す。範囲外・4 個以上は数えて呼び出し側がまとめて注意にする */
function checkPosition(state: Validation, path: string, value: unknown, counts: { outOfRange: number; extraValues: number }): value is Position {
  if (!Array.isArray(value) || value.length < MIN_POSITION_VALUES) {
    addError(state, path, '位置は 2 個以上の数値の配列にします');

    return false;
  }

  // `1e999` は Infinity になるので、isFinite で外す
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    addError(state, path, '位置に数値でない値があります');

    return false;
  }

  const [longitude = 0, latitude = 0] = value as number[];

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

/** coordinates を型ごとの深さで検証する。範囲外・数値の個数・向きの注意は、ジオメトリの単位で 1 件ずつにまとめる */
function checkCoordinates(state: Validation, type: string, path: string, coordinates: unknown[]): void {
  const counts = { outOfRange: 0, extraValues: 0, wrongWinding: false };

  const checkLine = (linePath: string, line: unknown, minPositions: number): Position[] | null => {
    if (!Array.isArray(line)) {
      addError(state, linePath, '位置の配列にします');

      return null;
    }

    const positions = line.filter((position, i): position is Position => checkPosition(state, `${linePath}[${i}]`, position, counts));

    if (positions.length !== line.length) {
      return null;
    }

    if (line.length < minPositions) {
      addError(state, linePath, minPositions === MIN_RING_POSITIONS ? 'リングの位置が 4 個未満です' : '線の位置が 2 個未満です');

      return null;
    }

    return positions;
  };

  const checkPolygon = (polygonPath: string, rings: unknown): void => {
    if (!Array.isArray(rings)) {
      addError(state, polygonPath, 'リングの配列にします');

      return;
    }

    rings.forEach((ring, i) => {
      const ringPath = `${polygonPath}[${i}]`;
      const positions = checkLine(ringPath, ring, MIN_RING_POSITIONS);

      if (positions === null) {
        return;
      }

      if (!samePosition(positions[0], positions.at(-1))) {
        addError(state, ringPath, 'リングの最初と最後の位置が違います');

        return;
      }

      // 右手則：外側のリング（0 番）は反時計回り、穴は時計回り
      const isCounterClockwise = signedArea(positions) > 0;

      if (isCounterClockwise !== (i === 0)) {
        counts.wrongWinding = true;
      }
    });
  };

  switch (type) {
    case 'Point':
      checkPosition(state, path, coordinates, counts);
      break;
    case 'MultiPoint':
      coordinates.forEach((position, i) => checkPosition(state, `${path}[${i}]`, position, counts));
      break;
    case 'LineString':
      checkLine(path, coordinates, MIN_LINE_POSITIONS);
      break;
    case 'MultiLineString':
      coordinates.forEach((line, i) => checkLine(`${path}[${i}]`, line, MIN_LINE_POSITIONS));
      break;
    case 'Polygon':
      checkPolygon(path, coordinates);
      break;
    case 'MultiPolygon':
      coordinates.forEach((polygon, i) => {
        checkPolygon(`${path}[${i}]`, polygon);
      });
      break;
  }

  // 注意はジオメトリの単位にまとめる
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

function checkGeometry(state: Validation, path: string, geometry: unknown): void {
  if (!isRecord(geometry) || typeof geometry.type !== 'string' || !GEOMETRY_TYPES.includes(geometry.type)) {
    addError(state, path, 'ジオメトリではありません');

    return;
  }

  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries)) {
      addError(state, `${path}.geometries`, 'geometries が無いか配列ではありません');

      return;
    }

    geometry.geometries.forEach((child, i) => {
      checkGeometry(state, `${path}.geometries[${i}]`, child);
    });

    return;
  }

  const coordinatesPath = `${path}.coordinates`;

  if (!Array.isArray(geometry.coordinates)) {
    addError(state, coordinatesPath, 'coordinates が無いか配列ではありません');

    return;
  }

  // 空の配列は許される。描かず、位置と個数の確認もしない
  if (geometry.coordinates.length === 0) {
    addWarning(state, coordinatesPath, '座標が空です');

    return;
  }

  checkCoordinates(state, geometry.type, coordinatesPath, geometry.coordinates);
}

function checkFeature(state: Validation, path: string, feature: unknown): void {
  if (!isRecord(feature) || feature.type !== 'Feature') {
    addError(state, path, 'Feature ではありません');

    return;
  }

  state.featurePath = path;

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
export function validateGeoJson(value: unknown): { issues: GeoIssue[]; errorFeatures: Set<string> } {
  const state: Validation = { issues: [], errorFeatures: new Set(), featurePath: null };
  const root = '$';

  if (!isRecord(value) || !GEOJSON_TYPES.some((type) => type === value.type)) {
    addError(state, root, 'type が GeoJSON の型名ではありません');
  } else if (value.type === 'FeatureCollection') {
    if (Array.isArray(value.features)) {
      value.features.forEach((feature, i) => {
        checkFeature(state, `${root}.features[${i}]`, feature);
      });
    } else {
      addError(state, `${root}.features`, 'features が無いか配列ではありません');
    }
  } else if (value.type === 'Feature') {
    checkFeature(state, root, value);
  } else {
    // 単体のジオメトリも、誤りがあれば描かないよう Feature と同じく集合に入れる
    state.featurePath = root;
    checkGeometry(state, root, value);
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

interface DrawItem {
  readonly path: string;
  readonly properties: unknown;
  readonly geometries: readonly Record<string, unknown>[];
}

/** 描く Feature（または単体のジオメトリ）を集める。誤りのある Feature は除く */
function collectDrawItems(value: Record<string, unknown>, errorFeatures: Set<string>): DrawItem[] {
  const toItem = (path: string, feature: Record<string, unknown>): DrawItem => ({
    path,
    properties: feature.properties ?? null,
    geometries: isRecord(feature.geometry) ? [feature.geometry] : [],
  });

  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
    return value.features.flatMap((feature: unknown, i) => {
      const path = `$.features[${i}]`;

      return isRecord(feature) && !errorFeatures.has(path) ? [toItem(path, feature)] : [];
    });
  }

  if (errorFeatures.has('$')) {
    return [];
  }

  return value.type === 'Feature' ? [toItem('$', value)] : [{ path: '$', properties: null, geometries: [value] }];
}

/** ジオメトリの位置を、線・リングの単位の配列で返す（点は長さ 1 の線）。GeometryCollection は中身を順に */
function flattenLines(geometry: Record<string, unknown>): { kind: 'point' | 'line' | 'polygon'; lines: Position[][] }[] {
  const coordinates = geometry.coordinates;

  switch (geometry.type) {
    case 'Point':
      return [{ kind: 'point', lines: [[coordinates as Position]] }];
    case 'MultiPoint':
      return [{ kind: 'point', lines: (coordinates as Position[]).map((position) => [position]) }];
    case 'LineString':
      return [{ kind: 'line', lines: [coordinates as Position[]] }];
    case 'MultiLineString':
      return [{ kind: 'line', lines: coordinates as Position[][] }];
    case 'Polygon':
      return [{ kind: 'polygon', lines: coordinates as Position[][] }];
    case 'MultiPolygon':
      return (coordinates as Position[][][]).map((rings) => ({ kind: 'polygon' as const, lines: rings }));
    case 'GeometryCollection':
      return (geometry.geometries as unknown[]).filter(isRecord).flatMap(flattenLines);
    default:
      return [];
  }
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }

  return element;
}

/** 拡大（カーソル位置中心）、ドラッグで移動、ダブルクリックで全体表示。移動が小さいときだけクリックとして通す */
function attachPanZoom(svg: SVGSVGElement, initial: { x: number; y: number; width: number; height: number }): void {
  let view = { ...initial };
  let drag: { startX: number; startY: number; viewX: number; viewY: number; moved: boolean } | null = null;

  const apply = (): void => {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  };
  const scale = (): number => view.width / Math.max(1, svg.clientWidth);

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();

    const rect = svg.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
    const cursorX = view.x + ((event.clientX - rect.left) / Math.max(1, rect.width)) * view.width;
    const cursorY = view.y + ((event.clientY - rect.top) / Math.max(1, rect.height)) * view.height;

    view = {
      x: cursorX - (cursorX - view.x) * factor,
      y: cursorY - (cursorY - view.y) * factor,
      width: view.width * factor,
      height: view.height * factor,
    };
    apply();
  });
  svg.addEventListener('mousedown', (event) => {
    drag = { startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y, moved: false };
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

    drag.moved ||= Math.hypot(dx, dy) >= CLICK_MOVE_LIMIT_PX;
    view = { ...view, x: drag.viewX - dx * scale(), y: drag.viewY - dy * scale() };
    apply();
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
  svg.addEventListener('dblclick', () => {
    view = { ...initial };
    apply();
  });
}

/**
 * 図形を描く。位置の総数が上限を超えたら描かずに { drawn: false, count } を返す。
 * 図形のクリックで、その Feature の properties とパスを onSelect に渡す
 */
export function renderGeoJson(
  container: HTMLElement,
  value: unknown,
  errorFeatures: Set<string>,
  onSelect: (properties: unknown, path: string) => void,
): { drawn: true } | { drawn: false; count: number } {
  container.replaceChildren();

  if (!isRecord(value)) {
    return { drawn: true };
  }

  const items = collectDrawItems(value, errorFeatures).map((item) => ({
    ...item,
    shapes: item.geometries.flatMap(flattenLines),
  }));
  const allPositions = items.flatMap((item) => item.shapes.flatMap((shape) => shape.lines.flat()));

  if (allPositions.length > MAX_DRAWN_POSITIONS) {
    return { drawn: false, count: allPositions.length };
  }

  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

  for (const [x = 0, y = 0] of allPositions) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
  }

  if (allPositions.length === 0) {
    Object.assign(bounds, { minX: 0, maxX: 0, minY: 0, maxY: 0 });
  }

  // 経緯度に収まるときだけ中心緯度の cos で縦横比を補う。投影座標のときは補わない
  const isGeographic =
    bounds.minX >= -LONGITUDE_LIMIT && bounds.maxX <= LONGITUDE_LIMIT && bounds.minY >= -LATITUDE_LIMIT && bounds.maxY <= LATITUDE_LIMIT;
  const centerLatitude = (bounds.minY + bounds.maxY) / 2;
  const cos = isGeographic ? Math.max(MIN_LATITUDE_COS, Math.cos((centerLatitude * Math.PI) / 180)) : 1;
  const pad = isGeographic ? DEGENERATE_PAD_DEGREES : DEGENERATE_PAD_PROJECTED;
  const toPoint = ([x = 0, y = 0]: Position): string => `${x * cos} ${-y}`;

  // 幅か高さが 0（点 1 つ、水平・垂直の線）のときは pad を足し、中心に置く
  const spanX = (bounds.maxX - bounds.minX) * cos;
  const spanY = bounds.maxY - bounds.minY;
  const width = spanX > 0 ? spanX : pad * cos;
  const height = spanY > 0 ? spanY : pad;
  const initial = {
    x: ((bounds.minX + bounds.maxX) / 2) * cos - width / 2,
    y: -(bounds.minY + bounds.maxY) / 2 - height / 2,
    width,
    height,
  };

  const svg = createSvgElement('svg', {
    class: 'geo',
    viewBox: `${initial.x} ${initial.y} ${initial.width} ${initial.height}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  for (const item of items) {
    const group = createSvgElement('g', { 'data-path': item.path });

    for (const shape of item.shapes) {
      const d = shape.lines
        .filter((line) => line.length > 0)
        .map((line) => {
          const head = line[0] ?? [];
          // 点は長さ 0 の線にして、round の線端で丸を描く
          const body = shape.kind === 'point' ? `M${toPoint(head)}z` : `M${line.map(toPoint).join('L')}`;

          return shape.kind === 'polygon' ? `${body}z` : body;
        })
        .join('');
      const strokeWidth = shape.kind === 'point' ? POINT_STROKE_PX : LINE_STROKE_PX;
      const common = { d, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

      if (shape.kind === 'polygon') {
        group.append(createSvgElement('path', { ...common, class: 'geo-polygon', 'fill-rule': 'evenodd', 'stroke-width': String(LINE_STROKE_PX) }));
        continue;
      }

      group.append(
        createSvgElement('path', { ...common, class: `geo-${shape.kind}`, fill: 'none', 'stroke-width': String(strokeWidth) }),
        // 当たり判定：同じ形を透明・太めに重ねる
        createSvgElement('path', { ...common, class: 'geo-hit', fill: 'none', stroke: 'transparent', 'stroke-width': String(HIT_STROKE_PX) }),
      );
    }

    group.addEventListener('click', () => {
      onSelect(item.properties, item.path);
    });
    svg.append(group);
  }

  attachPanZoom(svg, initial);
  container.append(svg);

  return { drawn: true };
}

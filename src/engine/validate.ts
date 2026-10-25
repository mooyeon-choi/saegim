import type { Easing, MotionKeyframe, MotionNode, MotionProject, NodeType, TextWarp, FillGradient, EmbeddedFont, BackgroundMotion, BackgroundMotionTrack, ForegroundMotion, ForegroundMotionTrack, AffineMatrix, PaintRegion, StackBoundary } from '../types';
import { MAX_PROJECT_NODES } from './limits';

/** The same validator is embedded in offline composition players. */
export function createProjectValidator(nodeLimit = 8000) {

const colorNames = new Set(['none', 'transparent', 'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'gray', 'grey', 'pink', 'cyan', 'magenta', 'navy', 'teal', 'lime', 'silver', 'maroon', 'olive', 'aqua', 'fuchsia']);
const types = new Set<NodeType>(['rect', 'ellipse', 'path', 'text', 'line']);
const easings = new Set<Easing>(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']);
type RecordValue = Record<string, unknown>;
interface PathBudget { bytes: number; coordinates: number; warpPoints?: number; gradientStops?: number }
const MAX_PATH_BYTES = 64_000_000;
const MAX_PATH_COORDINATES = 8_000_000;

function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function object(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '객체가 필요합니다.');
  return value as RecordValue;
}
function string(value: unknown, path: string, max = 1000): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(path, `올바른 문자열(${max}자 이하)이 필요합니다.`);
  return value;
}
function number(value: unknown, path: string, min = -65536, max = 65536): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `${min}~${max} 사이의 유한한 숫자가 필요합니다.`);
  return value;
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, '참/거짓 값이 필요합니다.');
  return value;
}
function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `${max}개 이하의 배열이 필요합니다.`);
  return value;
}
function validateColor(value: unknown, path = 'color'): string {
  const result = string(value, path, 100).trim();
  if (colorNames.has(result.toLowerCase()) || /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(result)) return result;
  // Only numeric color functions are allowed. URL references, CSS variables and CSS declarations are rejected.
  const match = /^(rgb|rgba|hsl|hsla)\(\s*([\d.%,\s+\-/]+)\s*\)$/i.exec(result);
  if (match && match[2].replace(/[,/]/g, ' ').trim().split(/\s+/).every(v => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(v))) {
    const count = match[2].replace(/[,/]/g, ' ').trim().split(/\s+/).length;
    if (count === 3 || count === 4) return result;
  }
  return fail(path, '단색 이름, HEX, RGB 또는 HSL 색상만 허용됩니다.');
}

function validatePath(value: string, path: string, budget: PathBudget): string {
  // SVG paths contain only ASCII syntax, so character length also bounds bytes.
  budget.bytes += value.length;
  if (budget.bytes > MAX_PATH_BYTES) fail(path, '프로젝트의 전체 SVG 경로 데이터는 64MB 이하여야 합니다.');
  const tokens = value.match(/[MmZzLlHhVvCcSsQqTtAa]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  const residue = value.replace(/[MmZzLlHhVvCcSsQqTtAa]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g, '').replace(/[\s,]/g, '');
  if (residue || !tokens.length || !/^[Mm]$/.test(tokens[0] ?? '')) fail(path, 'SVG 도형 명령과 숫자만 허용됩니다.');
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let command = '', position = 0, coordinates = 0;
  while (position < tokens.length) {
    if (/^[a-z]$/i.test(tokens[position])) {
      command = tokens[position++].toUpperCase();
      if (command === 'Z') { command = ''; continue; }
    }
    const count = arity[command];
    if (!count || position + count > tokens.length) fail(path, 'SVG 도형 명령에 필요한 좌표가 빠졌습니다.');
    for (let i = 0; i < count; i++) {
      const coordinate = Number(tokens[position++]);
      coordinates++; budget.coordinates++;
      if (coordinates > 20000) fail(path, '한 SVG 경로에는 숫자 좌표를 20,000개 이하로 지정해 주세요.');
      if (budget.coordinates > MAX_PATH_COORDINATES) fail(path, '프로젝트 전체 SVG 숫자 좌표는 8,000,000개 이하여야 합니다.');
      if (!Number.isFinite(coordinate) || Math.abs(coordinate) > 1e7) fail(path, 'SVG 좌표가 유효 범위를 벗어났습니다.');
      if (command === 'A' && ((i === 0 || i === 1) && coordinate < 0 || (i === 3 || i === 4) && coordinate !== 0 && coordinate !== 1)) fail(path, 'SVG 호의 반지름 또는 방향 값이 잘못되었습니다.');
    }
    if (command === 'M') command = 'L';
  }
  return value;
}

function warp(value: unknown, path: string, budget: PathBudget): TextWarp {
  const w = object(value, path);
  const points = (value: unknown, side: string) => list(value, `${path}.${side}`, 32).map((v, i) => {
    const p = object(v, `${path}.${side}[${i}]`);
    return { u: number(p.u, `${path}.${side}[${i}].u`, 0, 1), x: number(p.x, `${path}.${side}[${i}].x`, -4000, 5000), y: number(p.y, `${path}.${side}[${i}].y`, -4000, 5000) };
  });
  const top = points(w.top, 'top'), bottom = points(w.bottom, 'bottom');
  budget.warpPoints = (budget.warpPoints ?? 0) + top.length + bottom.length;
  if (budget.warpPoints > 100000) fail(path, '전체 텍스트 변형 경계는 100,000개 점 이하여야 합니다.');
  if (top.length < 2 || top.length !== bottom.length || top[0].u !== 0 || top[top.length - 1].u !== 1 || top.some((p, i) => p.u !== bottom[i].u || i > 0 && p.u <= top[i - 1].u)) fail(path, '양쪽 경계는 동일한 0..1의 오름차순 u에 2~32개 점이 필요합니다.');
  for (let i = 0; i < top.length - 1; i++) {
    const q = [top[i], top[i + 1], bottom[i + 1], bottom[i]];
    const cross = q.map((a, j) => { const b = q[(j + 1) % 4], c = q[(j + 2) % 4]; return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); });
    if (!cross.every(v => v > 0.000001) && !cross.every(v => v < -0.000001)) fail(path, '경계가 겹치거나 접힌 사각형은 허용되지 않습니다.');
  }
  return { top, bottom };
}

function gradient(value: unknown, path: string, budget: PathBudget): FillGradient {
  const g = object(value, path);
  const stops = list(g.stops, `${path}.stops`, 16).map((v, i) => {
    const s = object(v, `${path}.stops[${i}]`), color = string(s.color, `${path}.stops[${i}].color`, 9);
    if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) fail(`${path}.stops[${i}].color`, '그라데이션 색상은 HEX만 허용됩니다.');
    return { offset: number(s.offset, `${path}.stops[${i}].offset`, 0, 1), color };
  });
  budget.gradientStops = (budget.gradientStops ?? 0) + stops.length;
  if (budget.gradientStops > 1000000) fail(path, '전체 그라데이션 stop은 1,000,000개 이하여야 합니다.');
  if (stops.length < 2 || stops.some((s, i) => i > 0 && s.offset < stops[i - 1].offset)) fail(path, '그라데이션은 오름차순 stop 2~16개가 필요합니다.');
  const coord = (key: string) => number(g[key], `${path}.${key}`, -2, 3);
  if (g.type === 'linear') return { type: 'linear', x1: coord('x1'), y1: coord('y1'), x2: coord('x2'), y2: coord('y2'), stops };
  if (g.type === 'radial') {
    const result: FillGradient = { type: 'radial', cx: coord('cx'), cy: coord('cy'), r: number(g.r, `${path}.r`, 0.0001, 4), stops };
    if (g.fx !== undefined) result.fx = coord('fx');
    if (g.fy !== undefined) result.fy = coord('fy');
    return result;
  }
  return fail(`${path}.type`, 'linear 또는 radial만 허용됩니다.');
}

function stackBoundary(value: unknown, path: string): StackBoundary {
  const input = object(value, path), result: StackBoundary = { featherPx: number(input.featherPx, `${path}.featherPx`, 0, 8) };
  if (input.cornerRadiusPx !== undefined) result.cornerRadiusPx = number(input.cornerRadiusPx, `${path}.cornerRadiusPx`, 0, 4);
  return result;
}
function opaqueColor(color: string): boolean {
  const s = color.toLowerCase();
  if (s === 'none' || s === 'transparent') return false;
  if (s[0] === '#') return s.length === 5 ? s[4] === 'f' : s.length === 9 ? s.slice(7) === 'ff' : true;
  const match = /^(?:rgba?|hsla?)\((.*)\)$/.exec(s);
  if (!match) return true;
  const parts = match[1].replace(/[,/]/g, ' ').trim().split(/\s+/);
  return parts.length === 3 || Number.parseFloat(parts[3]) === (parts[3].endsWith('%') ? 100 : 1);
}
function opaquePaint(fill: string, paint: FillGradient | null | undefined): boolean {
  return paint ? paint.stops.every(s => opaqueColor(s.color)) : opaqueColor(fill);
}
function validateStackPaints(node: MotionNode, path: string) {
  const observations = node.keyframes.length ? node.keyframes : [undefined];
  for (const [i, key] of observations.entries()) {
    const active = key?.stackBoundary === null ? undefined : key?.stackBoundary ?? node.stackBoundary;
    const regions = key?.paintRegions ?? node.paintRegions ?? [];
    if (!active) {
      if (regions.some(r => r.featherPx !== undefined)) fail(path, '부분 채색 featherPx에는 stackBoundary가 필요합니다.');
      continue;
    }
    const paint = key?.gradient === null ? undefined : key?.gradient ?? node.gradient;
    // The base seals the silhouette; internal source-over paints may add
    // translucent light or shadow without making holes in that base.
    if (!opaquePaint(key?.fill ?? node.fill, paint)) fail(path, 'stackBoundary 기본 채색은 불투명 색상과 그라데이션만 지원합니다.');
    // Gradient interpolation belongs to the held left observation. Even if the
    // next observation clears stack mode, its alpha participates before the key.
    const next = node.keyframes[i + 1], nextPaint = next?.gradient === null ? undefined : next?.gradient ?? node.gradient;
    if (next && paint && nextPaint && paint.type === nextPaint.type && paint.stops.length === nextPaint.stops.length && !opaquePaint('', nextPaint)) fail(path, 'stackBoundary 구간의 보간 그라데이션은 불투명해야 합니다.');
  }
}

function paintRegions(value: unknown, path: string, budget: PathBudget): PaintRegion[] {
  return list(value, path, 8).map((v, i) => {
    const p = `${path}[${i}]`, region = object(v, p);
    const result: PaintRegion = { path: validatePath(string(region.path, `${p}.path`, 100000), `${p}.path`, budget), fill: validateColor(region.fill, `${p}.fill`) };
    if (region.gradient !== undefined) result.gradient = region.gradient === null ? null : gradient(region.gradient, `${p}.gradient`, budget);
    if (region.featherPx !== undefined) result.featherPx = number(region.featherPx, `${p}.featherPx`, 0, 8);
    return result;
  });
}

function keyframe(value: unknown, path: string, duration: number, pathBudget: PathBudget): MotionKeyframe {
  const k = object(value, path);
  const easing = k.easing === undefined ? 'linear' : string(k.easing, `${path}.easing`) as Easing;
  if (!easings.has(easing)) fail(`${path}.easing`, '지원하지 않는 보간 방식입니다.');
  const result: MotionKeyframe = {
    time: number(k.time, `${path}.time`, 0, duration),
    x: number(k.x, `${path}.x`), y: number(k.y, `${path}.y`),
    scaleX: number(k.scaleX, `${path}.scaleX`, 0, 100), scaleY: number(k.scaleY, `${path}.scaleY`, 0, 100),
    rotation: number(k.rotation, `${path}.rotation`, -360000, 360000),
    opacity: number(k.opacity, `${path}.opacity`, 0, 1), easing,
  };
  if (k.path !== undefined) result.path = validatePath(string(k.path, `${path}.path`, 100000), `${path}.path`, pathBudget);
  if (k.fill !== undefined) result.fill = validateColor(k.fill, `${path}.fill`);
  if (k.gradient !== undefined) result.gradient = k.gradient === null ? null : gradient(k.gradient, `${path}.gradient`, pathBudget);
  if (k.paintRegions !== undefined) result.paintRegions = paintRegions(k.paintRegions, `${path}.paintRegions`, pathBudget);
  if (k.stackBoundary !== undefined) result.stackBoundary = k.stackBoundary === null ? null : stackBoundary(k.stackBoundary, `${path}.stackBoundary`);
  if (k.textWarp !== undefined) result.textWarp = warp(k.textWarp, `${path}.textWarp`, pathBudget);
  if (k.textReveal !== undefined) result.textReveal = number(k.textReveal, `${path}.textReveal`, 0, 1);
  if (k.occlusionPath !== undefined) result.occlusionPath = k.occlusionPath === '' ? '' : validatePath(string(k.occlusionPath, `${path}.occlusionPath`, 100000), `${path}.occlusionPath`, pathBudget);
  return result;
}

function validateNode(value: unknown, path = 'node', duration = 3600, pathBudget: PathBudget = { bytes: 0, coordinates: 0 }): MotionNode {
  const n = object(value, path);
  const type = string(n.type, `${path}.type`) as NodeType;
  if (!types.has(type)) fail(`${path}.type`, '지원하지 않는 요소 종류입니다.');
  const id = string(n.id, `${path}.id`, 200);
  if (!id.trim()) fail(`${path}.id`, '요소 ID가 비어 있습니다.');
  const start = number(n.start, `${path}.start`, 0, duration);
  const end = number(n.end, `${path}.end`, 0, duration);
  if (end <= start) fail(`${path}.end`, '끝 시간은 시작 시간보다 커야 합니다.');
  const keyframes = list(n.keyframes, `${path}.keyframes`, 5000).map((k, i) => keyframe(k, `${path}.keyframes[${i}]`, duration, pathBudget)).sort((a, b) => a.time - b.time);
  if (keyframes.some((k, i) => i > 0 && k.time === keyframes[i - 1].time)) fail(`${path}.keyframes`, '같은 시각에 키프레임을 두 개 둘 수 없습니다.');
  if (type !== 'path' && keyframes.some(k => k.path !== undefined)) fail(`${path}.keyframes`, '경로 키프레임은 path 요소에만 지정할 수 있습니다.');
  const result: MotionNode = {
    id, name: string(n.name, `${path}.name`, 1000), type,
    x: number(n.x, `${path}.x`), y: number(n.y, `${path}.y`),
    width: number(n.width, `${path}.width`, 0), height: number(n.height, `${path}.height`, 0),
    rotation: number(n.rotation, `${path}.rotation`, -360000, 360000), opacity: number(n.opacity, `${path}.opacity`, 0, 1),
    fill: validateColor(n.fill, `${path}.fill`), stroke: validateColor(n.stroke, `${path}.stroke`),
    strokeWidth: number(n.strokeWidth, `${path}.strokeWidth`, 0, 10000),
    start, end, hidden: bool(n.hidden, `${path}.hidden`), locked: bool(n.locked, `${path}.locked`), keyframes,
  };
  if (n.borderRadius !== undefined) result.borderRadius = number(n.borderRadius, `${path}.borderRadius`, 0);
  if (n.text !== undefined || type === 'text') result.text = string(n.text ?? '', `${path}.text`, 10000);
  if (n.fontSize !== undefined || type === 'text') result.fontSize = number(n.fontSize ?? 48, `${path}.fontSize`, 1, 4096);
  if (n.fontFamily !== undefined || type === 'text') result.fontFamily = string(n.fontFamily ?? 'sans-serif', `${path}.fontFamily`, 300);
  if (n.fontWeight !== undefined || type === 'text') result.fontWeight = number(n.fontWeight ?? 400, `${path}.fontWeight`, 1, 1000);
  if (n.letterSpacing !== undefined) result.letterSpacing = number(n.letterSpacing, `${path}.letterSpacing`, -1000, 1000);
  if (n.fontStyle !== undefined) {
    if (n.fontStyle !== 'normal' && n.fontStyle !== 'italic') fail(`${path}.fontStyle`, 'normal 또는 italic만 허용됩니다.');
    result.fontStyle = n.fontStyle;
  }
  if (n.textFit !== undefined) { if (n.textFit !== 'width') fail(`${path}.textFit`, 'width만 허용됩니다.'); result.textFit = 'width'; }
  if (n.textBox !== undefined) {
    const b = object(n.textBox, `${path}.textBox`);
    result.textBox = { x: number(b.x, `${path}.textBox.x`), y: number(b.y, `${path}.textBox.y`), width: number(b.width, `${path}.textBox.width`, 0.001), height: number(b.height, `${path}.textBox.height`, 0.001) };
    if (b.advance !== undefined) result.textBox.advance = number(b.advance, `${path}.textBox.advance`, 0.001);
  }
  if (n.textWarp !== undefined) result.textWarp = warp(n.textWarp, `${path}.textWarp`, pathBudget);
  if (n.textReveal !== undefined) result.textReveal = number(n.textReveal, `${path}.textReveal`, 0, 1);
  if (n.occlusionPath !== undefined) result.occlusionPath = n.occlusionPath === '' ? '' : validatePath(string(n.occlusionPath, `${path}.occlusionPath`, 100000), `${path}.occlusionPath`, pathBudget);
  if (n.gradient !== undefined) result.gradient = gradient(n.gradient, `${path}.gradient`, pathBudget);
  if (n.paintRegions !== undefined) result.paintRegions = paintRegions(n.paintRegions, `${path}.paintRegions`, pathBudget);
  if (n.stackBoundary !== undefined) result.stackBoundary = stackBoundary(n.stackBoundary, `${path}.stackBoundary`);
  if ((type === 'text' || type === 'line') && (n.stackBoundary !== undefined || keyframes.some(k => k.stackBoundary !== undefined))) fail(path, '텍스트와 line에는 stackBoundary를 지정할 수 없습니다.');
  validateStackPaints(result, path);
  if (type === 'text' && (n.paintRegions !== undefined || keyframes.some(k => k.paintRegions !== undefined))) fail(path, '텍스트에는 부분 채색을 지정할 수 없습니다.');
  if (type !== 'text' && (n.textWarp !== undefined || n.textBox !== undefined || n.textReveal !== undefined || keyframes.some(k => k.textWarp !== undefined || k.textReveal !== undefined))) fail(path, '텍스트 변형은 text 요소에만 지정할 수 있습니다.');
  if (n.path !== undefined || type === 'path') {
    result.path = validatePath(string(n.path ?? '', `${path}.path`, 100000), `${path}.path`, pathBudget);
  }
  if (n.evidence !== undefined) {
    const e = object(n.evidence, `${path}.evidence`);
    result.evidence = { method: string(e.method, `${path}.evidence.method`), observations: number(e.observations, `${path}.evidence.observations`, 0, 1000000), needsReview: bool(e.needsReview, `${path}.evidence.needsReview`) };
    if (e.note !== undefined) result.evidence.note = string(e.note, `${path}.evidence.note`, 10000);
  }
  return result;
}

function backgroundMotion(value: unknown, duration: number, width: number, height: number, cuts: number[], budget: PathBudget): BackgroundMotion {
  const path = 'project.backgroundMotion', input = object(value, path);
  if (input.mode !== 'on' && input.mode !== 'off') fail(`${path}.mode`, 'on 또는 off만 허용됩니다.');
  let nodeCount = 0, keyCount = 0;
  const channels = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
  const tracks = list(input.tracks, `${path}.tracks`, 256).map((raw, index): BackgroundMotionTrack => {
    const p = `${path}.tracks[${index}]`, t = object(raw, p);
    const start = number(t.start, `${p}.start`, 0, duration), end = number(t.end, `${p}.end`, 0, duration);
    if (end <= start || cuts.some(c => c > start + 1e-10 && c < end - 1e-10)) fail(p, '배경 수식 구간은 유효해야 하며 실제 컷을 넘을 수 없습니다.');
    const polygon = list(t.polygon, `${p}.polygon`, 256).map((v, i): [number, number] => {
      const pair = list(v, `${p}.polygon[${i}]`, 2);
      if (pair.length !== 2) fail(p, 'ROI 좌표에는 x, y가 필요합니다.');
      return [number(pair[0], `${p}.polygon[${i}].x`, 0, width), number(pair[1], `${p}.polygon[${i}].y`, 0, height)];
    });
    const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const area = polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0);
    if (polygon.length < 3 || Math.abs(area) < 2) fail(p, 'ROI에는 넓이가 있는 다각형이 필요합니다.');
    for (let i = 0; i < polygon.length; i++) for (let j = i + 2; j < polygon.length; j++) {
      if (i === 0 && j === polygon.length - 1) continue;
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], c = polygon[j], d = polygon[(j + 1) % polygon.length];
      if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0 && Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))) fail(p, 'ROI 경계가 스스로 교차할 수 없습니다.');
    }
    if (t.interpolation !== 'linear' && t.interpolation !== 'pchip') fail(`${p}.interpolation`, 'linear 또는 pchip만 허용됩니다.');
    const keys = list(t.keys, `${p}.keys`, 2000).map((v, i) => {
      const k = object(v, `${p}.keys[${i}]`), values = list(k.matrix, `${p}.keys[${i}].matrix`, 6);
      if (values.length !== 6) fail(p, 'affine matrix에는 숫자 6개가 필요합니다.');
      const matrix = values.map((n, j) => number(n, `${p}.keys[${i}].matrix[${j}]`, j < 4 ? -8 : -65536, j < 4 ? 8 : 65536)) as AffineMatrix;
      const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
      if (det < 0.01 || det > 64 || Math.hypot(matrix[0], matrix[1]) > 8 || Math.hypot(matrix[2], matrix[3]) > 8) fail(p, '배경 행렬이 접히거나 허용 배율을 넘었습니다.');
      const key: BackgroundMotionTrack['keys'][number] = { time: number(k.time, `${p}.keys[${i}].time`, start, end), matrix };
      for (const name of ['gain', 'bias'] as const) if (k[name] !== undefined) {
        const values = list(k[name], `${p}.keys[${i}].${name}`, 3).map((v, j) => number(v, `${p}.keys[${i}].${name}[${j}]`, name === 'gain' ? 0 : -1, name === 'gain' ? 4 : 1));
        if (values.length !== 3) fail(p, '색상 수식에는 RGB 값 3개가 필요합니다.');
        key[name] = values as [number, number, number];
      }
      return key;
    });
    keyCount += keys.length;
    if (!keys.length || keyCount > 20000 || Math.abs(keys[0].time - start) > 1e-9 || Math.abs(keys[keys.length - 1].time - end) > 1e-9 || keys.some((k, i) => i > 0 && k.time <= keys[i - 1].time)) fail(p, '배경 키는 시작부터 끝까지 오름차순으로 덮어야 하며 총 20,000개 이하여야 합니다.');
    const anchorTime = number(t.anchorTime, `${p}.anchorTime`, start, end);
    const anchorKey = keys.find(k => Math.abs(k.time - anchorTime) < 1e-9);
    if (!anchorKey || anchorKey.matrix.some((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-7)) fail(p, '기준 시각에는 identity 행렬 키가 필요합니다.');
    if (anchorKey.gain?.some(v => Math.abs(v - 1) > 1e-7) || anchorKey.bias?.some(v => Math.abs(v) > 1e-7)) fail(p, '기준 시각의 색상 수식은 gain 1, bias 0이어야 합니다.');
    const a = object(t.anchor, `${p}.anchor`), inputs = list(a.nodes, `${p}.anchor.nodes`, nodeLimit);
    nodeCount += inputs.length;
    if (nodeCount > 32000) fail(p, '배경 앵커의 전체 노드는 32,000개 이하여야 합니다.');
    const nodes = inputs.map((n, i) => {
      const node = validateNode(n, `${p}.anchor.nodes[${i}]`, 1, budget);
      if (node.type === 'text' || node.keyframes.length || node.start !== 0 || node.end !== 1 || node.hidden) fail(p, '앵커에는 0~1초의 정적 비텍스트 노드만 허용됩니다.');
      return node;
    });
    if (new Set(nodes.map(n => n.id)).size !== nodes.length) fail(p, '앵커 노드 ID가 중복되었습니다.');
    const id = string(t.id, `${p}.id`, 200);
    if (!id.trim()) fail(p, '배경 구간 ID가 비어 있습니다.');
    const result: BackgroundMotionTrack = { id, start, end, anchorTime, polygon, featherPx: number(t.featherPx, `${p}.featherPx`, 0, 128), keys, interpolation: t.interpolation, anchor: { background: validateColor(a.background, `${p}.anchor.background`), nodes } };
    if (t.fadeIn !== undefined) result.fadeIn = number(t.fadeIn, `${p}.fadeIn`, 0, end - start);
    if (t.fadeOut !== undefined) result.fadeOut = number(t.fadeOut, `${p}.fadeOut`, 0, end - start);
    if ((result.fadeIn ?? 0) + (result.fadeOut ?? 0) > end - start + 1e-10) fail(p, '진입·해제 구간이 배경 수식 전체 길이를 넘을 수 없습니다.');
    if (t.interpolation === 'pchip') {
      const pc = object(t.pchip, `${p}.pchip`), source = object(pc.channels, `${p}.pchip.channels`);
      const breakpoints = list(pc.breakpoints, `${p}.pchip.breakpoints`, 2000).map((v, i) => number(v, `${p}.pchip.breakpoints[${i}]`, start, end));
      if (breakpoints.length !== keys.length || breakpoints.some((v, i) => Math.abs(v - keys[i].time) > 1e-10)) fail(p, 'PCHIP 구간과 관측 키 시각이 일치해야 합니다.');
      const coefficients = {} as NonNullable<BackgroundMotionTrack['pchip']>['channels'];
      const allChannels = [...channels, 'gainR', 'gainG', 'gainB', 'biasR', 'biasG', 'biasB'] as const;
      for (const [component, channel] of allChannels.entries()) {
        if (component >= 6 && source[channel] === undefined) continue;
        coefficients[channel] = list(source[channel], `${p}.pchip.channels.${channel}`, 1999).map((v, i) => {
          const c = list(v, `${p}.pchip.channels.${channel}[${i}]`, 4).map((n, j) => number(n, `${p}.pchip.channels.${channel}[${i}][${j}]`, -1e12, 1e12));
          if (c.length !== 4 || !keys[i + 1]) fail(p, 'PCHIP 계수는 구간마다 4개가 필요합니다.');
          const dt = keys[i + 1].time - keys[i].time, value = ((c[0] * dt + c[1]) * dt + c[2]) * dt + c[3];
          const expected = (index: number) => component < 6 ? keys[index].matrix[component] : component < 9 ? keys[index].gain?.[component - 6] ?? 1 : keys[index].bias?.[component - 9] ?? 0;
          if (Math.abs(c[3] - expected(i)) > 1e-6 || Math.abs(value - expected(i + 1)) > 1e-6) fail(p, 'PCHIP 곡선은 관측 행렬과 색상의 양 끝값을 보존해야 합니다.');
          const extrema = [0, dt], discriminant = 4 * c[1] * c[1] - 12 * c[0] * c[2];
          if (Math.abs(c[0]) < 1e-15) { if (Math.abs(c[1]) > 1e-15) extrema.push(-c[2] / (2 * c[1])); }
          else if (discriminant >= 0) { const root = Math.sqrt(discriminant); extrema.push((-2 * c[1] + root) / (6 * c[0]), (-2 * c[1] - root) / (6 * c[0])); }
          const min = Math.min(expected(i), expected(i + 1)), max = Math.max(expected(i), expected(i + 1));
          if (extrema.filter(x => x >= 0 && x <= dt).some(x => { const v = ((c[0] * x + c[1]) * x + c[2]) * x + c[3]; return v < min - 1e-6 || v > max + 1e-6; })) fail(p, 'PCHIP 곡선은 구간의 관측값 범위를 벗어날 수 없습니다.');
          return c as [number, number, number, number];
        });
        if (coefficients[channel].length !== keys.length - 1) fail(p, 'PCHIP 계수 구간 수가 맞지 않습니다.');
        for (let i = 1; i < coefficients[channel].length; i++) {
          const previous = coefficients[channel][i - 1], dt = keys[i].time - keys[i - 1].time;
          const left = (3 * previous[0] * dt + 2 * previous[1]) * dt + previous[2], right = coefficients[channel][i][2];
          if (Math.abs(left - right) > 1e-6 * Math.max(1, Math.abs(left), Math.abs(right))) fail(p, 'PCHIP 구간의 기울기는 연속이어야 합니다.');
        }
      }
      result.pchip = { breakpoints, channels: coefficients };
    }
    return result;
  });
  if (new Set(tracks.map(t => t.id)).size !== tracks.length) fail(path, '배경 구간 ID가 중복되었습니다.');
  let active = 0;
  for (const e of tracks.flatMap(t => [{ t: t.start, n: 1 }, { t: t.end, n: -1 }]).sort((a, b) => a.t - b.t || a.n - b.n)) { active += e.n; if (active > 4) fail(path, '동시에 표시하는 배경 수식은 4개 이하여야 합니다.'); }
  return { mode: input.mode, tracks };
}

function foregroundMotion(value: unknown, duration: number, width: number, height: number, fps: number, cuts: number[]): ForegroundMotion {
  const path = 'project.foregroundMotion', input = object(value, path);
  if (input.mode !== 'on' && input.mode !== 'off') fail(`${path}.mode`, 'on 또는 off만 허용됩니다.');
  const tracks = list(input.tracks, `${path}.tracks`, 12288).map((raw, index): ForegroundMotionTrack => {
    const p = `${path}.tracks[${index}]`, t = object(raw, p);
    const start = number(t.start, `${p}.start`, 0, duration), end = number(t.end, `${p}.end`, 0, duration);
    if (end <= start || end >= duration - 1e-10 || Math.abs((end - start) * fps - 1) > 1e-7 || Math.abs(start * fps - Math.round(start * fps)) > 1e-7 || cuts.some(c => c > start + 1e-10 && c <= end + 1e-10)) fail(p, '전경 연결은 실제 컷을 넘지 않는 인접 관측 두 개여야 합니다.');
    const polygon = list(t.polygon, `${p}.polygon`, 64).map((v, i): [number, number] => {
      const xy = list(v, `${p}.polygon[${i}]`, 2); if (xy.length !== 2) fail(p, 'ROI 좌표에는 x, y가 필요합니다.');
      return [number(xy[0], `${p}.polygon[${i}].x`, 0, width), number(xy[1], `${p}.polygon[${i}].y`, 0, height)];
    });
    const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const area = polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0);
    if (polygon.length < 3 || Math.abs(area) < 2) fail(p, 'ROI에는 넓이가 있는 다각형이 필요합니다.');
    for (let i = 0; i < polygon.length; i++) for (let j = i + 2; j < polygon.length; j++) {
      if (i === 0 && j === polygon.length - 1) continue;
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], c = polygon[j], d = polygon[(j + 1) % polygon.length];
      if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0 && Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))) fail(p, 'ROI 경계가 스스로 교차할 수 없습니다.');
    }
    const values = list(t.forward, `${p}.forward`, 6);
    if (values.length !== 6) fail(p, '전경 행렬에는 숫자 6개가 필요합니다.');
    const forward = values.map((v, i) => number(v, `${p}.forward[${i}]`, i < 4 ? -4 : -16384, i < 4 ? 4 : 16384)) as AffineMatrix;
    const determinant = forward[0] * forward[3] - forward[1] * forward[2];
    if (determinant < 0.05 || determinant > 16) fail(p, '전경 행렬이 접히거나 허용 배율을 넘었습니다.');
    // det(I + alpha(T-I)) is quadratic: reject folds anywhere in the interval.
    const a = (forward[0] - 1) * (forward[3] - 1) - forward[1] * forward[2], b = forward[0] + forward[3] - 2;
    const probes = [0, 1]; if (Math.abs(a) > 1e-15) probes.push(-b / (2 * a));
    if (probes.filter(x => x >= 0 && x <= 1).some(x => 1 + b * x + a * x * x < 0.01)) fail(p, '전경 중간 행렬이 접힐 수 없습니다.');
    const id = string(t.id, `${p}.id`, 200); if (!id.trim()) fail(p, '전경 구간 ID가 비어 있습니다.');
    const result: ForegroundMotionTrack = { id, start, end, polygon, featherPx: number(t.featherPx, `${p}.featherPx`, 0, 64), forward };
    if (t.appearance !== undefined) {
      const appearance = object(t.appearance, `${p}.appearance`);
      result.appearance = { midpoint: number(appearance.midpoint, `${p}.appearance.midpoint`, .15, .85), sharpness: number(appearance.sharpness, `${p}.appearance.sharpness`, 1, 4) };
    }
    if (t.viewportFallback !== undefined) {
      if ((t.viewportFallback !== 'from' && t.viewportFallback !== 'to') || result.appearance === undefined) fail(`${p}.viewportFallback`, '관측 경계 대체는 appearance가 있는 from/to만 허용됩니다.');
      result.viewportFallback = t.viewportFallback;
    }
    if (t.label !== undefined) result.label = string(t.label, `${p}.label`, 500);
    return result;
  });
  if (new Set(tracks.map(t => t.id)).size !== tracks.length) fail(path, '전경 구간 ID가 중복되었습니다.');
  let active = 0;
  for (const event of tracks.flatMap(t => [{ time: t.start, delta: 1 }, { time: t.end, delta: -1 }]).sort((a, b) => a.time - b.time || a.delta - b.delta)) { active += event.delta; if (active > 16) fail(path, '동시에 표시하는 전경 수식은 16개 이하여야 합니다.'); }
  return { mode: input.mode, tracks };
}

function validateProject(value: unknown): MotionProject {
  const p = object(value, 'project');
  if (p.schemaVersion !== 1) fail('project.schemaVersion', '지원하는 프로젝트 버전은 1입니다.');
  const duration = number(p.duration, 'project.duration', 0.01, 3600);
  const pathBudget: PathBudget = { bytes: 0, coordinates: 0 };
  const inputs = list(p.nodes, 'project.nodes', nodeLimit);
  let keyCount = 0;
  for (const [i, input] of inputs.entries()) {
    keyCount += list(object(input, `project.nodes[${i}]`).keyframes, `project.nodes[${i}].keyframes`, 5000).length;
    if (keyCount > 300000) fail('project.nodes', '전체 키프레임은 300,000개 이하여야 합니다.');
  }
  const nodes = inputs.map((n, i) => validateNode(n, `project.nodes[${i}]`, duration, pathBudget));
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) fail('project.nodes', '요소 ID가 중복되었습니다.');
  const warpEvents = nodes.filter(n => n.textWarp || n.keyframes.some(k => k.textWarp)).flatMap(n => [{ time: n.start, delta: 1 }, { time: n.end, delta: -1 }]).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let activeWarps = 0;
  for (const event of warpEvents) { activeWarps += event.delta; if (activeWarps > 16) fail('project.nodes', '동시에 표시하는 원근 텍스트는 16개 이하여야 합니다.'); }
  const result: MotionProject = {
    schemaVersion: 1, id: string(p.id, 'project.id', 200), name: string(p.name, 'project.name', 1000),
    width: number(p.width, 'project.width', 1, 16384), height: number(p.height, 'project.height', 1, 16384),
    duration, fps: number(p.fps, 'project.fps', 1, 240), background: validateColor(p.background, 'project.background'), nodes,
    scenes: list(p.scenes, 'project.scenes', 1000).map((s, i) => {
      const scene = object(s, `project.scenes[${i}]`);
      const start = number(scene.start, `project.scenes[${i}].start`, 0, duration);
      const end = number(scene.end, `project.scenes[${i}].end`, 0, duration);
      if (end <= start) fail(`project.scenes[${i}]`, '장면 끝 시간은 시작보다 커야 합니다.');
      return { id: string(scene.id, `project.scenes[${i}].id`, 200), name: string(scene.name, `project.scenes[${i}].name`), start, end };
    }),
  };
  if (p.backgroundKeyframes !== undefined) {
    result.backgroundKeyframes = list(p.backgroundKeyframes, 'project.backgroundKeyframes', 10000).map((v, i) => {
      const k = object(v, `project.backgroundKeyframes[${i}]`);
      return { time: number(k.time, `project.backgroundKeyframes[${i}].time`, 0, duration), color: validateColor(k.color, `project.backgroundKeyframes[${i}].color`) };
    }).sort((a, b) => a.time - b.time);
    if (result.backgroundKeyframes.some((k, i, a) => i > 0 && k.time === a[i - 1].time)) fail('project.backgroundKeyframes', '중복된 배경 키프레임 시각입니다.');
  }
  if (p.temporal !== undefined) {
    const temporal = object(p.temporal, 'project.temporal');
    if (temporal.mode !== 'blend' && temporal.mode !== 'off' && temporal.mode !== 'frames') fail('project.temporal.mode', 'blend, off 또는 frames만 허용됩니다.');
    const sampleFps = number(temporal.sampleFps, 'project.temporal.sampleFps', 1, 240);
    const cuts = list(temporal.cuts, 'project.temporal.cuts', 1000).map((v, i) => number(v, `project.temporal.cuts[${i}]`, 0, duration));
    if (cuts.some((v, i) => i > 0 && v <= cuts[i - 1])) fail('project.temporal.cuts', '컷 시각은 중복 없이 오름차순이어야 합니다.');
    result.temporal = { mode: temporal.mode, sampleFps, cuts };
    if (temporal.mode === 'blend') {
      const opaque = (color: string): boolean => {
        const c = color.toLowerCase();
        if (c === 'none' || c === 'transparent') return false;
        if (c.startsWith('#')) return c.length === 4 || c.length === 7 || c.length === 5 && c.endsWith('f') || c.length === 9 && c.endsWith('ff');
        const channels = c.match(/\((.*)\)/)?.[1].replace(/[,/]/g, ' ').trim().split(/\s+/);
        return !channels || channels.length === 3 || (channels[3].endsWith('%') ? parseFloat(channels[3]) >= 100 : Number(channels[3]) >= 1);
      };
      if (!opaque(result.background) || result.backgroundKeyframes?.some(k => !opaque(k.color))) fail('project.temporal', '프레임 연결에는 불투명 배경이 필요합니다.');
    }
  }
  if (p.backgroundMotion !== undefined) result.backgroundMotion = backgroundMotion(p.backgroundMotion, duration, result.width, result.height, result.temporal?.cuts ?? [], pathBudget);
  if (p.foregroundMotion !== undefined) result.foregroundMotion = foregroundMotion(p.foregroundMotion, duration, result.width, result.height, result.temporal?.sampleFps ?? result.fps, result.temporal?.cuts ?? []);
  if (p.source !== undefined) {
    const source = object(p.source, 'project.source');
    const url = string(source.url, 'project.source.url', 2048);
    // Imported projects must not cause requests to arbitrary origins or executable URL schemes.
    if (!/^\/api\/media\/[a-zA-Z0-9._-]+$/.test(url)) fail('project.source.url', '로컬 /api/media/ 영상 경로만 허용됩니다.');
    result.source = { name: string(source.name, 'project.source.name'), url, width: number(source.width, 'project.source.width', 1, 16384), height: number(source.height, 'project.source.height', 1, 16384), duration: number(source.duration, 'project.source.duration', 0.01, 3600), fps: number(source.fps, 'project.source.fps', 1, 240) };
  }
  if (p.analysis !== undefined) {
    const a = object(p.analysis, 'project.analysis');
    result.analysis = { engine: string(a.engine, 'project.analysis.engine'), sampleCount: number(a.sampleCount, 'project.analysis.sampleCount', 0, 1000000), warnings: list(a.warnings, 'project.analysis.warnings', 1000).map((v, i) => string(v, `project.analysis.warnings[${i}]`, 10000)), createdAt: string(a.createdAt, 'project.analysis.createdAt', 100) };
  }
  if (p.fonts !== undefined) {
    let total = 0;
    result.fonts = list(p.fonts, 'project.fonts', 8).map((value, i): EmbeddedFont => {
      const path = `project.fonts[${i}]`, f = object(value, path);
      const family = string(f.family, `${path}.family`, 100);
      if (!/^[\p{L}\p{N} _-]+$/u.test(family)) fail(`${path}.family`, '글꼴 이름에는 문자, 숫자, 공백, 밑줄, 하이픈만 허용됩니다.');
      if (!['font/ttf', 'font/otf', 'font/woff2'].includes(String(f.mimeType))) fail(`${path}.mimeType`, 'TTF, OTF, WOFF2만 허용됩니다.');
      const data = string(f.data, `${path}.data`, 5592408);
      if (!data || data.length % 4 || /[^A-Za-z0-9+/=]/.test(data) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail(`${path}.data`, '올바른 base64 글꼴 데이터가 필요합니다.');
      const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      total += bytes;
      if (bytes > 4 * 1024 * 1024 || total > 8 * 1024 * 1024) fail(path, '글꼴은 개별 4MiB, 합계 8MiB 이하여야 합니다.');
      const signature = atob(data.slice(0, 8)).slice(0, 4);
      const validSignature = f.mimeType === 'font/woff2' ? signature === 'wOF2' : f.mimeType === 'font/otf' ? signature === 'OTTO' : signature === '\u0000\u0001\u0000\u0000' || signature === 'true';
      if (!validSignature || bytes < 12) fail(`${path}.data`, '글꼴 파일 헤더가 MIME 유형과 일치하지 않습니다.');
      const font: EmbeddedFont = { family, mimeType: f.mimeType as EmbeddedFont['mimeType'], data };
      if (f.weight !== undefined) font.weight = number(f.weight, `${path}.weight`, 1, 1000);
      if (f.style !== undefined) { if (f.style !== 'normal' && f.style !== 'italic') fail(`${path}.style`, 'normal 또는 italic만 허용됩니다.'); font.style = f.style; }
      if (f.license !== undefined) font.license = string(f.license, `${path}.license`, 20000);
      return font;
    });
  }
  return result;
}

return { validateProject, validateNode, validateColor };
}

export const { validateProject, validateNode, validateColor } = createProjectValidator(MAX_PROJECT_NODES);

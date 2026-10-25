import { evaluateNode, type EvaluatedNode } from '../engine';
import type { MotionNode, MotionProject } from '../types';

/** A deliberate color edit replaces inferred shading while retaining geometry and timing. */
export function withSolidFill(node: MotionNode, fill: string): MotionNode {
  return { ...node, fill, gradient: undefined, paintRegions: undefined, keyframes: node.keyframes.map(({ fill: _fill, gradient: _gradient, paintRegions: _paintRegions, ...frame }) => frame) };
}

const colorCache = new Map<string, readonly [number, number, number] | null>();
let colorContext: CanvasRenderingContext2D | null | undefined;

/** Normalize supported CSS color notation before comparing compression-shifted colors. */
export function colorRgb(value: string): readonly [number, number, number] | null {
  const key = value.trim().toLowerCase();
  if (colorCache.has(key)) return colorCache.get(key)!;
  if (key === 'none' || key === 'transparent') return null;
  if (colorContext === undefined) colorContext = document.createElement('canvas').getContext('2d');
  if (!colorContext || !CSS.supports('color', key)) return null;
  colorContext.fillStyle = '#000000';
  colorContext.fillStyle = key;
  const normalized = colorContext.fillStyle;
  let result: readonly [number, number, number] | null = null;
  if (/^#[a-f\d]{6}$/i.test(normalized)) result = [parseInt(normalized.slice(1, 3), 16), parseInt(normalized.slice(3, 5), 16), parseInt(normalized.slice(5, 7), 16)];
  else {
    const values = normalized.match(/[\d.]+/g)?.map(Number);
    if (values && values.length >= 3 && (values.length < 4 || values[3] > 0)) result = [values[0], values[1], values[2]];
  }
  colorCache.set(key, result);
  return result;
}

export function similarFillIds(nodes: MotionNode[], fill: string, distance = 24): Set<string> {
  const source = colorRgb(fill);
  if (!source) return new Set();
  return new Set(nodes.filter(node => {
    if (node.locked) return false;
    const candidate = colorRgb(node.fill);
    return candidate !== null && Math.hypot(...source.map((channel, index) => channel - candidate[index])) <= distance;
  }).map(node => node.id));
}

type PreparedEvaluator = (nodeId: string, time: number) => EvaluatedNode | undefined;

export function onCanvas(node: MotionNode, time: number, project: Pick<MotionProject, 'width' | 'height'>, evaluate?: PreparedEvaluator): boolean {
  const current = evaluate ? evaluate(node.id, time) : evaluateNode(node, time);
  if (!current?.visible) return false;
  const angle = current.rotation * Math.PI / 180;
  const halfWidth = (Math.abs(current.width * Math.cos(angle)) + Math.abs(current.height * Math.sin(angle))) / 2 + current.strokeWidth;
  const halfHeight = (Math.abs(current.width * Math.sin(angle)) + Math.abs(current.height * Math.cos(angle))) / 2 + current.strokeWidth;
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  return centerX + halfWidth > 0 && centerX - halfWidth < project.width && centerY + halfHeight > 0 && centerY - halfHeight < project.height;
}

/** Prefer a settled central frame, then a visible nearby frame if the middle is occluded. */
export function selectionTime(node: MotionNode, project: MotionProject, evaluate?: PreparedEvaluator): number {
  const span = node.end - node.start;
  const middle = node.start + span / 2;
  const candidates = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9].map(ratio => node.start + span * ratio);
  const visible = candidates.filter(time => onCanvas(node, time, project, evaluate));
  const opacity = (time: number) => (evaluate ? evaluate(node.id, time) : evaluateNode(node, time))?.opacity ?? 0;
  const settled = visible.find(time => opacity(time) >= 0.85);
  return settled ?? visible.sort((a, b) => opacity(b) - opacity(a))[0] ?? middle;
}

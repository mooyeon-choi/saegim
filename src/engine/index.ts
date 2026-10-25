import type { MotionNode, MotionProject, MotionTemporal } from '../types';
import { createMotionRuntime } from './runtime';
import type { EvaluatedNode, RenderOptions, TemporalFramePair } from './runtime';
import { validateNode, validateProject } from './validate';

const runtime = createMotionRuntime();

function validTime(time: number): number {
  if (typeof time !== 'number' || !Number.isFinite(time)) throw new Error('time: 유한한 초 단위 숫자가 필요합니다.');
  return time;
}

/** Display time for a source observation; the playback clock remains continuous. */
export function getFrameTime(temporal: MotionTemporal | undefined, duration: number, time: number): number {
  return temporal?.mode === 'frames' ? runtime.framePlan(temporal, duration, validTime(time)).from : validTime(time);
}

export function renderSvg(project: MotionProject, time: number, options?: RenderOptions): string {
  return runtime.render(validateProject(project), validTime(time), options);
}

/** Validate and copy once for timeline playback. The private snapshot is isolated
 * from later edits to the input; prepare a new renderer when the project changes. */
export interface ProjectRenderer {
  (time: number, options?: RenderOptions): string;
  framePair(time: number, options?: RenderOptions): TemporalFramePair;
  evaluate(nodeId: string, time: number): EvaluatedNode | undefined;
}

export function createProjectRenderer(project: MotionProject): ProjectRenderer {
  const snapshot = validateProject(project);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(snapshot);
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const render = (time: number, options?: RenderOptions) => runtime.render(snapshot, validTime(time), options);
  return Object.assign(render, {
    framePair(time: number, options?: RenderOptions) { return runtime.framePair(snapshot, validTime(time), options); },
    evaluate(nodeId: string, time: number): EvaluatedNode | undefined {
      validTime(time);
      const node = nodes.get(nodeId);
      // Nested observations are frozen once, avoiding a full keyframe/path clone
      // for every filter evaluation while protecting the private snapshot.
      const at = snapshot.temporal?.mode === 'frames' ? runtime.framePlan(snapshot.temporal, snapshot.duration, time).from : time;
      return node ? runtime.evaluate(node, at) : undefined;
    },
  });
}

export function evaluateNode(node: MotionNode, time: number) {
  return runtime.evaluate(validateNode(node), validTime(time));
}

export { validateProject } from './validate';
export { exportHtml, exportProjectJson, downloadHtml, downloadProject, downloadZip, createProjectZip } from './export';
export { MAX_PROJECT_BYTES, MAX_DOCUMENT_BYTES, MAX_PROJECT_NODES } from './limits';
export { validateComposition, validateDocument, parseDocument, encodeSegment, decodeSegment, getSegmentAt, createCompositionPlayer, replaceCompositionSegment } from './composition';
export type { CompositionPlayer, CompositionFrame, CompositionRenderer, SegmentPosition } from './composition';
export type { EvaluatedNode, RenderOptions, TemporalFramePair } from './runtime';

export { exportCompositionHtml, exportCompositionJson } from './compositionExport';

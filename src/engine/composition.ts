import type { MotionComposition, MotionDocument, MotionProject, MotionSegment } from '../types';
import type { EvaluatedNode, RenderOptions, TemporalFramePair } from './runtime';
import { createMotionRuntime } from './runtime';
import { validateProject } from './validate';
import { MAX_DOCUMENT_BYTES, MAX_PROJECT_BYTES, MAX_PROJECT_NODES } from './limits';

export interface SegmentPosition { segment: MotionSegment; index: number; localTime: number; time: number }
export interface CompositionRenderer {
  (time: number, options?: RenderOptions): string;
  framePair(time: number, options?: RenderOptions): TemporalFramePair;
  evaluate(nodeId: string, time: number): EvaluatedNode | undefined;
}
export interface CompositionFrame extends SegmentPosition { project: MotionProject; svg: string; renderer: CompositionRenderer }
export interface CompositionPlayer {
  seek(time: number, options?: RenderOptions): Promise<CompositionFrame | null>;
  framePair(time: number, options?: RenderOptions): TemporalFramePair | Promise<TemporalFramePair | null>;
  setProjectOverride(segmentId: string, project: MotionProject): void;
  clearProjectOverride(): void;
  preload(time: number): Promise<void>;
  dispose(): void;
  readonly cachedSegmentIds: string[];
}

/** Closed factory: exported HTML executes exactly this decoder and scheduler. */
export function createCompositionRuntime(
  validate: (value: unknown) => MotionProject,
  render: (project: MotionProject, time: number, options?: RenderOptions) => string,
  evaluate: (node: MotionProject['nodes'][number], time: number) => EvaluatedNode,
  projectLimit = 96 * 1024 * 1024,
  documentLimit = 256 * 1024 * 1024,
  nodeLimit = 8000,
  runtime?: ReturnType<typeof createMotionRuntime>,
) {
  const before = (a: number, b: number) => a < b && b - a > 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
  function error(message: string): never { throw new Error(`composition: ${message}`); }
  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) error('객체가 필요합니다.');
    return value as Record<string, unknown>;
  }
  function text(value: unknown, maximum: number): string {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) error('문자열이 유효하지 않습니다.');
    return value;
  }
  function num(value: unknown, minimum: number, maximum: number, integer = false): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || integer && !Number.isInteger(value)) error('숫자가 허용 범위를 벗어났습니다.');
    return value;
  }
  function byteLength(value: string, limit: number): number {
    let size = value.length;
    if (size > limit) error(`JSON 크기가 ${Math.round(limit / 1024 / 1024)}MiB 한도를 넘습니다.`);
    for (const match of value.matchAll(/[^\x00-\x7f]/gu)) {
      const code = match[0].codePointAt(0)!;
      size += code > 0x7ff ? 2 : 1;
      if (size > limit) error(`JSON 크기가 ${Math.round(limit / 1024 / 1024)}MiB 한도를 넘습니다.`);
    }
    return size;
  }
  function segmentMetadata(input: unknown): Omit<MotionSegment, 'encoding' | 'data' | 'uncompressedBytes' | 'nodeCount'> {
    const v = record(input), start = num(v.start, 0, 60), end = num(v.end, 0, 60), id = text(v.id, 200);
    if (end <= start || !id.trim()) error('청크의 ID 또는 시간 범위가 유효하지 않습니다.');
    return { id, name: text(v.name, 1000), start, end };
  }
  function segment(input: unknown): MotionSegment {
    const v = record(input), metadata = segmentMetadata(v);
    if (v.encoding !== 'gzip-base64') error('gzip-base64 청크만 허용됩니다.');
    const data = text(v.data, documentLimit);
    // Scan without a recursive/large regex: malicious giant base64 cannot overflow the regex stack.
    if (data.length < 28 || data.length % 4 || /[^A-Za-z0-9+/=]/.test(data)) error('청크 base64 데이터가 유효하지 않습니다.');
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    if (data.slice(0, -padding || undefined).includes('=')) error('base64 padding이 유효하지 않습니다.');
    if (atob(data.slice(0, 4)).slice(0, 3) !== '\x1f\x8b\x08') error('gzip 헤더가 없습니다.');
    return { ...metadata, encoding: 'gzip-base64', data, uncompressedBytes: num(v.uncompressedBytes, 1, projectLimit, true), nodeCount: num(v.nodeCount, 0, nodeLimit, true) };
  }
  function validateComposition(input: unknown): MotionComposition {
    const v = record(input);
    if (v.schemaVersion !== 2) error('schemaVersion 2가 필요합니다.');
    // Reuse schema 1's metadata/source/color sanitizers, without expanding any payload.
    const metadata = validate({ ...v, schemaVersion: 1, nodes: [], scenes: [], fonts: undefined, backgroundKeyframes: undefined });
    const duration = num(metadata.duration, 0.01, 60);
    if (!Array.isArray(v.segments) || v.segments.length < 1 || v.segments.length > 64) error('청크는 1~64개여야 합니다.');
    let payloadSize = 0;
    const segments = v.segments.map(value => {
      const result = segment(value); payloadSize += result.data.length;
      if (payloadSize > documentLimit) error('압축 컨테이너가 256MiB 한도를 넘습니다.');
      return result;
    });
    if (new Set(segments.map(s => s.id)).size !== segments.length) error('청크 ID가 중복되었습니다.');
    let end = 0;
    for (const current of segments) {
      if (before(current.start, end) || before(end, current.start)) error('청크는 0초부터 연속되고 겹치지 않아야 합니다.');
      end = current.end;
    }
    if (before(end, duration) || before(duration, end)) error('마지막 청크 끝은 전체 길이와 같아야 합니다.');
    const result: MotionComposition = { schemaVersion: 2, id: metadata.id, name: metadata.name, width: metadata.width, height: metadata.height, duration, fps: metadata.fps, background: metadata.background, segments };
    if (metadata.temporal) result.temporal = metadata.temporal;
    if (metadata.backgroundMotion) result.backgroundMotion = metadata.backgroundMotion;
    if (metadata.foregroundMotion) result.foregroundMotion = metadata.foregroundMotion;
    if (metadata.source) result.source = metadata.source;
    if (metadata.analysis) result.analysis = metadata.analysis;
    // Count escaped metadata plus base64 without allocating another huge JSON string.
    const overhead = JSON.stringify({ ...result, segments: segments.map(s => ({ ...s, data: '' })) });
    if (byteLength(overhead, documentLimit) + payloadSize > documentLimit) error('압축 컨테이너 JSON이 256MiB 한도를 넘습니다.');
    return result;
  }
  function validateDocument(input: unknown): MotionDocument {
    return record(input).schemaVersion === 2 ? validateComposition(input) : validate(input);
  }
  function parseDocument(json: string): MotionDocument {
    byteLength(json, documentLimit);
    const input = JSON.parse(json);
    if (input?.schemaVersion !== 2) byteLength(json, projectLimit);
    return validateDocument(input);
  }
  async function streamBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = stream.getReader(), parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) { await reader.cancel(); error('청크의 실제 압축 해제 크기가 허용 한도를 넘습니다.'); }
        parts.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.length; }
    return joined;
  }
  async function decodeSegment(input: MotionSegment): Promise<MotionProject> {
    const s = segment(input);
    if (typeof DecompressionStream !== 'function') error('이 브라우저는 gzip 해제를 지원하지 않습니다. 최신 Chromium, Firefox 또는 Safari를 사용해 주세요.');
    const binary = atob(s.data), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    // Stop at the declared size as well as the hard ceiling; declarations cannot hide a zip bomb.
    const decoded = await streamBytes(stream, Math.min(s.uncompressedBytes, projectLimit));
    if (decoded.length !== s.uncompressedBytes) error('압축 해제 크기가 청크 선언과 다릅니다.');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    const project = validate(JSON.parse(json));
    if (project.source) error('원본 영상 참조는 전체 composition에만 저장해 주세요.');
    if (project.nodes.length !== s.nodeCount || Math.abs(project.duration - (s.end - s.start)) > 1e-8) error('청크의 요소 수 또는 길이가 선언과 다릅니다.');
    return project;
  }
  async function encodeSegment(existing: Pick<MotionSegment, 'id' | 'name' | 'start' | 'end'>, value: MotionProject): Promise<MotionSegment> {
    const metadata = segmentMetadata(existing), project = validate(value);
    delete project.source;
    if (Math.abs(project.duration - (metadata.end - metadata.start)) > 1e-8) error('청크 길이와 프로젝트 길이가 다릅니다.');
    const json = JSON.stringify(project), size = byteLength(json, projectLimit);
    if (typeof CompressionStream !== 'function') error('이 브라우저는 gzip 압축을 지원하지 않습니다.');
    const compressed = await streamBytes(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip')), documentLimit * 3 / 4);
    const slices: string[] = [];
    for (let i = 0; i < compressed.length; i += 32768) slices.push(String.fromCharCode(...compressed.subarray(i, i + 32768)));
    return { ...metadata, encoding: 'gzip-base64', data: btoa(slices.join('')), uncompressedBytes: size, nodeCount: project.nodes.length };
  }
  function position(doc: MotionComposition, requested: number): SegmentPosition {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) error('seek에는 유한한 초 단위 숫자가 필요합니다.');
    const time = Math.max(0, Math.min(doc.duration, requested));
    let index = doc.segments.findIndex(s => before(time, s.end));
    if (index < 0) index = doc.segments.length - 1;
    const segment = doc.segments[index];
    return { segment, index, time, localTime: Math.max(0, Math.min(segment.end - segment.start, time - segment.start)) };
  }
  function getSegmentAt(doc: MotionComposition, time: number): SegmentPosition { return position(validateComposition(doc), time); }
  function freeze(value: unknown): void {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  function createCompositionPlayer(value: MotionComposition): CompositionPlayer {
    const doc = validateComposition(value); freeze(doc);
    const renderers = new WeakMap<MotionProject, CompositionRenderer>();
    const cache = new Map<number, MotionProject>(), pending = new Map<number, Promise<MotionProject>>();
    const versions = new Map<number, number>();
    const endpoints = runtime?.createEndpointCache();
    const assets = new WeakMap<MotionProject, WeakMap<MotionProject, { fontCss: string; fontMetadata: string }>>();
    let queue: Promise<unknown> = Promise.resolve(), generation = 0, pairGeneration = 0, disposed = false;
    let seekWanted = new Set([0, 1]), pairWanted = new Set<number>(), overrideIndex: number | undefined;
    const explicitPreloads = new Map<number, number>();
    function remember(index: number, project: MotionProject) {
      cache.delete(index); cache.set(index, project);
      while (cache.size > 2) cache.delete(cache.keys().next().value!);
    }
    function checkProject(project: MotionProject, index: number) {
      if (project.width !== doc.width || project.height !== doc.height || project.fps !== doc.fps) error('청크 화면 크기 또는 FPS가 전체 composition과 다릅니다.');
      if (Math.abs(project.duration - (doc.segments[index].end - doc.segments[index].start)) > 1e-8) error('청크 길이가 전체 composition과 다릅니다.');
      if (doc.temporal?.mode === 'blend') {
        // Reuse the opaque-background guard without validating every path again.
        validate({ ...project, nodes: [], fonts: undefined, temporal: { ...doc.temporal, cuts: [] } });
      }
    }
    function load(index: number): Promise<MotionProject> {
      if (disposed) return Promise.reject(new Error('composition player가 닫혔습니다.'));
      const hit = cache.get(index);
      if (hit) { remember(index, hit); return Promise.resolve(hit); }
      const prior = pending.get(index); if (prior) return prior;
      const version = versions.get(index) ?? 0;
      // Serialized decompression bounds peak memory, including rapid seeks.
      const work = queue.catch(() => undefined).then(async () => {
        if (disposed) error('composition player가 닫혔습니다.');
        if (!seekWanted.has(index) && !pairWanted.has(index) && !explicitPreloads.has(index)) error('탐색 요청이 바뀌어 대기 중인 청크를 건너뜁니다.');
        const project = await decodeSegment(doc.segments[index]);
        checkProject(project, index);
        if (disposed) error('composition player가 닫혔습니다.');
        // An edit arriving during inflation must win over the old compressed copy.
        if ((versions.get(index) ?? 0) !== version) {
          const edited = cache.get(index); if (edited) return edited;
          error('편집 중 청크가 바뀌었습니다. 다시 탐색해 주세요.');
        }
        freeze(project); remember(index, project); return project;
      });
      pending.set(index, work); queue = work;
      void work.finally(() => { pending.delete(index); }).catch(() => undefined);
      return work;
    }
    function rendererFor(project: MotionProject): CompositionRenderer {
      let renderer = renderers.get(project);
      if (!renderer) {
        const nodes = new Map(project.nodes.map(node => [node.id, node]));
        const validTime = (t: number) => { if (typeof t !== 'number' || !Number.isFinite(t)) error('유한한 시각이 필요합니다.'); return t; };
        renderer = Object.assign((t: number, settings?: RenderOptions) => render(project, validTime(t), settings), {
          framePair(t: number, settings?: RenderOptions) { if (!runtime) error('프레임 연결 런타임이 없습니다.'); return runtime.framePair(project, validTime(t), settings); },
          evaluate(id: string, t: number) { validTime(t); const node = nodes.get(id); return node ? evaluate(node, t) : undefined; },
        });
        renderers.set(project, renderer);
      }
      return renderer;
    }
    function combinedAssets(a: MotionProject, b: MotionProject) {
      if (!runtime) error('프레임 연결 런타임이 없습니다.');
      if (a === b) return runtime.fontAssets(a);
      let bySecond = assets.get(a); if (!bySecond) { bySecond = new WeakMap(); assets.set(a, bySecond); }
      const prior = bySecond.get(b); if (prior) return prior;
      const fonts = [...(a.fonts ?? [])];
      for (const f of b.fonts ?? []) if (!fonts.some(v => v.family === f.family && v.data === f.data && v.weight === f.weight && v.style === f.style)) fonts.push(f);
      const merged = runtime.fontAssets({ ...a, fonts }); bySecond.set(b, merged); return merged;
    }
    function buildPair(plan: ReturnType<NonNullable<typeof runtime>['framePlan']>, fromPosition: SegmentPosition, toPosition: SegmentPosition | undefined, fromProject: MotionProject, toProject: MotionProject, options: RenderOptions): TemporalFramePair {
      if (!runtime || !endpoints) error('프레임 연결 런타임이 없습니다.');
      const redraw = doc.temporal?.mode === 'frames';
      const bg = runtime.backgroundFrame(redraw ? undefined : doc.backgroundMotion, plan.time, doc.width, doc.height);
      const fg = runtime.foregroundFrame(redraw ? undefined : doc.foregroundMotion, plan, doc.width, doc.height);
      const from = { ...runtime.endpoint(fromProject, fromPosition.localTime, options, endpoints, bg, fg, 'from'), time: plan.from };
      const to = toPosition ? { ...runtime.endpoint(toProject, toPosition.localTime, options, endpoints, bg, fg, 'to') } : undefined;
      if (to) to.time = plan.to!;
      const aligned = runtime.foregroundAssets(fg, from, to, doc.width, doc.height);
      return { time: plan.time, from, ...(to ? { to } : {}), mix: plan.mix, cut: plan.cut, ...combinedAssets(fromProject, toProject), ...aligned,
        sharedDefinitions: bg.sharedDefinitions + aligned.sharedDefinitions, sharedTransforms: bg.sharedTransforms, backgroundStatus: bg.backgroundStatus };
    }
    function warmNext(pair: TemporalFramePair) {
      const fromIndex = position(doc, pair.from.time).index;
      const toIndex = pair.to ? position(doc, pair.to.time).index : fromIndex;
      if (fromIndex === toIndex && fromIndex + 1 < doc.segments.length) {
        pairWanted.add(fromIndex + 1);
        void load(fromIndex + 1).catch(() => undefined);
      }
    }
    async function resolvePair(time: number, options: RenderOptions = {}, channel: 'seek' | 'pair'): Promise<TemporalFramePair> {
      if (!runtime || !endpoints) error('프레임 연결 런타임이 없습니다.');
      const plan = runtime.framePlan(doc.temporal, doc.duration, time);
      const fromPosition = position(doc, plan.from), toPosition = plan.to === undefined ? undefined : position(doc, plan.to);
      const wanted = new Set([fromPosition.index, ...(toPosition ? [toPosition.index] : [])]);
      if (channel === 'pair') pairWanted = wanted; else seekWanted = wanted;
      const fromProject = await load(fromPosition.index);
      const toProject = toPosition ? await load(toPosition.index) : fromProject;
      return buildPair(plan, fromPosition, toPosition, fromProject, toProject, options);
    }
    return {
      async seek(time, options) {
        const current = ++generation;
        const redrawPlan = runtime && doc.temporal?.mode === 'frames' ? runtime.framePlan(doc.temporal, doc.duration, time) : undefined;
        const located = position(doc, redrawPlan?.from ?? time);
        seekWanted = new Set([located.index, located.index + 1]);
        try {
          const project = await load(located.index);
          if (disposed || current !== generation) return null;
          const renderer = rendererFor(project);
          let svg: string;
          if (runtime && redrawPlan) {
            svg = runtime.renderSample(project, located.localTime, options);
          } else if (runtime && doc.backgroundMotion?.mode === 'on') {
            svg = runtime.compose(await resolvePair(time, options, 'seek'), doc.width, doc.height, doc.name);
          } else if (runtime && doc.temporal?.mode === 'blend') {
            const plan = runtime.framePlan(doc.temporal, doc.duration, located.time);
            if (!plan.mix) {
              // Use legacy IDs, assets and local arithmetic at exact observations.
              const at = position(doc, plan.from), sample = at.index === located.index ? project : await load(at.index);
              svg = runtime.renderSample(sample, at.localTime, options);
            } else svg = runtime.compose(await resolvePair(time, options, 'seek'), doc.width, doc.height, doc.name);
          } else svg = runtime ? runtime.renderSample(project, located.localTime, options) : renderer(located.localTime, options);
          if (disposed || current !== generation) return null;
          if (located.index + 1 < doc.segments.length && !pairWanted.size) void load(located.index + 1).catch(() => undefined);
          return { ...located, ...(redrawPlan ? { time: redrawPlan.time } : {}), project, svg, renderer };
        } catch (cause) { if (current !== generation && !disposed) return null; throw cause; }
      },
      framePair(time, options = {}) {
        if (disposed) error('composition player가 닫혔습니다.');
        if (!runtime || !endpoints) error('프레임 연결 런타임이 없습니다.');
        const current = ++pairGeneration, plan = runtime.framePlan(doc.temporal, doc.duration, time);
        const fromPosition = position(doc, plan.from), toPosition = plan.to === undefined ? undefined : position(doc, plan.to);
        pairWanted = new Set([fromPosition.index, ...(toPosition ? [toPosition.index] : [])]);
        const fromProject = cache.get(fromPosition.index), toProject = toPosition ? cache.get(toPosition.index) : fromProject;
        if (fromProject && toProject) {
          // Ordinary animation never enters a pending/await state. Only a real
          // gzip cache miss pauses a caller's playback clock.
          remember(fromPosition.index, fromProject);
          if (toPosition) remember(toPosition.index, toProject);
          const pair = buildPair(plan, fromPosition, toPosition, fromProject, toProject, options);
          warmNext(pair); return pair;
        }
        return resolvePair(time, options, 'pair').then(pair => {
          if (disposed || current !== pairGeneration) return null;
          warmNext(pair); return pair;
        }).catch(cause => { if (current !== pairGeneration && !disposed) return null; throw cause; });
      },
      setProjectOverride(id, value) {
        if (disposed) error('composition player가 닫혔습니다.');
        const index = doc.segments.findIndex(s => s.id === id); if (index < 0) error('편집할 청크를 찾을 수 없습니다.');
        const project = validate(value); delete project.source; checkProject(project, index); freeze(project);
        if (overrideIndex !== undefined && overrideIndex !== index) cache.delete(overrideIndex);
        overrideIndex = index; versions.set(index, (versions.get(index) ?? 0) + 1);
        remember(index, project); generation++; pairGeneration++;
        if (endpoints) { endpoints.frames.clear(); endpoints.revision++; }
      },
      clearProjectOverride() {
        if (overrideIndex !== undefined) { cache.delete(overrideIndex); versions.set(overrideIndex, (versions.get(overrideIndex) ?? 0) + 1); overrideIndex = undefined; }
        generation++; pairGeneration++;
        if (endpoints) { endpoints.frames.clear(); endpoints.revision++; }
      },
      async preload(time) {
        const index = position(doc, time).index;
        explicitPreloads.set(index, (explicitPreloads.get(index) ?? 0) + 1);
        try { await load(index); }
        finally { const count = explicitPreloads.get(index)! - 1; if (count) explicitPreloads.set(index, count); else explicitPreloads.delete(index); }
      },
      dispose() { disposed = true; generation++; pairGeneration++; cache.clear(); endpoints?.frames.clear(); },
      get cachedSegmentIds() { return [...cache.keys()].map(index => doc.segments[index].id); },
    };
  }
  async function replaceCompositionSegment(doc: MotionComposition, id: string, project: MotionProject): Promise<MotionComposition> {
    const copy = validateComposition(doc), index = copy.segments.findIndex(s => s.id === id);
    if (index < 0) error('편집할 청크를 찾을 수 없습니다.');
    if (project.width !== copy.width || project.height !== copy.height || project.fps !== copy.fps) error('청크 화면 크기 또는 FPS가 다릅니다.');
    copy.segments[index] = await encodeSegment(copy.segments[index], project);
    return validateComposition(copy);
  }
  return { validateComposition, validateDocument, parseDocument, encodeSegment, decodeSegment, getSegmentAt, createCompositionPlayer, replaceCompositionSegment };
}

const motion = createMotionRuntime();
const api = createCompositionRuntime(validateProject, motion.render, motion.evaluate, MAX_PROJECT_BYTES, MAX_DOCUMENT_BYTES, MAX_PROJECT_NODES, motion);
export const { validateComposition, validateDocument, parseDocument, encodeSegment, decodeSegment, getSegmentAt, createCompositionPlayer, replaceCompositionSegment } = api;

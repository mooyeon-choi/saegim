import { describe, expect, it } from 'vitest';
import type { BackgroundMotionTrack, MotionComposition, MotionNode, MotionProject } from '../../src/types';
import { createCompositionPlayer, createProjectRenderer, encodeSegment, exportProjectJson, parseDocument, validateProject } from '../../src/engine';
import { createMotionRuntime } from '../../src/engine/runtime';

const shape = (id: string, fill: string): MotionNode => ({ id, name: id, type: 'rect', x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, fill, stroke: 'none', strokeWidth: 0, start: 0, end: 1, hidden: false, locked: false, keyframes: [] });
function track(): BackgroundMotionTrack {
  return { id: 'safe-roi', start: 0, end: 1, anchorTime: 0, polygon: [[10, 10], [80, 10], [80, 80], [10, 80]], featherPx: 8,
    interpolation: 'linear', keys: [{ time: 0, matrix: [1, 0, 0, 1, 0, 0] }, { time: 1, matrix: [1, 0, 0, 1, 10, 20], gain: [1.5, .5, 1], bias: [.1, 0, -.1] }],
    anchor: { background: '#ffffff', nodes: [shape('anchor', '#ff0000')] } };
}
function project(): MotionProject {
  return { schemaVersion: 1, id: 'roi', name: 'roi', width: 100, height: 100, duration: 1, fps: 24, background: '#ffffff', scenes: [],
    nodes: [shape('base', '#0000ff'), { ...shape('title', '#111111'), type: 'text', text: 'EDIT', fontSize: 12, occlusionPath: 'M0 0 L20 0 L20 20 Z' }, shape('in-front-of-text', '#00ff00')],
    temporal: { mode: 'blend', sampleFps: 2, cuts: [] }, backgroundMotion: { mode: 'on', tracks: [track()] } };
}
const runtime = createMotionRuntime();

describe('ROI vector anchor motion', () => {
  it('keeps static vectors once and updates only matrix/color attributes between cached endpoints', () => {
    const renderer = createProjectRenderer(project()), a = renderer.framePair(.2), b = renderer.framePair(.3);
    expect(a.from).toBe(b.from); expect(a.to).toBe(b.to); expect(a.sharedDefinitions).toBe(b.sharedDefinitions);
    expect(a.sharedTransforms![0].matrix).toEqual([1, 0, 0, 1, 2, 4]);
    expect(b.sharedTransforms![0].gain).toEqual([1.15, .85, 1]);
    expect(a.sharedDefinitions).toContain('data-background-node-id="anchor"');
    expect(a.sharedDefinitions).not.toContain('data-node-id="anchor"');
    expect(a.from.svg).toContain('data-background-track="safe-roi"');
    expect(a.to!.svg).toContain('data-background-track="safe-roi"');
    const svg = renderer(.2);
    expect(svg).toContain('matrix(1 0 0 1 2 4)'); expect(svg).toContain('slope="1.1"');
    expect((svg.match(/data-background-node-id="anchor"/g) ?? []).length).toBe(1);
    expect(svg).not.toMatch(/<image|<video|<canvas|<foreignObject/);
  });
  it('retains original z-order, editable real text, and the text occlusion contour', () => {
    const p = project(), renderer = createProjectRenderer(p), svg = renderer.framePair(.2).from.svg;
    expect(svg.indexOf('data-node-id="base"')).toBeLessThan(svg.indexOf('data-background-track='));
    expect(svg.indexOf('data-background-track=')).toBeLessThan(svg.indexOf('data-node-id="title"'));
    expect(svg.indexOf('data-node-id="title"')).toBeLessThan(svg.indexOf('data-node-id="in-front-of-text"'));
    expect(svg).toContain('M0 0 L20 0 L20 20 Z'); expect(svg).toContain('<text ');
    p.nodes[1].text = 'CHANGED'; p.backgroundMotion!.tracks[0].anchor.nodes[0].fill = '#f0f';
    expect(renderer.framePair(.2).from.svg).not.toContain('CHANGED');
    expect(createProjectRenderer(p).framePair(.2).from.svg).toContain('CHANGED');
    expect(renderer.framePair(.2).sharedDefinitions).not.toContain('#f0f');
  });
  it('disables cleanly and uses exact support/cut boundaries without extrapolation', () => {
    const p = project(); p.backgroundMotion!.tracks[0].end = .5; p.backgroundMotion!.tracks[0].keys[1].time = .5; p.temporal!.cuts = [.5];
    const renderer = createProjectRenderer(p);
    expect(renderer.framePair(.5 - 1e-10).backgroundStatus!.supported).toBe(true);
    expect(renderer.framePair(.5).backgroundStatus!.supported).toBe(false);
    expect(renderer.framePair(.5).from.svg).not.toContain('data-background-track=');
    p.backgroundMotion!.mode = 'off'; const plain = { ...p, backgroundMotion: undefined };
    expect(createProjectRenderer(p)(.2)).toBe(createProjectRenderer(plain)(.2));
    p.backgroundMotion!.mode = 'on'; p.temporal!.cuts = [.3];
    expect(() => validateProject(p)).toThrow(/컷/);
  });
  it('attaches and releases the overlay continuously with inward-only feather clipping', () => {
    const p = project(); p.backgroundMotion!.tracks[0].fadeIn = .2; p.backgroundMotion!.tracks[0].fadeOut = .2;
    const renderer = createProjectRenderer(p);
    expect(renderer.framePair(0).sharedTransforms![0].opacity).toBe(0);
    expect(renderer.framePair(.1).sharedTransforms![0].opacity).toBeCloseTo(.5);
    expect(renderer.framePair(.8).sharedTransforms![0].opacity).toBeCloseTo(1);
    expect(renderer.framePair(.9).sharedTransforms![0].opacity).toBeCloseTo(.5);
    expect(renderer.framePair(1).sharedTransforms).toEqual([]);
    expect(renderer(.1)).toMatch(/transform-opacity" opacity="0.5"/);
    expect(renderer(.1)).toContain('clip-path="url(#bg'); expect(renderer(.1)).toContain('<feGaussianBlur');
  });
  it('uses supplied cubic coefficients and falls back if the intermediate matrix folds', () => {
    const p = project(), t = p.backgroundMotion!.tracks[0]; t.interpolation = 'pchip';
    t.pchip = { breakpoints: [0, 1], channels: { a: [[0, 0, 0, 1]], b: [[0, 0, 0, 0]], c: [[0, 0, 0, 0]], d: [[0, 0, 0, 1]], e: [[-20, 30, 0, 0]], f: [[0, 0, 20, 0]] } };
    expect(createProjectRenderer(p).framePair(.25).sharedTransforms![0].matrix[4]).toBe(1.5625);
    t.pchip.channels.a = [[0, 8, -8, 1]];
    expect(() => validateProject(p)).toThrow(/관측값 범위/);
    // Each component is monotone and endpoint determinants are positive, but
    // linearly rotating both diagonal entries still collapses at the midpoint.
    t.keys[1].matrix[0] = -1; t.keys[1].matrix[3] = -1;
    t.pchip.channels.a = [[0, 0, -2, 1]]; t.pchip.channels.d = [[0, 0, -2, 1]];
    const pair = createProjectRenderer(p).framePair(.5);
    expect(pair.backgroundStatus!.supported).toBe(false); expect(pair.from.svg).not.toContain('data-background-track=');
    t.pchip.channels.e = [[0, 0, 9, 0]]; expect(() => validateProject(p)).toThrow(/양 끝값/);
  });
  it('rejects executable anchors, text snapshots, invalid polygons, malformed matrices and budgets', () => {
    const invalid = (mutate: (p: MotionProject) => void, pattern?: RegExp) => { const p = project(); mutate(p); expect(() => validateProject(p)).toThrow(pattern); };
    invalid(p => { p.backgroundMotion!.tracks[0].anchor.nodes[0].fill = 'url(javascript:1)'; }, /색상/);
    invalid(p => { p.backgroundMotion!.tracks[0].anchor.nodes[0].type = 'text'; }, /비텍스트/);
    invalid(p => { p.backgroundMotion!.tracks[0].polygon = [[0, 0], [90, 90], [0, 90], [90, 0]]; }, /ROI/);
    invalid(p => { p.backgroundMotion!.tracks[0].keys[1].matrix[0] = -1; }, /행렬/);
    invalid(p => { p.backgroundMotion!.tracks[0].keys[1].gain = [5, 1, 1]; });
    invalid(p => { p.backgroundMotion!.tracks[0].anchorTime = .2; }, /identity/);
    invalid(p => { p.backgroundMotion!.tracks[0].featherPx = 129; });
    invalid(p => { p.backgroundMotion!.tracks = Array.from({ length: 257 }, (_, i) => ({ ...track(), id: String(i) })); }, /256/);
    invalid(p => { p.backgroundMotion!.tracks = Array.from({ length: 5 }, (_, i) => ({ ...track(), id: String(i) })); }, /동시에/);
    expect(parseDocument(exportProjectJson(project()))).toEqual(validateProject(project()));
  });
  it('shares one global background across chunks while keeping the two-child cache and edited text', async () => {
    const a = project(), b = project(); delete a.backgroundMotion; delete b.backgroundMotion; b.nodes[1].text = 'NEXT';
    const segments = await Promise.all([a, b].map((p, i) => encodeSegment({ id: String(i), name: String(i), start: i, end: i + 1 }, p)));
    const motion = project().backgroundMotion!; motion.tracks[0].end = 2; motion.tracks[0].keys[1].time = 2;
    const doc: MotionComposition = { schemaVersion: 2, id: 'book', name: 'book', width: 100, height: 100, fps: 24, duration: 2, background: '#ffffff', segments, temporal: { mode: 'blend', sampleFps: 2, cuts: [] }, backgroundMotion: motion };
    const player = createCompositionPlayer(doc), pair = (await player.framePair(.75))!;
    expect(pair.from.time).toBe(.5); expect(pair.to!.time).toBe(1); expect(pair.to!.svg).toContain('NEXT');
    expect(pair.sharedTransforms).toHaveLength(1); expect(pair.sharedTransforms![0].matrix[4]).toBe(3.75);
    expect((await player.seek(.75))!.svg).toContain('matrix(1 0 0 1 3.75 7.5)');
    b.nodes[1].text = 'EDITED NEXT'; player.setProjectOverride('1', b);
    expect((await player.framePair(.75))!.to!.svg).toContain('EDITED NEXT');
    expect(player.cachedSegmentIds.length).toBeLessThanOrEqual(2); player.dispose();
    expect(parseDocument(exportProjectJson(doc)).backgroundMotion).toEqual(motion);
  });
  it('bounds polygon vertices and total static anchor nodes without raising project path budgets', () => {
    const p = project(), t = p.backgroundMotion!.tracks[0];
    t.polygon = Array.from({ length: 256 }, (_, i) => [50 + 40 * Math.cos(i / 256 * 2 * Math.PI), 50 + 40 * Math.sin(i / 256 * 2 * Math.PI)]);
    expect(() => validateProject(p)).not.toThrow();
    t.polygon.push([50, 50]); expect(() => validateProject(p)).toThrow(/256/);
    p.duration = 5;
    p.backgroundMotion!.tracks = Array.from({ length: 5 }, (_, i) => ({ ...track(), id: String(i), start: i, end: i + 1, anchorTime: i,
      keys: [{ time: i, matrix: [1, 0, 0, 1, 0, 0] }, { time: i + 1, matrix: [1, 0, 0, 1, 0, 0] }],
      anchor: { background: '#fff', nodes: Array.from({ length: i < 4 ? 8000 : 1 }, (_, j) => shape(`anchor-${j}`, '#fff')) } }));
    expect(() => validateProject(p)).toThrow(/32,000/);
  });
  it('preserves the same background formulas in the closed offline runtime factory', () => {
    const copy = (0, eval)(`(${createMotionRuntime.toString()})()`) as ReturnType<typeof createMotionRuntime>;
    const p = validateProject(project());
    for (const t of [0, .125, .5, .999, 1]) {
      const x = runtime.framePair(p, t), y = copy.framePair(p, t);
      expect(y.sharedTransforms!.map(v => v.matrix)).toEqual(x.sharedTransforms!.map(v => v.matrix));
      expect(y.sharedTransforms!.map(v => v.gain)).toEqual(x.sharedTransforms!.map(v => v.gain));
      expect(y.backgroundStatus).toEqual(x.backgroundStatus);
    }
  });
});

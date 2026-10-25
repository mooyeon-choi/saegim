import { describe, expect, it } from 'vitest';
import { createCompositionPlayer, createProjectRenderer, decodeSegment, encodeSegment, exportProjectJson, parseDocument, validateProject } from '../../src/engine';
import { createMotionRuntime } from '../../src/engine/runtime';
import type { MotionComposition, MotionProject } from '../../src/types';

const runtime = createMotionRuntime();
function project(): MotionProject {
  return { schemaVersion: 1, id: 'frame-study', name: 'Frames', width: 100, height: 100, duration: 1, fps: 24,
    background: '#ffffff', scenes: [], temporal: { mode: 'frames', sampleFps: 4, cuts: [] }, nodes: [
      { id: 'title', name: 'Title', type: 'text', text: 'Editable <title>', fontSize: 12, x: 10, y: 20, width: 80, height: 30,
        rotation: 0, opacity: 1, fill: '#000000', stroke: 'none', strokeWidth: 0, start: 0, end: 1, hidden: false, locked: false,
        gradient: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: '#112233' }, { offset: 1, color: '#8899aa' }] },
        occlusionPath: 'M0 0 L20 0 L20 20 Z',
        keyframes: [{ time: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
          { time: 1, x: 40, y: 10, scaleX: 2, scaleY: 1, rotation: 30, opacity: 1 }] },
    ] };
}

describe('frame redraw', () => {
  it('redraws only the chosen observation, including text, gradients and occlusion, independent of seek order', () => {
    const p = validateProject(project()), render = createProjectRenderer(p);
    const first = render(.37);
    expect(first).toBe(runtime.renderSample(p, .25));
    expect(first).toContain('<text '); expect(first).toContain('Editable &lt;title&gt;');
    expect(first).toContain('<linearGradient'); expect(first).toContain('M0 0 L20 0 L20 20 Z');
    expect(first).not.toMatch(/data-temporal-layer|<image|<video|<canvas|<animate/);
    for (const t of [.99, 0, .6, .12, .37]) render(t);
    expect(render(.37)).toBe(first);
    expect(render.evaluate('title', .37)).toEqual(runtime.evaluate(p.nodes[0], .25));
    expect(render.framePair(.37)).toMatchObject({ time: .37, from: { time: .25 }, mix: 0 });
    expect(render.framePair(.37).to).toBeUndefined();
  });
  it('keeps arbitrary cuts exact and the duration edge on the last visible observation', () => {
    const p = project(); p.temporal!.cuts = [.37, 1];
    p.backgroundKeyframes = [{ time: .37, color: '#ff0000' }];
    const renderer = createProjectRenderer(p);
    expect(renderer.framePair(.37 - 1e-10).from.time).toBe(.25);
    expect(renderer.framePair(.37).from.time).toBe(.37);
    expect(renderer(.4)).toContain('#ff0000');
    expect(renderer.framePair(1).from.time).toBe(.75);
    expect(renderer(1)).toBe(renderer(.75));
    p.duration = .1; p.temporal = { mode: 'frames', sampleFps: 29.97, cuts: [] };
    expect(runtime.framePlan(p.temporal, p.duration, p.duration).from).toBe(2 / 29.97);
    // A frame count a few ULPs above an integer must not select a blank end frame.
    expect(runtime.framePlan(p.temporal, 3 / 29.97 + Number.EPSILON, 1).from).toBe(2 / 29.97);
    p.temporal.sampleFps = 24;
    expect(runtime.framePlan(p.temporal, 1, 7 / 24 - 1e-10).from).toBe(6 / 24);
    expect(runtime.framePlan(p.temporal, 1, 7 / 24 + Number.EPSILON).from).toBe(7 / 24);
  });
  it('bypasses regional motion without deleting its data and accepts a transparent frame', () => {
    const p = project();
    p.backgroundMotion = { mode: 'on', tracks: [{ id: 'region', start: 0, end: 1, anchorTime: 0,
      polygon: [[0, 0], [100, 0], [100, 100], [0, 100]], featherPx: 0, interpolation: 'linear',
      keys: [{ time: 0, matrix: [1, 0, 0, 1, 0, 0] }, { time: 1, matrix: [1, 0, 0, 1, 10, 0] }],
      anchor: { background: '#ff0000', nodes: [] } }] };
    p.foregroundMotion = { mode: 'on', tracks: [{ id: 'arm', start: 0, end: .25, featherPx: 0,
      polygon: [[20, 20], [40, 20], [40, 40], [20, 40]], forward: [1, 0, 0, 1, 2, 1] }] };
    const pair = createProjectRenderer(p).framePair(.125);
    expect(pair.sharedDefinitions).toBe(''); expect(pair.sharedTransforms).toEqual([]);
    expect(pair.backgroundStatus).toMatchObject({ mode: 'off', supported: false });
    expect(pair.foregroundStatus).toMatchObject({ mode: 'off', supported: false });
    expect(pair.to).toBeUndefined();
    const reopened = parseDocument(exportProjectJson(p));
    expect(reopened.backgroundMotion).toEqual(p.backgroundMotion);
    expect(reopened.foregroundMotion).toEqual(p.foregroundMotion);
    expect(reopened.temporal?.mode).toBe('frames');
    p.background = 'transparent'; expect(() => validateProject(p)).not.toThrow();
  });
  it('uses a global grid across non-grid storage boundaries, and preserves edits after compression', async () => {
    const a = project(), b = project(); a.duration = .6; b.duration = .4;
    for (const p of [a, b]) { p.temporal = undefined; p.nodes[0].end = p.duration; p.nodes[0].keyframes = []; }
    b.nodes[0].text = 'SECOND';
    const doc: MotionComposition = { schemaVersion: 2, id: 'book', name: 'Book', width: 100, height: 100, duration: 1, fps: 24, background: '#fff',
      temporal: { mode: 'frames', sampleFps: 4, cuts: [] }, segments: [
        await encodeSegment({ id: 'a', name: 'A', start: 0, end: .6 }, a),
        await encodeSegment({ id: 'b', name: 'B', start: .6, end: 1 }, b),
      ] };
    const player = createCompositionPlayer(doc);
    const prior = (await player.seek(.65))!;
    expect(prior.segment.id).toBe('a'); expect(prior.localTime).toBe(.5); expect(prior.time).toBe(.65);
    expect((await player.framePair(.65))!.from.svg).toContain('Editable');
    const next = (await player.seek(.8))!;
    expect(next.segment.id).toBe('b'); expect(next.localTime).toBeCloseTo(.15);
    expect(next.svg).toContain('SECOND');
    const edit = await decodeSegment(doc.segments[1]); edit.nodes[0].text = '새 문구 <edited>';
    player.setProjectOverride('b', edit);
    expect((await player.seek(.8))!.svg).toContain('새 문구 &lt;edited&gt;');
    expect((await player.framePair(.8))!.from.svg).toContain('새 문구 &lt;edited&gt;');
    doc.segments[1] = await encodeSegment(doc.segments[1], edit);
    const restored = parseDocument(exportProjectJson(doc)) as MotionComposition;
    expect(restored.temporal?.mode).toBe('frames');
    expect((await decodeSegment(restored.segments[1])).nodes[0].text).toBe(edit.nodes[0].text);
    player.dispose();
  });
});

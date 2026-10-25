import { describe, expect, it } from 'vitest';
import type { MotionNode, MotionKeyframe, MotionProject, PaintRegion, MotionComposition } from '../../src/types';
import { createProjectRenderer, createCompositionPlayer, encodeSegment, exportHtml, exportProjectJson, parseDocument, validateProject, evaluateNode, renderSvg } from '../../src/engine';
import { createMotionRuntime } from '../../src/engine/runtime';

const clip = 'M0 0 L500 0 L500 1000 L0 1000 Z';
const region = (fill = '#00ff00'): PaintRegion => ({ path: clip, fill });
const key = (time: number, extra: Partial<MotionKeyframe> = {}): MotionKeyframe => ({ time, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: 'linear', ...extra });
const node = (): MotionNode => ({ id: 'subject', name: 'subject', type: 'path', path: 'M0 0 L1000 0 L1000 1000 L0 1000 Z', x: 10, y: 10, width: 80, height: 80, opacity: .5, rotation: 0, fill: '#ff0000', stroke: '#000000', strokeWidth: 2, start: 0, end: 2, hidden: false, locked: false, keyframes: [] });
const project = (): MotionProject => ({ schemaVersion: 1, id: 'paint', name: 'paint', width: 100, height: 100, duration: 2, fps: 2, background: '#ffffff', scenes: [], nodes: [node()] });

describe('clipped fill regions', () => {
  it('leaves legacy/empty-region SVG byte-identical and keeps text content untouched', () => {
    const p = project(), expected = renderSvg(p, .2);
    p.nodes[0].paintRegions = []; expect(renderSvg(p, .2)).toBe(expected);
    p.nodes[0].keyframes = [key(0, { paintRegions: [] })];
    const base = structuredClone(p); delete base.nodes[0].keyframes[0].paintRegions;
    expect(renderSvg(p, .2)).toBe(renderSvg(base, .2));
  });
  it('holds observation regions, clears with [], and falls back to the node when omitted', () => {
    const n = node(); n.paintRegions = [region()]; n.keyframes = [key(0, { paintRegions: [region('#0000ff')] }), key(.5, { paintRegions: [] }), key(1)];
    expect(evaluateNode(n, .499).paintRegions![0].fill).toBe('#0000ff');
    expect(evaluateNode(n, .5).paintRegions).toEqual([]);
    expect(evaluateNode(n, 1).paintRegions![0].fill).toBe('#00ff00');
    n.keyframes[1].time = .1 + .2;
    expect(evaluateNode(n, .3).paintRegions).toEqual([]);
  });
  it('keeps one logical node and source contour, one group opacity, and a single final stroke', () => {
    const p = project(); p.nodes[0].paintRegions = [region(), region('#0000ff')];
    const svg = renderSvg(p, .2);
    expect(svg.match(/data-node-id="subject"/g)).toHaveLength(1);
    expect(svg.match(/d="M0 0 L1000 0 L1000 1000 L0 1000 Z"/g)).toHaveLength(1);
    expect(svg.match(/opacity="0.5"/g)).toHaveLength(1);
    expect(svg.match(/stroke="#000000"/g)).toHaveLength(1);
    expect(svg.lastIndexOf('stroke="#000000"')).toBeGreaterThan(svg.lastIndexOf('fill="#0000ff"'));
    expect(svg).toContain('clip-rule="evenodd" fill-rule="evenodd"');
  });
  it('keeps full-shape gradient geometry while giving every paint its own safe ID', () => {
    const p = project(); const gradient = { type: 'linear' as const, x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
    p.nodes[0].gradient = gradient; p.nodes[0].paintRegions = [{ ...region(), gradient }, { ...region(), gradient: null }];
    const svg = renderSvg(p, .2); expect(svg.match(/<linearGradient /g)).toHaveLength(2);
    expect(svg).toContain('-paint-0-gradient'); expect(svg).not.toContain('-paint-1-gradient');
    const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); expect(new Set(ids).size).toBe(ids.length);
  });
  it('validates copies and preserves the data through JSON and embedded offline runtime', () => {
    const p = project(); p.nodes[0].paintRegions = [region()]; p.nodes[0].keyframes = [key(0), key(.5, { paintRegions: [] })];
    const renderer = createProjectRenderer(p), initial = renderer(.2); p.nodes[0].paintRegions[0].fill = '#0000ff';
    expect(renderer(.2)).toBe(initial);
    expect(parseDocument(exportProjectJson(p))).toEqual(validateProject(p));
    const closed = (0, eval)(`(${createMotionRuntime.toString()})()`), runtime = createMotionRuntime(), safe = validateProject(p);
    for (const t of [.2, .5, 1]) expect(closed.render(safe, t)).toBe(runtime.render(safe, t));
    expect(exportHtml(p)).toContain('paintRegions');
  });
  it('includes regions in both aligned foreground source endpoints across composition export', async () => {
    const p = project(); p.nodes[0].opacity = 1; p.nodes[0].paintRegions = [region()];
    const segment = await encodeSegment({ id: 'one', name: 'one', start: 0, end: 2 }, p);
    const doc: MotionComposition = { schemaVersion: 2, id: 'book', name: 'book', width: 100, height: 100, duration: 2, fps: 2, background: '#ffffff', segments: [segment], temporal: { mode: 'blend', sampleFps: 2, cuts: [] }, foregroundMotion: { mode: 'on', tracks: [{ id: 'eye', start: 0, end: .5, polygon: [[20,20],[70,20],[70,70],[20,70]], featherPx: 2, forward: [1,0,0,1,2,0] }] } };
    const player = createCompositionPlayer(doc), pair = (await player.framePair(.25))!;
    expect(pair.from.svg).toContain('-paint-0-coverage'); expect(pair.to!.svg).toContain('-paint-0-coverage'); expect(pair.sharedDefinitions).toContain('-foreground-source');
    expect(pair.foregroundStatus!.supported).toBe(true); expect(exportHtml(doc)).toContain('paintRegions'); player.dispose();
  });
  it('rejects scripts, malformed paths/colors, oversized lists and text regions including empty ones', () => {
    const check = (mutate: (p: MotionProject) => void, match?: RegExp) => { const p = project(); mutate(p); expect(() => validateProject(p)).toThrow(match); };
    check(p => { p.nodes[0].paintRegions = [{ path: 'M0 0"/><script>alert(1)</script>', fill: '#fff' }]; }, /SVG/);
    check(p => { p.nodes[0].paintRegions = [region('url(https://example.com)')]; }, /색상/);
    check(p => { p.nodes[0].paintRegions = Array.from({ length: 9 }, () => region()); }, /8개/);
    check(p => { p.nodes[0].type = 'text'; p.nodes[0].paintRegions = []; }, /텍스트/);
    check(p => { p.nodes[0].type = 'text'; p.nodes[0].keyframes = [key(0, { paintRegions: [] })]; }, /텍스트/);
    check(p => { p.nodes[0].paintRegions = [{ path: 'M0 0 L2', fill: '#fff' }]; }, /좌표/);
    check(p => { p.nodes[0].paintRegions = [{ ...region(), gradient: { type: 'radial', cx: 0, cy: 0, r: 0, stops: [{offset:0,color:'#fff'},{offset:1,color:'#000'}] } }]; });
  });
  // Full-size limit fixtures test correctness, not a five-second performance budget.
  it('charges repeated region paths against the existing project-wide 64MB budget', () => {
    const p = project(), path = 'M0 0 L1 1 Z'.padEnd(100000, ' ');
    p.nodes[0].keyframes = Array.from({ length: 81 }, (_, i) => key(i / 100, { paintRegions: Array.from({ length: 8 }, () => ({ path, fill: '#fff' })) }));
    expect(() => validateProject(p)).toThrow(/64MB/);
  }, 60_000);
});

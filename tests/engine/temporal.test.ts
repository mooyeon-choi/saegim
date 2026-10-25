import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { createDemoProject } from '../../src/demo';
import type { MotionComposition, MotionNode, MotionProject } from '../../src/types';
import { createCompositionPlayer, createProjectRenderer, decodeSegment, encodeSegment, exportHtml, exportProjectJson, parseDocument, renderSvg, validateProject } from '../../src/engine';
import { createMotionRuntime } from '../../src/engine/runtime';

function project(text = 'editable'): MotionProject {
  const p = createDemoProject();
  const n: MotionNode = { ...p.nodes.find(n => n.type === 'text')!, id: 'title', text, x: 10, y: 20, width: 80, height: 40, start: 0, end: 1, opacity: 1, keyframes: [] };
  return { ...p, id: text, width: 100, height: 100, fps: 2, duration: 1, background: '#ffffff', scenes: [], nodes: [n], temporal: { mode: 'blend', sampleFps: 2, cuts: [] } };
}
async function book(): Promise<MotionComposition> {
  const segments = await Promise.all(['first', 'second', 'third'].map((text, i) => encodeSegment({ id: text, name: text, start: i, end: i + 1 }, project(text))));
  return { schemaVersion: 2, id: 'book', name: 'book', width: 100, height: 100, fps: 2, duration: 3, background: '#ffffff', temporal: { mode: 'blend', sampleFps: 2, cuts: [] }, segments };
}
const runtime = createMotionRuntime();

describe('complete vector frame interpolation', () => {
  it('preserves each observation byte-for-byte and holds the last observation', () => {
    const p = project(), raw = { ...p, temporal: undefined };
    expect(renderSvg(p, 0)).toBe(renderSvg(raw, 0));
    expect(renderSvg(p, .5)).toBe(renderSvg(raw, .5));
    expect(renderSvg(p, 1)).toBe(renderSvg(raw, .5));
    expect(createProjectRenderer(p).framePair(.99).to).toBeUndefined();
  });
  it('uses two complete opaque frames without morphing unrelated paths or darkening both layers', () => {
    const p = project();
    p.nodes = [{ ...p.nodes[0], type: 'path', path: 'M0 0 L1000 0 L0 1000 Z', keyframes: [
      { time: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, path: 'M0 0 L1000 0 L0 1000 Z' },
      { time: .5, x: 20, y: 30, scaleX: 2, scaleY: .2, rotation: 10, opacity: 1, path: 'M0 0 C200 200 500 1000 1000 1000 Z' },
    ] }];
    const pair = createProjectRenderer(p).framePair(.25);
    expect(pair.mix).toBe(.5);
    expect(pair.from.svg).toContain('M0 0 L1000 0 L0 1000 Z');
    expect(pair.to!.svg).toContain('M0 0 C200 200 500 1000 1000 1000 Z');
    expect(pair.from.svg).toContain('fill="#ffffff"'); expect(pair.to!.svg).toContain('fill="#ffffff"');
    const svg = renderSvg(p, .25);
    expect(svg).toContain('<g data-temporal-layer="from">');
    expect(svg).toContain('data-temporal-layer="to" opacity="0.5"');
    expect(svg).not.toMatch(/<image|<video|<canvas|<foreignObject/);
  });
  it('keeps births, deaths and real text in complete endpoints with globally distinct defs', () => {
    const p = project(); p.nodes[0].end = .5;
    p.nodes.push({ ...p.nodes[0], id: 'new', text: 'New <script>', start: .5, end: 1, gradient: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] } });
    const pair = createProjectRenderer(p).framePair(.25);
    expect(pair.from.svg).toContain('data-node-id="title"'); expect(pair.from.svg).not.toContain('data-node-id="new"');
    expect(pair.to!.svg).toContain('<text '); expect(pair.to!.svg).toContain('New &lt;script&gt;');
    expect(pair.to!.svg).not.toContain('data-node-id="title"');
    const ids = [...renderSvg(p, .25).matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('holds before both grid and non-grid cuts, then starts the new shot exactly', () => {
    const p = project(); p.temporal!.cuts = [.37, .5];
    p.backgroundKeyframes = [{ time: .37, color: '#ff0000' }, { time: .5, color: '#0000ff' }];
    const renderer = createProjectRenderer(p);
    expect(renderer.framePair(.37 - 1e-10)).toMatchObject({ from: { time: 0 }, mix: 0, cut: true });
    expect(renderer.framePair(.37)).toMatchObject({ from: { time: .37 }, mix: 0, cut: true });
    expect(renderer(.37)).toBe(runtime.renderSample(validateProject(p), .37));
    expect(renderer(.5)).toContain('#0000ff');
    const uncut = project(); uncut.temporal!.cuts = [.37];
    expect(createProjectRenderer(uncut).framePair(.4).mix).toBeCloseTo((.4 - .37) / (.5 - .37));
  });
  it('accepts arithmetic roundoff but never reveals a future observation 1e-10 early', () => {
    const p = project(); p.temporal!.sampleFps = 24;
    expect(runtime.framePlan(p.temporal, 1, 7 / 24 + Number.EPSILON)).toMatchObject({ from: 7 / 24, mix: 0 });
    expect(runtime.framePlan(p.temporal, 1, 7 / 24 - 1e-10).from).toBe(6 / 24);
  });
  it('bounds endpoints, reuses the prior upper endpoint, and invalidates edited/options snapshots', () => {
    const p = project(); p.duration = 2; p.nodes[0].end = 2;
    const render = createProjectRenderer(p), a = render.framePair(.1), b = render.framePair(.2), c = render.framePair(.6);
    expect(a.from).toBe(b.from); expect(a.to).toBe(b.to); expect(c.from).toBe(a.to);
    expect(render.framePair(.6, { selectedId: 'title' }).from.key).not.toBe(c.from.key);
    p.nodes[0].text = 'changed'; expect(render.framePair(.6).from.svg).not.toContain('changed');
    expect(createProjectRenderer(p).framePair(.6).from.svg).toContain('changed');
    const cache = runtime.createEndpointCache();
    for (let i = 0; i < 10; i++) runtime.endpoint(p, i / 10, {}, cache);
    expect(cache.frames.size).toBe(2);
  });
  it('hoists font data and escaped license once, leaving endpoint SVG geometry only', () => {
    const p = project();
    p.fonts = [{ family: 'Test Font', mimeType: 'font/ttf', data: 'AAEAAAAAAAAAAAAA', license: '<script>not executable</script>' }];
    const renderer = createProjectRenderer(p), a = renderer.framePair(.1), b = renderer.framePair(.2);
    expect(a.fontCss).toBe(b.fontCss); expect(a.fontCss).toContain('AAEAAAAAAAAAAAAA');
    expect(a.from.svg).not.toContain('AAEAAAAAAAAAAAAA'); expect(a.to!.svg).not.toContain('<style>');
    expect(a.fontMetadata).toContain('&lt;script&gt;');
    expect((renderer(.25).match(/AAEAAAAAAAAAAAAA/g) ?? []).length).toBe(1);
  });
  it('strictly validates temporal metadata and requires opaque backgrounds for blending', () => {
    const p = project();
    for (const temporal of [{ mode: 'morph', sampleFps: 24, cuts: [] }, { mode: 'blend', sampleFps: 0, cuts: [] }, { mode: 'blend', sampleFps: 24, cuts: [.5, .4] }, { mode: 'blend', sampleFps: 24, cuts: [.5, .5] }, { mode: 'blend', sampleFps: 24, cuts: [2] }, { mode: 'blend', sampleFps: 24, cuts: Array(1001).fill(0) }]) expect(() => validateProject({ ...p, temporal })).toThrow(/temporal/);
    for (const background of ['transparent', 'none', '#fff8', '#ffffff80', 'rgba(0,0,0,0.5)', 'hsl(0 0% 0% / 50%)']) expect(() => validateProject({ ...p, background })).toThrow(/불투명/);
    for (const background of ['white', '#fff', '#ffffff', '#ffff', '#ffffffff', 'rgba(0,0,0,1)', 'hsl(0 0% 0% / 100%)']) expect(() => validateProject({ ...p, background })).not.toThrow();
    expect(() => validateProject({ ...p, backgroundKeyframes: [{ time: .5, color: 'transparent' }] })).toThrow(/불투명/);
    expect(() => validateProject({ ...p, background: 'transparent', temporal: { ...p.temporal!, mode: 'off' } })).not.toThrow();
    expect(parseDocument(exportProjectJson(p))).toEqual(validateProject(p));
  });
});

describe('global temporal composition', () => {
  it('blends across storage chunks, but never across explicit shot cuts', async () => {
    const doc = await book(), player = createCompositionPlayer(doc);
    const pair = (await player.framePair(.75))!;
    expect(pair).toMatchObject({ from: { time: .5 }, to: { time: 1 }, mix: .5 });
    expect(pair.from.svg).toContain('first'); expect(pair.to!.svg).toContain('second');
    const exact = (await player.seek(1))!;
    expect(exact.svg).toBe(runtime.renderSample(exact.project, 0));
    expect(player.cachedSegmentIds.length).toBeLessThanOrEqual(2);
    player.dispose();
    doc.temporal!.cuts = [1]; const cut = createCompositionPlayer(doc);
    expect(await cut.framePair(.75)).toMatchObject({ cut: true, mix: 0 });
    expect((await cut.framePair(1))!.from.svg).toContain('second'); cut.dispose();
  });
  it('keeps seek/pair generations independent and last-request-wins inside each channel', async () => {
    const player = createCompositionPlayer(await book());
    const [seek, pair] = await Promise.all([player.seek(.2), player.framePair(1.2)]);
    expect(seek).not.toBeNull(); expect(pair).not.toBeNull();
    const fresh = createCompositionPlayer(await book());
    const [old, latest] = await Promise.all([fresh.framePair(.2), fresh.framePair(2.2)]);
    fresh.dispose();
    expect(old).toBeNull(); expect(latest!.from.svg).toContain('third');
    const [oldSeek, latestSeek] = await Promise.all([player.seek(.2), player.seek(2.2)]);
    expect(oldSeek).toBeNull(); expect(latestSeek!.index).toBe(2);
    expect(player.cachedSegmentIds.length).toBeLessThanOrEqual(2); player.dispose();
  });
  it('returns cached pairs synchronously and awaits only actual gzip cache misses', async () => {
    const player = createCompositionPlayer(await book());
    const cold = player.framePair(.2); expect(cold).toBeInstanceOf(Promise); await cold;
    const warm = player.framePair(.3); expect(warm).not.toBeInstanceOf(Promise);
    expect(await warm).toMatchObject({ time: .3, mix: .6 });
    await player.preload(1);
    expect(player.framePair(.75)).not.toBeInstanceOf(Promise);
    expect(player.cachedSegmentIds.length).toBeLessThanOrEqual(2); player.dispose();
  });
  it('applies a validated frozen edit immediately and rejects stale inflation or malicious overrides', async () => {
    const doc = await book(), player = createCompositionPlayer(doc), edited = await decodeSegment(doc.segments[0]);
    const old = player.framePair(.2); edited.nodes[0].text = '편집 완료'; player.setProjectOverride('first', edited);
    edited.nodes[0].text = 'later mutation'; expect(await old).toBeNull();
    expect((await player.framePair(.2))!.from.svg).toContain('편집 완료');
    expect((await player.seek(.2))!.svg).not.toContain('later mutation');
    expect(() => player.setProjectOverride('first', { ...edited, background: 'url(javascript:alert(1))' })).toThrow();
    player.clearProjectOverride(); expect((await player.framePair(.2))!.from.svg).not.toContain('편집 완료'); player.dispose();
  });
  it('lets global off override child blend and lazily rejects transparent child backgrounds', async () => {
    const doc = await book(); doc.temporal!.mode = 'off';
    const player = createCompositionPlayer(doc), frame = (await player.seek(.25))!;
    expect(frame.svg).toBe(runtime.renderSample(frame.project, .25));
    expect((await player.framePair(.25))!.to).toBeUndefined(); player.dispose();
    const bad = await decodeSegment(doc.segments[0]); bad.temporal = undefined; bad.background = 'transparent';
    doc.segments[0] = await encodeSegment(doc.segments[0], bad); doc.temporal!.mode = 'blend';
    const guarded = createCompositionPlayer(doc); await expect(guarded.framePair(.25)).rejects.toThrow(/불투명/); guarded.dispose();
  });
});

/** Execute the exported scripts, including the persistent two-layer DOM adapter. */
interface MockElement {
  innerHTML: string; textContent: string; style: Record<string, string>; dataset: Record<string, string>; children: MockElement[]; value: string; checked: boolean;
  replaceChildren(...children: MockElement[]): void; addEventListener(): void; setAttribute(): void; removeAttribute(): void; getBoundingClientRect(): object;
}
function mockElement(): MockElement {
  return { innerHTML: '', textContent: '', style: {} as Record<string, string>, dataset: {} as Record<string, string>, children: [] as MockElement[], value: '', checked: true,
    replaceChildren(...children: MockElement[]) { this.children = children; this.innerHTML = ''; }, addEventListener() {}, setAttribute() {}, removeAttribute() {}, getBoundingClientRect() { return {}; } };
}
async function exportedPlayer(html: string) {
  const json = html.match(/<script type="application\/json" id="motion-data">([\s\S]*?)<\/script>/)![1];
  const code = html.match(/<script>\n([\s\S]*?)<\/script>/)![1];
  const elements = Object.fromEntries(['motion-data', 'stage', 'seek', 'time', 'play', 'previous', 'next', 'loop', 'error'].map(id => [id, mockElement()]));
  elements['motion-data'].textContent = json;
  const context = vm.createContext({ window: {}, Blob, CompressionStream, DecompressionStream, TextDecoder, TextEncoder, atob, btoa, document: { fonts: { load: async () => [], ready: Promise.resolve() }, createElement: mockElement, getElementById: (id: string) => elements[id], addEventListener() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  vm.runInContext(code, context); await context.window.motionPlayer.ready;
  return { player: context.window.motionPlayer, stage: elements.stage };
}
it('runs both actual offline exporters with matching endpoint geometry, opacity and cuts', async () => {
  const single = project(), doc = await book(); doc.temporal!.cuts = [1];
  for (const input of [single, doc]) {
    const { player, stage } = await exportedPlayer(exportHtml(input));
    const resolve = input.schemaVersion === 1 ? createProjectRenderer(input).framePair : createCompositionPlayer(input).framePair;
    for (const t of [.25, .5, .99, 1]) {
      const expected = (await resolve(t))!; await player.seek(t);
      const layers = stage.children.slice(2);
      const lower = layers.find(l => l.style.zIndex === '0' && l.style.visibility === 'visible')!;
      const upper = layers.find(l => l.style.zIndex === '1');
      // IDs include runtime-private project counters, but geometry is identical.
      const normalize = (svg: string) => svg.replace(/ep\d+r\d+t[\d_e+-]+/g, 'endpoint');
      expect(normalize(lower.innerHTML)).toBe(normalize(expected.from.svg));
      expect(lower.style.opacity).toBe('1');
      if (expected.to) { expect(normalize(upper!.innerHTML)).toBe(normalize(expected.to.svg)); expect(Number(upper!.style.opacity)).toBe(expected.mix); }
      else expect(layers.filter(l => l.innerHTML).length).toBe(1);
      expect(Number(stage.dataset.blendMix)).toBe(expected.mix);
    }
  }
});

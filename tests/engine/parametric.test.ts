import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
// @ts-expect-error The offline prototype is intentionally plain dependency-free JavaScript.
import { createParametricVectorRuntime } from '../../scripts/parametric-vector-model.mjs';

const api = createParametricVectorRuntime();
function model() {
  return { width: 200, height: 100, anchorTime: 10, anchors: [{ time: 10, matrix: [1, 0, 0, 1, 0, 0] }, { time: 11, matrix: [1, 0, 0, 1, 40, 20] }], shapes: [{ id: 'plane', points: [[0, 0], [200, 0], [200, 100], [0, 100]], fill: '#aabbcc' }], validRanges: [{ start: 10, end: 11 }] };
}
function triangle() {
  const planes = { left: { topRGB: [10, 20, 30], bottomRGB: [100, 110, 120] }, center: { topRGB: [30, 40, 50], bottomRGB: [140, 150, 160] }, right: { topRGB: [20, 30, 40], bottomRGB: [110, 120, 130] } };
  return { kind: 'triangle-lines', width: 200, height: 100, anchorTime: 10, anchors: [
    { time: 10, lines: { left: { slope: -.5, intercept: 90 }, right: { slope: .5, intercept: 110 } }, planes },
    { time: 11, lines: { left: { slope: -.25, intercept: 95 }, right: { slope: .25, intercept: 105 } }, planes },
  ] };
}

describe('experimental single-anchor parametric vectors', () => {
  it('preserves both observed transform keys exactly and moves one geometry between them', () => {
    const render = api.createRenderer(model());
    expect(render(10).matrix).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(render(11).matrix).toEqual([1, 0, 40, 0, 1, 20, 0, 0, 1]);
    expect(render(10.5).matrix).toEqual([1, 0, 20, 0, 1, 10, 0, 0, 1]);
    expect(render(10.5).svg.match(/data-shape-id=/g).length).toBe(1);
    expect(render(10.5).svg).not.toMatch(/opacity=|<(image|video|canvas|foreignObject)/);
  });
  it('separates easing from observed endpoints and keeps arbitrary seek deterministic', () => {
    const render = api.createRenderer(model());
    expect(render(10.25).matrix[2]).toBe(10);
    expect(render(10.25, { easing: 'smoothstep' }).matrix[2]).toBe(6.25);
    const expected = render(10.37).svg; render(11); render(10); expect(render(10.37).svg).toBe(expected);
    expect(render(11, { easing: 'smoothstep' }).matrix).toEqual(render(11).matrix);
  });
  it('avoids matrix-lerp collapse by interpolating affine rotation and log scale', () => {
    const value = model(); value.anchors[1].matrix = [-1, 0, 0, -1, 0, 0];
    const render = api.createRenderer(value), m = render(10.5).matrix;
    expect(render(10.5).status).toBe('ok');
    expect(Math.hypot(m[0], m[3])).toBeCloseTo(1);
    expect(m[0] * m[4] - m[1] * m[3]).toBeCloseTo(1);
    expect(api.createRenderer({ ...value, affineInterpolation: 'matrix' })(10.5)).toMatchObject({ status: 'fallback', reason: 'degenerate-or-reflected-affine', svg: null });
  });
  it('does not extrapolate or cross real cuts from the anchor shot', () => {
    const render = api.createRenderer({ ...model(), cuts: [10.6] });
    expect(render(9.9)).toMatchObject({ status: 'fallback', reason: 'outside-validated-range' });
    expect(render(10.5)).toMatchObject({ status: 'fallback', reason: 'anchor-interval-crosses-cut' });
    expect(render(10.6)).toMatchObject({ status: 'fallback', reason: 'different-shot-from-anchor' });
    expect(render(10).status).toBe('ok');
  });
  it('projects only explicitly corresponding straight-line vertices and guards horizons outside domain', () => {
    const value = { ...model(), mode: 'projective', anchors: [{ time: 10, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, { time: 11, homography: [1, 0, 0, 0, 1, 0, .001, 0, 1] }] };
    const result = api.createRenderer(value)(10.5);
    expect(result.status).toBe('ok'); expect(result.matrix[6]).toBe(.0005);
    expect(result.svg).toContain('181.818181818');
    const dangerous = { ...value, anchors: [value.anchors[0], { time: 11, homography: [1, 0, 0, 0, 1, 0, -.001, 0, 1] }], shapes: [{ ...value.shapes[0], points: [[0, 0], [2000, 0], [0, 100]] }] };
    expect(() => api.createRenderer(dangerous)(11)).not.toThrow();
    expect(api.createRenderer(dangerous)(11)).toMatchObject({ status: 'fallback', reason: 'projective-horizon', svg: null });
  });
  it('rejects reflection, singular motion and the bbox-scale explosion failure mode', () => {
    for (const m of [[-1, 0, 0, 1, 0, 0], [0, 0, 0, 0, 0, 0], [100, 0, 0, 100, 0, 0]]) {
      const value = model(); value.anchors[1].matrix = m;
      expect(api.createRenderer(value)(11).status).toBe('fallback');
    }
  });
  it('keeps trusted vector gradients and logical node IDs inside a single transformed anchor', () => {
    const trustedAnchorSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path data-node-id="n" d="M0 0L200 100" fill="url(#g)"/></svg>';
    const render = api.createRenderer({ ...model(), shapes: [], trustedAnchorSvg });
    const result = render(10.5, { namespace: 'panel-model' });
    expect(result.svg).toContain('id="panel-model-g"'); expect(result.svg).toContain('url(#panel-model-g)');
    expect(result.svg).toContain('data-node-id="n"'); expect(result.svg.match(/data-node-id=/g).length).toBe(1);
    expect(result.svg).toContain('matrix(1 0 0 1 20 10)');
    expect(api.createRenderer({ ...model(), mode: 'projective', shapes: [], trustedAnchorSvg })(10.5)).toMatchObject({ status: 'fallback', reason: 'projective-requires-explicit-point-shapes' });
  });
  it('rejects active/raster/external anchor SVG and unsafe model data', () => {
    for (const fragment of ['<image href="data:image/png;base64,abc"/>', '<script>alert(1)</script>', '<path onclick="alert(1)"/>', '<use href="https://x.test/a.svg#g"/>', '<style>@import "https://x.test"</style>', '<path fill="url(https://x.test)"/>']) {
      expect(() => api.createRenderer({ ...model(), trustedAnchorSvg: `<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>` })).toThrow();
    }
    expect(() => api.createRenderer({ ...model(), background: 'url(javascript:x)' })).toThrow();
    expect(() => api.createRenderer(model())(10.5, { namespace: '"><script>' })).toThrow();
    expect(() => api.createRenderer(model())(NaN)).toThrow();
  });
  it('isolates prepared models from later input edits and applies a fixed ROI with excluded holes', () => {
    const value = model(); const render = api.createRenderer({ ...value, clipToDomain: true, domain: { polygon: [[0, 0], [200, 0], [200, 100], [0, 100]], excludedPolygons: [[[50, 0], [100, 0], [100, 100], [50, 100]]] } });
    value.shapes[0].fill = '#000000'; expect(render(10.5).svg).toContain('#aabbcc');
    expect(render(10.5).svg).toContain('<mask ');
    expect(render(10.5).svg).toContain('points="50,0 100,0 100,100 50,100" fill="black"');
    expect(Object.isFrozen(render.model.anchors[0].homography)).toBe(true);
  });
  it('renders three analytically clipped gradient planes with stable boundary identity', () => {
    const value = triangle(), render = api.createRenderer(value), result = render(10.5);
    expect(result.parameters.lines.left).toEqual({ slope: -.375, intercept: 92.5 });
    expect(result.parameters.lines.right).toEqual({ slope: .375, intercept: 107.5 });
    expect(result.svg.match(/data-shape-id=/g).length).toBe(3);
    expect(result.svg.match(/<linearGradient /g).length).toBe(3);
    expect(result.svg).not.toMatch(/opacity=|<(image|video|canvas|foreignObject)/);
    expect(render(10).parameters.lines).toEqual(value.anchors[0].lines);
    expect(render(11).parameters.planes).toEqual(value.anchors[1].planes);
  });
  it('rejects crossed planes and fits RGB colors without unsafe paint strings', () => {
    const value = triangle(); value.anchors[1].lines.left.intercept = 150;
    expect(api.createRenderer(value)(11)).toMatchObject({ status: 'fallback', reason: 'crossed-plane-boundaries' });
    value.anchors[1].planes.left.topRGB[0] = 256; expect(() => api.createRenderer(value)).toThrow();
  });
  it('matches SciPy PCHIP values, preserves C1 joins and stays within adjacent monotonic bounds', () => {
    const base = triangle(), times = [10, 10.2, 10.7, 11], values = [70, 75, 92, 95];
    const value = { ...base, parameterInterpolation: 'pchip', anchors: times.map((time, i) => ({ ...base.anchors[0], time, lines: { ...base.anchors[0].lines, left: { slope: -.5, intercept: values[i] } } })) };
    const render = api.createRenderer(value), f = (t: number) => render.evaluate(t).parameters.lines.left.intercept;
    for (const [time, expected] of [[10.1, 72.35573798239675], [10.45, 84.33852771481557], [10.85, 94.01684782608696]]) expect(f(time)).toBeCloseTo(expected, 11);
    for (const t of [10.2, 10.7]) {
      const h = 1e-6, a = (f(t) - f(t - h)) / h, b = (f(t + h) - f(t)) / h;
      expect(Math.abs(a - b)).toBeLessThan(.001);
    }
    for (let i = 0; i < times.length - 1; i++) for (let j = 0; j <= 100; j++) {
      const v = f(times[i] + (times[i + 1] - times[i]) * j / 100);
      expect(v).toBeGreaterThanOrEqual(values[i] - 1e-10); expect(v).toBeLessThanOrEqual(values[i + 1] + 1e-10);
    }
  });
  it('executes the same closed factory offline without imports, network or dependencies', () => {
    const runtime = vm.runInNewContext(`(${createParametricVectorRuntime.toString()})()`);
    const value = triangle();
    for (const time of [10, 10.125, 10.5, 10.9, 11]) expect(runtime.createRenderer(value)(time).svg).toBe(api.createRenderer(value)(time).svg);
  });
});

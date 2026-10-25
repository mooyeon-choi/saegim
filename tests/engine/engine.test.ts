import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { strFromU8, unzipSync } from 'fflate';
import { createDemoProject } from '../../src/demo';
import { createProjectRenderer, createProjectZip, evaluateNode, exportHtml, exportProjectJson, MAX_PROJECT_BYTES, renderSvg, validateProject } from '../../src/engine';
import { assertProjectJsonSize } from '../../src/engine/limits';
import type { MotionKeyframe, MotionNode } from '../../src/types';

function key(time: number, values: Partial<MotionKeyframe> = {}): MotionKeyframe {
  return { time, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: 'linear', ...values };
}
function node(values: Partial<MotionNode> = {}): MotionNode {
  return { ...createDemoProject().nodes[3], keyframes: [], ...values };
}

/** Minimal DOM permits executing the real exported JavaScript with no browser or network. */
function loadPlayer(html: string) {
  const json = html.match(/<script type="application\/json" id="motion-data">([\s\S]*?)<\/script>/)![1];
  const source = html.match(/<script>\n([\s\S]*?)<\/script>/)![1];
  const elements: Record<string, { textContent: string; innerHTML: string; value: string; checked: boolean; addEventListener: () => void; setAttribute: () => void }> = {};
  for (const id of ['motion-data', 'stage', 'seek', 'time', 'play', 'previous', 'next', 'loop']) {
    elements[id] = { textContent: id === 'motion-data' ? json : '', innerHTML: '', value: '', checked: true, addEventListener() {}, setAttribute() {} };
  }
  let pending: ((now: number) => void) | undefined;
  const context = vm.createContext({ window: {}, document: { getElementById: (id: string) => elements[id], addEventListener() {} }, requestAnimationFrame: (callback: (now: number) => void) => { pending = callback; return 1; }, cancelAnimationFrame: () => { pending = undefined; } });
  vm.runInContext(source, context, { timeout: 2000 });
  const player = context.window.motionPlayer as { seek: (time: number) => number; play: () => void; pause: () => void; currentTime: number; playing: boolean; step: (frames: number) => void };
  return { player, elements, tick: (time: number) => { const callback = pending; pending = undefined; callback?.(time); } };
}

describe('time evaluation', () => {
  it('combines relative position, centered scale, rotation and opacity with base values', () => {
    const value = node({ x: 100, y: 200, width: 100, height: 50, rotation: 10, opacity: 0.8, keyframes: [key(0), key(2, { x: 40, y: 20, scaleX: 2, scaleY: 2, rotation: 80, opacity: 0.5 })] });
    expect(evaluateNode(value, 1)).toMatchObject({ x: 95, y: 197.5, width: 150, height: 75, rotation: 50, visible: true });
    expect(evaluateNode(value, 1).opacity).toBeCloseTo(0.6);
  });
  it('seeks deterministically in arbitrary order', () => {
    const p = createDemoProject();
    const expected = renderSvg(p, 3.5);
    for (const time of [7, 0, 2, 8, 1, 5.5]) renderSvg(p, time);
    expect(renderSvg(p, 3.5)).toBe(expected);
    expect(renderSvg(p, -10)).toBe(renderSvg(p, 0));
  });
  it('holds the initial and terminal keyframes', () => {
    const value = node({ keyframes: [key(1, { x: 10 }), key(4, { x: 70 })] });
    expect(evaluateNode(value, 0).x).toBe(value.x + 10);
    expect(evaluateNode(value, 7).x).toBe(value.x + 70);
  });
  it('treats visibility as start-inclusive and end-exclusive', () => {
    const value = node({ start: 1, end: 2 });
    expect(evaluateNode(value, 0.999).visible).toBe(false);
    expect(evaluateNode(value, 1).visible).toBe(true);
    expect(evaluateNode(value, 2).visible).toBe(false);
    expect(evaluateNode({ ...value, hidden: true }, 1.5).visible).toBe(false);
  });
  it('applies outgoing hold and easing semantics at exact keyframes', () => {
    const value = node({ x: 0, keyframes: [key(0, { easing: 'hold' }), key(2, { x: 100 })] });
    expect(evaluateNode(value, 1.99).x).toBe(0);
    expect(evaluateNode(value, 2).x).toBe(100);
    value.keyframes[0].easing = 'ease-in';
    expect(evaluateNode(value, 0.5).x).toBe(6.25);
    value.keyframes[0].easing = 'ease-out';
    expect(evaluateNode(value, 0.5).x).toBe(43.75);
  });
  it('does not mutate the supplied project', () => {
    const p = createDemoProject(); const before = JSON.stringify(p);
    renderSvg(p, 3); exportHtml(p); evaluateNode(p.nodes[0], 2);
    expect(JSON.stringify(p)).toBe(before);
  });
  it('renders text, primitives and paths as editable vector elements', () => {
    const svg = renderSvg(createDemoProject(), 3, { selectedId: 'headline', onionTimes: [2, 4] });
    for (const tag of ['text', 'rect', 'ellipse', 'path', 'line']) expect(svg).toContain(`<${tag}`);
    expect(svg).toContain('data-node-id="headline"');
    expect(svg).toContain('움직임을 코드로');
    expect(svg).toContain('stroke-dasharray="5 3"');
    expect(svg).not.toMatch(/<(image|video|foreignObject)\b/);
  });
});

describe('prepared project renderer', () => {
  it('shares its safe snapshot with ID-based evaluation without exposing mutable state', () => {
    const p = createDemoProject();
    p.nodes[0].gradient = { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] };
    const render = createProjectRenderer(p);
    const expected = render(3);
    expect(render.evaluate(p.nodes[0].id, 3)).toEqual(evaluateNode(p.nodes[0], 3));
    expect(() => { render.evaluate(p.nodes[0].id, 3)!.gradient!.stops[0].color = '#f00'; }).toThrow();
    expect(() => { render.evaluate(p.nodes[0].id, 3)!.keyframes[0].x = 10; }).toThrow();
    p.nodes[0].keyframes[0].x = 100;
    expect(render(3)).toBe(expected);
    expect(render.evaluate('missing', 3)).toBeUndefined();
    expect(() => render.evaluate('missing', NaN)).toThrow(/time/);
  });
  it('matches the one-shot renderer at arbitrary seek times with selection and onion frames', () => {
    const project = createDemoProject();
    const render = createProjectRenderer(project);
    const options = { selectedId: 'headline', onionTimes: [0.5, 2.5] };
    for (const time of [0, 3.5, 0.25, 8, -1, 4]) {
      expect(render(time, options)).toBe(renderSvg(project, time, options));
    }
  });
  it('captures a validated copy, isolated from later nested mutations of the input', () => {
    const project = createDemoProject();
    project.backgroundKeyframes = [{ time: 0, color: '#112233' }];
    const render = createProjectRenderer(project);
    const expected = render(3);
    project.nodes[0].text = 'changed';
    project.nodes[0].keyframes[0].x = 9999;
    project.nodes[3].fill = 'url(javascript:alert(1))';
    project.backgroundKeyframes[0].color = '#ffffff';
    project.nodes.length = 0;
    expect(render(3)).toBe(expected);
  });
  it('rejects invalid projects during preparation and non-finite times at every render', () => {
    const project = createDemoProject();
    project.nodes[0].fill = 'url(https://tracker.test/pixel)';
    expect(() => createProjectRenderer(project)).toThrow(/색상/);
    const render = createProjectRenderer(createDemoProject());
    expect(() => render(NaN)).toThrow(/time/);
    expect(() => render(Infinity)).toThrow(/time/);
  });
});

describe('validation and escaping', () => {
  it('rejects non-finite values and unsupported versions', () => {
    expect(() => renderSvg(createDemoProject(), NaN)).toThrow(/time/);
    expect(() => evaluateNode(node({ x: Infinity }), 1)).toThrow(/node.x/);
    expect(() => validateProject({ ...createDemoProject(), schemaVersion: 2 })).toThrow(/schemaVersion/);
  });
  it('rejects duplicate IDs, duplicate timestamps, unsafe colors, paths and source URLs', () => {
    const p = createDemoProject();
    expect(() => validateProject({ ...p, nodes: [p.nodes[0], p.nodes[0]] })).toThrow(/중복/);
    expect(() => evaluateNode(node({ keyframes: [key(1), key(1)] }), 1)).toThrow(/같은 시각/);
    expect(() => evaluateNode(node({ fill: 'url(https://tracker.test/pixel)' }), 1)).toThrow(/색상/);
    expect(() => evaluateNode(node({ type: 'path', path: 'M0 0" onclick="alert(1)' }), 1)).toThrow(/SVG/);
    expect(() => evaluateNode(node({ type: 'path', path: 'M0 0 L50' }), 1)).toThrow(/SVG/);
    expect(() => validateProject({ ...p, source: { name: 'x', url: 'javascript:alert(1)', width: 10, height: 10, duration: 8, fps: 30 } })).toThrow(/source.url/);
  });
  it('accepts valid relative paths, arcs, scientific notation and multiple subpaths', () => {
    expect(() => evaluateNode(node({ type: 'path', path: 'M0,0 l1e2-2e1 h20 v30 a10 20 30 0 1 40 50 z M 30 30 L 40 40 Z' }), 1)).not.toThrow();
  });
  it('bounds nodes and keyframes', () => {
    const p = createDemoProject();
    expect(() => validateProject({ ...p, nodes: Array.from({ length: 8001 }, (_, i) => ({ ...p.nodes[0], id: String(i) })) })).toThrow(/8000/);
    expect(() => evaluateNode(node({ keyframes: Array.from({ length: 5001 }, (_, i) => key(i / 1000)) }), 1)).toThrow(/5000/);
  });
  it('permits the high-detail node budget and preflights total keyframes before nested validation', () => {
    const p = createDemoProject();
    for (const count of [7999, 8000]) expect(validateProject({ ...p, nodes: Array.from({ length: count }, (_, i) => node({ id: String(i) })) }).nodes).toHaveLength(count);
    const observations = Array.from({ length: 5000 }, (_, i) => key(i / 1000));
    expect(() => validateProject({ ...p, nodes: Array.from({ length: 61 }, (_, i) => node({ id: String(i), keyframes: observations })) })).toThrow(/300,000/);
  });
  it('sorts observations without retaining unknown properties', () => {
    const p = createDemoProject();
    const parsed = validateProject({ ...p, evil: 'discard', nodes: [{ ...p.nodes[0], keyframes: [key(2), key(1)], onclick: 'alert(1)' }] });
    expect(parsed.nodes[0].keyframes.map(k => k.time)).toEqual([1, 2]);
    expect(parsed).not.toHaveProperty('evil');
    expect(parsed.nodes[0]).not.toHaveProperty('onclick');
  });
  it('escapes malicious OCR text and safely embeds JSON inside script elements', () => {
    const p = createDemoProject();
    p.name = '</title><script>globalThis.hacked=true</script>';
    p.nodes[0].text = '</script><img src=x onerror="alert(1)">&\u2028';
    p.nodes[0].fontFamily = '" onload="alert(1)';
    const svg = renderSvg(p, 3);
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;/script&gt;');
    expect(svg).toContain('font-family="&quot; onload=&quot;alert(1)"');
    const html = exportHtml(p);
    expect(html.match(/<script(?:\s|>)/g)).toHaveLength(2);
    expect(html).not.toContain('<img');
    expect(() => loadPlayer(html)).not.toThrow();
  });
});

describe('standalone export', () => {
  it('uses exactly the preview renderer at every seek, without an application server', () => {
    const p = createDemoProject();
    const { player, elements } = loadPlayer(exportHtml(p));
    for (const time of [0, 0.5, 1.25, 6.8, 3.25, 8, 2.7]) {
      player.seek(time);
      expect(elements.stage.innerHTML).toBe(renderSvg(p, time));
      expect(player.currentTime).toBe(time);
    }
    expect(() => player.seek(NaN)).toThrow();
  });
  it('supports play, pause, frame stepping and repeat without a stale clock after seek', () => {
    const { player, tick } = loadPlayer(exportHtml(createDemoProject()));
    player.play(); tick(0); tick(1000);
    expect(player.currentTime).toBe(1);
    player.seek(6); tick(2000); tick(2500);
    expect(player.currentTime).toBe(6.5);
    player.pause(); tick(3500);
    expect(player.currentTime).toBe(6.5);
    player.step(1);
    expect(player.currentTime).toBeCloseTo(6.5 + 1 / 30);
    player.seek(7.9); player.play(); tick(4000); tick(4300);
    expect(player.currentTime).toBeCloseTo(0.2);
  });
  it('ends on the final frame with repeat disabled', () => {
    const { player, tick, elements } = loadPlayer(exportHtml(createDemoProject()));
    elements.loop.checked = false;
    player.seek(7); player.play(); tick(0); tick(2000);
    expect(player.currentTime).toBe(8);
    expect(player.playing).toBe(false);
  });
  it('does not include a source video URL or external script/style resources', () => {
    const p = createDemoProject();
    p.source = { name: 'original.mp4', url: '/api/media/private.mp4', width: 960, height: 540, duration: 8, fps: 30 };
    const html = exportHtml(p);
    expect(html).not.toContain('/api/media/');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="https?:/);
    expect(html).toContain("connect-src 'none'");
  });
  it('produces a readable ZIP with editable project and independent HTML', () => {
    const p = createDemoProject();
    const entries = unzipSync(createProjectZip(p));
    expect(Object.keys(entries).sort()).toEqual(['README.txt', 'index.html', 'project.json']);
    expect(validateProject(JSON.parse(strFromU8(entries['project.json']))).nodes).toHaveLength(8);
    expect(loadPlayer(strFromU8(entries['index.html'])).player.currentTime).toBe(0);
    expect(strFromU8(entries['README.txt'])).toContain('fonts[].license');
  });
  it('keeps large JSON compact and identical to the editable ZIP document', () => {
    const p = createDemoProject();
    const path = 'M0 0' + ' '.repeat(99900);
    p.nodes = [node({ type: 'path', path, keyframes: Array.from({ length: 12 }, (_, i) => key(i / 2, { path })) })];
    const json = exportProjectJson(p);
    expect(json).not.toContain('\n');
    expect(JSON.parse(json)).toEqual(validateProject(p));
    expect(strFromU8(unzipSync(createProjectZip(p))['project.json'])).toBe(json);
    expect(exportProjectJson(createDemoProject())).toContain('\n');
  });
  // Full-size limit fixtures test correctness, not a five-second performance budget.
  it('enforces the shared byte limit including Unicode without allocating a full UTF-8 copy', () => {
    const prefix = 'x'.repeat(MAX_PROJECT_BYTES - 4);
    expect(() => assertProjectJsonSize(prefix + '😀')).not.toThrow();
    expect(() => assertProjectJsonSize(prefix + '한글')).toThrow(/96MB/);
    expect(() => assertProjectJsonSize('x'.repeat(MAX_PROJECT_BYTES + 1))).toThrow(/96MB/);
  }, 60_000);
});

describe('observed contour keyframes', () => {
  const first = 'M 0 0 L 100 100';
  const second = 'M 0 0 L 100 100 L 500 0';
  const base = 'M 0 0 L 100 100 L 1000 0';
  const drawing = () => node({ type: 'path', path: base, x: 20, keyframes: [key(0, { path: first }), key(1, { path: second, x: 100 }), key(2, { x: 200 })] });

  it('resolves arithmetic timestamp roundoff consistently for held observations and interpolated poses', () => {
    for (const [time, summedTime] of [[0.3, 0.1 + 0.2], [122 / 24, 121 / 24 + 1 / 24], [3599.3, 3599.1 + 0.2]]) {
      const n = drawing();
      n.end = 3600;
      const gradient = { type: 'linear' as const, x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] };
      n.keyframes = [key(0, { path: first, fill: '#100000', gradient, occlusionPath: '' }), key(summedTime, { path: second, fill: '#001000', gradient: null, occlusionPath: base, x: 100 }), key(summedTime + 0.1, { path: base })];
      expect(evaluateNode(n, time)).toMatchObject({ path: second, fill: '#001000', gradient: undefined, occlusionPath: base, x: n.x + 100 });
      expect(evaluateNode(n, time - 1e-10)).toMatchObject({ path: first, fill: '#100000', occlusionPath: '' });
      expect(evaluateNode(n, time - 1e-10).gradient).toEqual(gradient);
      n.keyframes.pop();
      expect(evaluateNode(n, time).path).toBe(second);
    }
  });

  it('uses the same roundoff boundary for adjacent nodes, fast rendering, background and offline export', () => {
    const cut = 0.1 + 0.2;
    const p = { ...createDemoProject(), background: '#ffffff', backgroundKeyframes: [{ time: cut, color: '#123456' }], nodes: [node({ id: 'outgoing', start: 0, end: cut }), node({ id: 'incoming', start: cut, end: 8 })] };
    const prepared = createProjectRenderer(p);
    const { player, elements } = loadPlayer(exportHtml(p));
    for (const time of [0.3 - 1e-10, 0.3, 0.3 + 1e-10]) {
      const incoming = time >= 0.3;
      expect(prepared.evaluate('incoming', time)?.visible).toBe(incoming);
      expect(prepared.evaluate('outgoing', time)?.visible).toBe(!incoming);
      const svg = prepared(time);
      expect(svg.includes('data-node-id="incoming"')).toBe(incoming);
      expect(svg.includes('data-node-id="outgoing"')).toBe(!incoming);
      expect(svg).toContain(`<rect width="960" height="540" fill="${incoming ? '#123456' : '#ffffff'}"/>`);
      player.seek(time);
      expect(elements.stage.innerHTML).toBe(svg);
    }
  });

  it('holds observed contours while interpolating transforms and falls back explicitly to the base path', () => {
    const value = drawing();
    expect(evaluateNode(value, 0.5)).toMatchObject({ path: first, x: 70 });
    expect(evaluateNode(value, 0.999).path).toBe(first);
    expect(evaluateNode(value, 1).path).toBe(second);
    expect(evaluateNode(value, 1.5)).toMatchObject({ path: second, x: 170 });
    expect(evaluateNode(value, 2.5).path).toBe(base);
    expect(evaluateNode(value, 0.5).path).toBe(first);
  });

  it('preserves contours on import and executes identical draw-on observations in standalone HTML', () => {
    const p = validateProject(JSON.parse(JSON.stringify({ ...createDemoProject(), nodes: [drawing()] })));
    expect(p.nodes[0].keyframes[0].path).toBe(first);
    const { player, elements } = loadPlayer(exportHtml(p));
    for (const time of [0.5, 1.5, 2.5, 0.5]) {
      player.seek(time);
      expect(elements.stage.innerHTML).toBe(renderSvg(p, time));
    }
    expect(renderSvg(p, 0.5)).toContain(`d="${first}"`);
    expect(renderSvg(p, 1.5)).toContain(`d="${second}"`);
  });

  it('rejects malicious or malformed contour keyframes and path keys on other node types', () => {
    for (const path of ['M0 0" onload="alert(1)', '</path><script>alert(1)</script>', 'M0 0 LInfinity 3', 'M0 0 L4']) {
      expect(() => evaluateNode({ ...drawing(), keyframes: [key(0, { path })] }, 0)).toThrow(/path/);
    }
    expect(() => evaluateNode(node({ type: 'rect', keyframes: [key(0, { path: first })] }), 0)).toThrow(/path 요소/);
  });

  // Full-size limit fixtures test correctness, not a five-second performance budget.
  it('enforces per-path coordinate and total path byte budgets', () => {
    expect(() => evaluateNode({ ...drawing(), path: 'M0 0' + 'L0 0'.repeat(10000) }, 0)).toThrow(/20,000/);
    const paddedPath = 'M0 0' + ' '.repeat(99990);
    expect(() => evaluateNode({ ...drawing(), keyframes: Array.from({ length: 641 }, (_, i) => key(i / 20, { path: paddedPath })) }, 0)).toThrow(/64MB/);
  }, 60_000);

  // Full-size limit fixtures test correctness, not a five-second performance budget.
  it('enforces the total coordinate budget across multiple paths', () => {
    const path = 'M0 0' + 'L0 0'.repeat(9998);
    expect(() => evaluateNode({ ...drawing(), keyframes: Array.from({ length: 401 }, (_, i) => key(i / 20, { path })) }, 0)).toThrow(/8,000,000/);
  }, 60_000);
});

describe('projected editable text, gradients and embedded fonts', () => {
  const warp = () => ({ top: [{ u: 0, x: 100, y: 0 }, { u: 1, x: 900, y: 100 }], bottom: [{ u: 0, x: 0, y: 1000 }, { u: 1, x: 1000, y: 900 }] });
  const gradient = () => ({ type: 'linear' as const, x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] });
  const projected = () => node({ id: 'projected', type: 'text', text: 'TITLE', fontSize: 120, width: 800, height: 300, textWarp: warp(), textBox: { x: 0, y: -90, width: 700, height: 92 }, textFit: 'width', occlusionPath: 'M 400 0 L 600 0 L 600 1000 L 400 1000 Z', gradient: gradient() });
  const project = () => ({ ...createDemoProject(), nodes: [projected()] });

  it('renders one real text definition reused by projected clips, with a vector occlusion mask', () => {
    const svg = renderSvg(project(), 1, { selectedId: 'projected', showOcclusion: true });
    expect(svg.match(/<text\b/g)).toHaveLength(1);
    expect(svg.match(/data-node-id=/g)).toHaveLength(1);
    expect(svg.match(/<use\b/g)?.length).toBeGreaterThan(500);
    expect(svg).toContain('TITLE');
    expect(svg).toContain('<mask');
    expect(svg).toContain('fill="#ff4567"');
    expect(svg).toContain('<linearGradient');
    expect(svg).not.toMatch(/NaN|Infinity|<(image|canvas|foreignObject|video)\b/);
  });
  it('interpolates matching envelopes, reveal and gradients while holding occlusion observations', () => {
    const first = warp(), second = warp(); second.top[0].x += 100;
    const a = gradient(), b = gradient(); b.stops[0].color = '#ffffff'; b.x2 = 0.5;
    const n = projected(); n.keyframes = [key(0, { textWarp: first, textReveal: 0, gradient: a, occlusionPath: '' }), key(2, { textWarp: second, textReveal: 1, gradient: b, occlusionPath: n.occlusionPath })];
    const value = evaluateNode(n, 1);
    expect(value.textWarp?.top[0].x).toBe(150);
    expect(value.textReveal).toBe(0.5);
    expect(value.gradient?.stops[0].color).toBe('#808080ff');
    expect(value.gradient).toMatchObject({ x2: 0.75 });
    expect(value.occlusionPath).toBe('');
    expect(evaluateNode(n, 2).occlusionPath).toBe(n.occlusionPath);
    expect(renderSvg({ ...project(), nodes: [n] }, 0)).not.toContain('<use');
  });
  it('maps warped text gradients to its measured ink box without changing ordinary shape gradients', () => {
    const p = project();
    const transform = 'gradientUnits="userSpaceOnUse" gradientTransform="translate(0 -90) scale(700 92)"';
    expect(renderSvg(p, 1)).toContain(transform);
    p.nodes[0].gradient = { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: gradient().stops };
    expect(renderSvg(p, 1).match(/<radialGradient[^>]+>/)?.[0]).toContain(transform);
    delete p.nodes[0].textWarp;
    expect(renderSvg(p, 1)).not.toContain('gradientUnits="userSpaceOnUse"');
  });
  it('supports curved boundaries and explicit solid-fill observations with no retained gradient', () => {
    const n = projected();
    n.textWarp = { top: [{ u: 0, x: 0, y: 0 }, { u: 0.5, x: 500, y: 200 }, { u: 1, x: 1000, y: 0 }], bottom: [{ u: 0, x: 0, y: 1000 }, { u: 0.5, x: 500, y: 800 }, { u: 1, x: 1000, y: 1000 }] };
    n.keyframes = [key(0, { fill: '#123456', gradient: null }), key(2)];
    expect(evaluateNode(n, 1)).toMatchObject({ fill: '#123456', gradient: undefined });
    expect(evaluateNode(n, 2).gradient).toEqual(n.gradient);
    expect(renderSvg({ ...project(), nodes: [n] }, 1)).not.toMatch(/NaN|Infinity/);
  });
  it('interpolates radial focus, radius and alpha without converting the fill into a URL input', () => {
    const n = projected();
    n.keyframes = [key(0, { gradient: { type: 'radial', cx: 0, cy: 0, r: 0.25, stops: [{ offset: 0, color: '#f008' }, { offset: 1, color: '#fff' }] } }), key(2, { gradient: { type: 'radial', cx: 1, cy: 1, r: 0.75, stops: [{ offset: 0, color: '#0f0f' }, { offset: 1, color: '#fff' }] } })];
    expect(evaluateNode(n, 1).gradient).toMatchObject({ type: 'radial', cx: 0.5, cy: 0.5, fx: 0.5, fy: 0.5, r: 0.5 });
    expect(evaluateNode(n, 1).gradient?.stops[0].color).toBe('#808000c4');
    expect(renderSvg({ ...project(), nodes: [n] }, 1)).toContain('<radialGradient');
  });
  it('rejects folded/mismatched envelopes, invalid gradients, unsafe mask paths and wrong node types', () => {
    const n = projected(); const folded = warp(); folded.bottom[0].x = 1000; folded.bottom[1].x = 0;
    expect(() => evaluateNode({ ...n, textWarp: folded }, 1)).toThrow(/경계/);
    const mismatched = warp(); mismatched.bottom[1].u = 0.9;
    expect(() => evaluateNode({ ...n, textWarp: mismatched }, 1)).toThrow(/경계/);
    expect(() => evaluateNode({ ...n, gradient: { ...gradient(), stops: [{ offset: 0, color: 'url(x)' }, { offset: 1, color: '#fff' }] } }, 1)).toThrow(/HEX/);
    expect(() => evaluateNode({ ...n, occlusionPath: 'M 0 0" onload="alert(1)' }, 1)).toThrow(/SVG/);
    expect(() => evaluateNode({ ...n, type: 'rect' }, 1)).toThrow(/text/);
    expect(() => evaluateNode({ ...n, textReveal: 2 }, 1)).toThrow(/textReveal/);
  });
  it('isolates nested warp, gradient and font metadata in prepared renderers', () => {
    const p = project(); const expected = renderSvg(p, 1); const render = createProjectRenderer(p);
    p.nodes[0].textWarp!.top[0].x = 800;
    p.nodes[0].gradient!.stops[0].color = '#ff0000';
    p.nodes[0].textBox!.y = 100;
    expect(render(1)).toBe(expected);
  });
  it('validates font MIME/base64/signature and CSS-safe family names before generating data-only font faces', () => {
    const p = project();
    const font = { family: 'Test Font', mimeType: 'font/ttf' as const, data: Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), license: 'Copyright Test\nSIL Open Font License <font>&' };
    expect(validateProject({ ...p, fonts: [font] }).fonts).toEqual([font]);
    expect(() => validateProject({ ...p, fonts: [{ ...font, family: 'x";src:url(https://x)' }] })).toThrow(/글꼴 이름/);
    expect(() => validateProject({ ...p, fonts: [{ ...font, data: 'javascript:alert(1)' }] })).toThrow(/base64/);
    expect(() => validateProject({ ...p, fonts: [{ ...font, mimeType: 'font/woff2' }] })).toThrow(/헤더/);
    const html = exportHtml({ ...p, fonts: [font] });
    expect(html).toContain('font-src data:');
    expect(html).toContain('@font-face');
    expect(html).toContain('data:font/ttf;base64,');
    expect(html).toContain('SIL Open Font License &lt;font&gt;&amp;');
    const json = html.match(/<script type="application\/json" id="motion-data">([\s\S]*?)<\/script>/)![1];
    expect(JSON.parse(json).fonts[0].license).toBe(font.license);
    expect(() => validateProject({ ...p, fonts: [{ ...font, license: 'x'.repeat(20001) }] })).toThrow(/20000/);
    expect(html).not.toMatch(/font-src\s+https?:/);
  });
  it('keeps exported warp, gradient, mask and reveal rendering identical at every seek', () => {
    const p = project(); p.nodes[0].keyframes = [key(0, { textReveal: 0 }), key(1, { textReveal: 1 })];
    const { player, elements } = loadPlayer(exportHtml(p));
    for (const t of [0, 0.3, 1, 3, 0.6]) { player.seek(t); expect(elements.stage.innerHTML).toBe(renderSvg(p, t)); }
  });
  it('bounds simultaneous meshes without rejecting sequential title cards', () => {
    const p = project();
    expect(() => validateProject({ ...p, nodes: Array.from({ length: 17 }, (_, i) => ({ ...projected(), id: String(i) })) })).toThrow(/16개/);
    expect(validateProject({ ...p, nodes: Array.from({ length: 17 }, (_, i) => ({ ...projected(), id: String(i), start: i / 3, end: (i + 1) / 3 })) }).nodes).toHaveLength(17);
  });
});

import type { MotionNode, MotionProject, FillGradient, TextWarp, MotionTemporal, BackgroundMotion, BackgroundMotionTrack, ForegroundMotion, ForegroundMotionTrack, AffineMatrix } from '../types';

export interface EvaluatedNode extends MotionNode {
  visible: boolean;
  scaleX: number;
  scaleY: number;
}
export interface RenderOptions { selectedId?: string; onionTimes?: number[]; showOcclusion?: boolean }

export interface TemporalEndpoint { key: string; svg: string; time: number; foregroundBackground?: string }
export interface TemporalFramePair {
  time: number; from: TemporalEndpoint; to?: TemporalEndpoint; mix: number; cut: boolean;
  fontCss: string; fontMetadata: string;
  sharedDefinitions?: string;
  sharedTransforms?: { id: string; matrix: AffineMatrix; colorId: string; gain: number[]; bias: number[]; opacity: number }[];
  backgroundStatus?: { mode: 'on' | 'off'; activeTrackIds: string[]; supported: boolean };
  sharedMatrixTransforms?: { id: string; matrix: AffineMatrix }[];
  sharedOpacityTransforms?: { id: string; opacity: number }[];
  foregroundStatus?: { mode: 'on' | 'off'; activeTrackIds: string[]; supported: boolean };
}
export interface BackgroundFrame {
  key: string; uses: string; sharedDefinitions: string;
  sharedTransforms: NonNullable<TemporalFramePair['sharedTransforms']>;
  backgroundStatus: NonNullable<TemporalFramePair['backgroundStatus']>;
}
export interface ForegroundFrame {
  key: string; fromUses: string; toUses: string;
  patches: { id: string; track: ForegroundMotionTrack; from: AffineMatrix; to: AffineMatrix; appearanceWeight?: number }[];
  foregroundStatus: NonNullable<TemporalFramePair['foregroundStatus']>;
}
export interface TemporalPlan { time: number; from: number; to?: number; mix: number; cut: boolean }
export interface EndpointCache { options: string; revision: number; frames: Map<string, TemporalEndpoint> }

/** This factory deliberately has no external dependencies. Its actual compiled function
 * is embedded in exports, so the preview and offline player execute the same renderer. */
export function createMotionRuntime() {
  const escape = (value: string | number) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const num = (value: number) => Number(value.toFixed(5));
  // Adding clip offsets can differ from the equivalent global timestamp by a
  // handful of ULPs. Treat only arithmetic roundoff as equal, never snap to FPS.
  const before = (a: number, b: number) => a < b && b - a > 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
  const ease = (t: number, name: string | undefined) => name === 'hold' ? 0 : name === 'ease-in' ? t * t : name === 'ease-out' ? 1 - (1 - t) * (1 - t) : name === 'ease-in-out' ? t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 : t;

  function mixGradient(a: FillGradient | undefined, b: FillGradient | undefined, t: number): FillGradient | undefined {
    if (!a || !b || a.type !== b.type || a.stops.length !== b.stops.length) return a;
    if (a === b || t <= 0) return a;
    if (t >= 1) return b;
    const mix = (x: number, y: number) => x + (y - x) * t;
    const rgba = (s: string) => { let hex = s.slice(1); if (hex.length < 5) hex = [...hex].map(c => c + c).join(''); if (hex.length === 6) hex += 'ff'; return [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2), 16)); };
    const stops = a.stops.map((stop, i) => ({ offset: mix(stop.offset, b.stops[i].offset), color: '#' + rgba(stop.color).map((v, j) => Math.round(mix(v, rgba(b.stops[i].color)[j])).toString(16).padStart(2, '0')).join('') }));
    if (a.type === 'linear' && b.type === 'linear') return { type: 'linear', x1: mix(a.x1, b.x1), y1: mix(a.y1, b.y1), x2: mix(a.x2, b.x2), y2: mix(a.y2, b.y2), stops };
    if (a.type === 'radial' && b.type === 'radial') return { type: 'radial', cx: mix(a.cx, b.cx), cy: mix(a.cy, b.cy), r: mix(a.r, b.r), fx: mix(a.fx ?? a.cx, b.fx ?? b.cx), fy: mix(a.fy ?? a.cy, b.fy ?? b.cy), stops };
    return a;
  }
  function mixWarp(a: TextWarp | undefined, b: TextWarp | undefined, t: number): TextWarp | undefined {
    if (!a || !b || a.top.length !== b.top.length || a.top.some((p, i) => p.u !== b.top[i].u)) return a;
    const side = (key: 'top' | 'bottom') => a[key].map((p, i) => ({ u: p.u, x: p.x + (b[key][i].x - p.x) * t, y: p.y + (b[key][i].y - p.y) * t }));
    return { top: side('top'), bottom: side('bottom') };
  }

  function evaluate(node: MotionNode, time: number): EvaluatedNode {
    let x = 0, y = 0, scaleX = 1, scaleY = 1, rotation = 0, opacity = 1;
    let path = node.path;
    let gradient = node.gradient, fill = node.fill, textWarp = node.textWarp, occlusionPath = node.occlusionPath, textReveal = node.textReveal ?? 1;
    let paintRegions = node.paintRegions, stackBoundary = node.stackBoundary;
    const keys = node.keyframes;
    if (keys.length) {
      let left = keys[0], right = keys[0];
      if (!before(time, keys[keys.length - 1].time)) left = right = keys[keys.length - 1];
      else if (time > keys[0].time) {
        let lo = 0, hi = keys.length - 1;
        while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (!before(time, keys[mid].time)) lo = mid; else hi = mid; }
        left = keys[lo]; right = keys[hi];
      }
      // Shape observations are held, never numerically morphed between unrelated
      // SVG commands. Missing keyframe paths explicitly fall back to node.path.
      path = left.path ?? node.path;
      paintRegions = left.paintRegions ?? node.paintRegions;
      stackBoundary = left.stackBoundary === null ? undefined : left.stackBoundary ?? node.stackBoundary;
      const ratio = right.time === left.time || !before(left.time, time) ? 0 : ease(clamp((time - left.time) / (right.time - left.time), 0, 1), left.easing);
      const mix = (a: number, b: number) => a + (b - a) * ratio;
      fill = left.fill ?? node.fill;
      gradient = mixGradient(left.gradient === null ? undefined : left.gradient ?? node.gradient, right.gradient === null ? undefined : right.gradient ?? node.gradient, ratio);
      textWarp = mixWarp(left.textWarp ?? node.textWarp, right.textWarp ?? node.textWarp, ratio);
      occlusionPath = left.occlusionPath ?? node.occlusionPath;
      textReveal = mix(left.textReveal ?? node.textReveal ?? 1, right.textReveal ?? node.textReveal ?? 1);
      x = mix(left.x, right.x); y = mix(left.y, right.y);
      scaleX = mix(left.scaleX, right.scaleX); scaleY = mix(left.scaleY, right.scaleY);
      rotation = mix(left.rotation, right.rotation); opacity = mix(left.opacity, right.opacity);
    }
    const width = node.width * scaleX, height = node.height * scaleY;
    return { ...node, x: node.x + x + (node.width - width) / 2, y: node.y + y + (node.height - height) / 2, width, height,
      rotation: node.rotation + rotation, opacity: clamp(node.opacity * opacity, 0, 1), scaleX, scaleY, path, fill, gradient, paintRegions, stackBoundary, textWarp, occlusionPath, textReveal,
      visible: !node.hidden && !before(time, node.start) && before(time, node.end) && node.opacity * opacity > 0,
    };
  }

  function warpedText(n: EvaluatedNode, attrs: string, id: string): string {
    const warp = n.textWarp!;
    const box = n.textBox ?? { x: 0, y: -(n.fontSize ?? 48) * 0.86, width: n.width / Math.max(n.scaleX, 0.00001), height: n.height / Math.max(n.scaleY, 0.00001) };
    if (box.width <= 0 || box.height <= 0 || n.width <= 0 || n.height <= 0 || !n.textReveal) return '';
    const font = `font-family="${escape(n.fontFamily ?? 'sans-serif')}" font-size="${num(n.fontSize ?? 48)}" font-weight="${n.fontWeight ?? 400}" font-style="${n.fontStyle ?? 'normal'}" letter-spacing="${num(n.letterSpacing ?? 0)}"`;
    const fit = n.textFit === 'width' ? ` textLength="${num('advance' in box && box.advance !== undefined ? box.advance : box.width)}" lengthAdjust="spacingAndGlyphs"` : '';
    let definitions = `<text id="${id}-text" ${attrs} ${font} xml:space="preserve" aria-hidden="true">${(n.text ?? '').split('\n').map((line, i) => `<tspan x="0" y="${num(i * (n.fontSize ?? 48) * 1.2)}"${fit}>${escape(line)}</tspan>`).join('')}</text>`;
    type Point = { x: number; y: number };
    const normalized = (p: Point) => ({ x: p.x * n.width / 1000, y: p.y * n.height / 1000 });
    // A projective mapping for the four-corner case; multi-knot envelopes use
    // piecewise bilinear strips so each supplied boundary point is reproduced.
    const q = [warp.top[0], warp.top[warp.top.length - 1], warp.bottom[warp.bottom.length - 1], warp.bottom[0]].map(normalized);
    const dx1 = q[1].x - q[2].x, dx2 = q[3].x - q[2].x, dx3 = q[0].x - q[1].x + q[2].x - q[3].x;
    const dy1 = q[1].y - q[2].y, dy2 = q[3].y - q[2].y, dy3 = q[0].y - q[1].y + q[2].y - q[3].y;
    const det = dx1 * dy2 - dx2 * dy1;
    const g = Math.abs(det) < 1e-9 ? 0 : (dx3 * dy2 - dx2 * dy3) / det;
    const h = Math.abs(det) < 1e-9 ? 0 : (dx1 * dy3 - dx3 * dy1) / det;
    const map = (u: number, v: number): Point => {
      if (warp.top.length === 2) {
        const den = g * u + h * v + 1;
        return { x: ((q[1].x - q[0].x + g * q[1].x) * u + (q[3].x - q[0].x + h * q[3].x) * v + q[0].x) / den, y: ((q[1].y - q[0].y + g * q[1].y) * u + (q[3].y - q[0].y + h * q[3].y) * v + q[0].y) / den };
      }
      let i = 0; while (i < warp.top.length - 2 && warp.top[i + 1].u < u) i++;
      const t = (u - warp.top[i].u) / (warp.top[i + 1].u - warp.top[i].u);
      const edge = (side: 'top' | 'bottom') => normalized({ x: warp[side][i].x + (warp[side][i + 1].x - warp[side][i].x) * t, y: warp[side][i].y + (warp[side][i + 1].y - warp[side][i].y) * t });
      const a = edge('top'), b = edge('bottom'); return { x: a.x + (b.x - a.x) * v, y: a.y + (b.y - a.y) * v };
    };
    const source = (u: number, v: number) => ({ x: box.x + u * box.width, y: box.y + v * box.height });
    let shapes = '', count = 0;
    const triangle = (uv: [number, number][]) => {
      const s = uv.map(([u, v]) => source(u, v)), d = uv.map(([u, v]) => map(u, v));
      const denominator = (s[1].x - s[0].x) * (s[2].y - s[0].y) - (s[2].x - s[0].x) * (s[1].y - s[0].y);
      if (Math.abs(denominator) < 1e-10 || d.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return;
      const solve = (key: 'x' | 'y') => { const a = ((d[1][key] - d[0][key]) * (s[2].y - s[0].y) - (d[2][key] - d[0][key]) * (s[1].y - s[0].y)) / denominator; const b = ((s[1].x - s[0].x) * (d[2][key] - d[0][key]) - (s[2].x - s[0].x) * (d[1][key] - d[0][key])) / denominator; return [a, b, d[0][key] - a * s[0].x - b * s[0].y]; };
      const x = solve('x'), y = solve('y'), clip = `${id}-tri-${count++}`;
      // A subpixel overlap prevents antialiased hairlines between adjacent clips.
      const sign = ((d[1].x - d[0].x) * (d[2].y - d[0].y) - (d[1].y - d[0].y) * (d[2].x - d[0].x)) >= 0 ? 1 : -1;
      const normals = d.map((p, i) => { const next = d[(i + 1) % 3], dx = next.x - p.x, dy = next.y - p.y, length = Math.hypot(dx, dy) || 1; return { x: sign * dy / length, y: -sign * dx / length }; });
      const expanded = d.map((p, i) => { const a = normals[(i + 2) % 3], b = normals[i], x = a.x + b.x, y = a.y + b.y, denominator = Math.max(0.00001, x * a.x + y * a.y); return `${num(p.x + 0.6 * x / denominator)},${num(p.y + 0.6 * y / denominator)}`; }).join(' ');
      definitions += `<clipPath id="${clip}" clipPathUnits="userSpaceOnUse"><polygon points="${expanded}"/></clipPath>`;
      shapes += `<g clip-path="url(#${clip})"><use href="#${id}-text" transform="matrix(${[x[0], y[0], x[1], y[1], x[2], y[2]].map(num).join(' ')})"/></g>`;
    };
    const reveal = clamp(n.textReveal ?? 1, 0, 1);
    const us = [...new Set([0, reveal, ...Array.from({ length: 49 }, (_, i) => i / 48), ...warp.top.map(p => p.u)].filter(u => u <= reveal))].sort((a, b) => a - b);
    for (let i = 0; i < us.length - 1; i++) for (let j = 0; j < 6; j++) {
      const a = us[i], b = us[i + 1], c = j / 6, d = (j + 1) / 6;
      triangle([[a, c], [b, c], [b, d]]); triangle([[a, c], [b, d], [a, d]]);
    }
    const boundary = [...us.map(u => map(u, 0)), ...[...us].reverse().map(u => map(u, 1))].map(p => `${num(p.x)},${num(p.y)}`).join(' ');
    definitions += `<clipPath id="${id}-outline"><polygon points="${boundary}"/></clipPath>`;
    return `<defs>${definitions}</defs><g role="img" aria-label="${escape(n.text ?? '')}" clip-path="url(#${id}-outline)">${shapes}</g>`;
  }

  // Round only closed polygon observations. Stored contours and the geometry
  // used by objectBoundingBox paints remain unchanged. Distances are measured in
  // project coordinates, including non-uniform node scaling.
  function roundedPolygon(path: string, width: number, height: number, radius: number): string {
    if (!radius || width <= 0 || height <= 0 || /[a-df-kno-wy]/i.test(path)) return path;
    const tokens = path.match(/[MmLlZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
    if (path.replace(/[MmLlZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g, '').replace(/[\s,]/g, '')) return path;
    type Point = [number, number];
    const rings: Point[][] = []; let ring: Point[] | undefined, command = '', x = 0, y = 0, i = 0;
    while (i < tokens.length) {
      if (/^[a-z]$/i.test(tokens[i])) {
        command = tokens[i++];
        if (command.toUpperCase() === 'Z') {
          if (!ring || ring.length < 3) return path;
          x = ring[0][0]; y = ring[0][1];
          if (ring.length > 3 && ring[ring.length - 1][0] === x && ring[ring.length - 1][1] === y) ring.pop();
          rings.push(ring); ring = undefined; command = ''; continue;
        }
        if (command.toUpperCase() === 'M' && ring) return path;
      }
      if (!command || i + 1 >= tokens.length || /^[a-z]$/i.test(tokens[i]) || /^[a-z]$/i.test(tokens[i + 1])) return path;
      const relative = command === command.toLowerCase();
      x = Number(tokens[i++]) + (relative ? x : 0); y = Number(tokens[i++]) + (relative ? y : 0);
      if (command.toUpperCase() === 'M') { ring = []; command = relative ? 'l' : 'L'; }
      if (!ring) return path;
      if (!ring.length || ring[ring.length - 1][0] !== x || ring[ring.length - 1][1] !== y) ring.push([x, y]);
    }
    if (ring || !rings.length) return path;
    const point = (p: Point) => `${num(p[0])} ${num(p[1])}`;
    return rings.map(points => {
      const corners = points.map((p, j) => {
        const a = points[(j + points.length - 1) % points.length], b = points[(j + 1) % points.length];
        const ax = (a[0] - p[0]) * width / 1000, ay = (a[1] - p[1]) * height / 1000;
        const bx = (b[0] - p[0]) * width / 1000, by = (b[1] - p[1]) * height / 1000;
        const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
        const distance = Math.abs(ax * by - ay * bx) <= 1e-8 * al * bl ? 0 : Math.min(radius, .45 * al, .45 * bl);
        return { p, incoming: [p[0] + (a[0] - p[0]) * distance / (al || 1), p[1] + (a[1] - p[1]) * distance / (al || 1)] as Point,
          outgoing: [p[0] + (b[0] - p[0]) * distance / (bl || 1), p[1] + (b[1] - p[1]) * distance / (bl || 1)] as Point, distance };
      });
      return `M${point(corners[0].incoming)}` + corners.map((c, j) => `${j ? ` L${point(c.incoming)}` : ''}${c.distance ? ` Q${point(c.p)} ${point(c.outgoing)}` : ''}`).join('') + ' Z';
    }).join(' ');
  }

  function nodeSvg(node: MotionNode, time: number, id: string, options: RenderOptions = {}, legacySource = false): string {
    if (node.hidden || node.opacity <= 0 || before(time, node.start) || !before(time, node.end)) return '';
    const n = evaluate(node, time);
    // Foreground affine patches sample the observed vector paint, while their
    // visible endpoint keeps stack boundaries. Never nest the new stack mask
    // resources through a second cross-SVG <use> hierarchy.
    if (legacySource) n.stackBoundary = undefined;
    if (!n.visible) return '';
    const w = num(n.width), h = num(n.height);
    let definitions = '';
    if (n.gradient) {
      const g = n.gradient;
      const stops = g.stops.map(s => `<stop offset="${num(s.offset)}" stop-color="${escape(s.color)}"/>`).join('');
      // Browser text bounding boxes contain line-height space beyond the ink.
      // A calibrated warped title must reach gradient endpoints at the measured
      // ink edges, then follow the same affine mesh as the glyph itself.
      const box = n.type === 'text' && n.textWarp ? n.textBox : undefined;
      const units = box ? ` gradientUnits="userSpaceOnUse" gradientTransform="translate(${num(box.x)} ${num(box.y)}) scale(${num(box.width)} ${num(box.height)})"` : '';
      definitions = g.type === 'linear' ? `<linearGradient id="${id}-gradient"${units} x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">${stops}</linearGradient>` : `<radialGradient id="${id}-gradient"${units} cx="${g.cx}" cy="${g.cy}" r="${g.r}" fx="${g.fx ?? g.cx}" fy="${g.fy ?? g.cy}">${stops}</radialGradient>`;
    }
    const attrs = `fill="${n.gradient ? `url(#${id}-gradient)` : escape(n.fill)}" stroke="${escape(n.stroke)}" stroke-width="${num(n.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"`;
    let shape = '';
    if (n.type === 'rect') shape = `<rect width="${w}" height="${h}" rx="${num(Math.min(n.borderRadius ?? 0, w / 2, h / 2))}" ${attrs}/>`;
    if (n.type === 'ellipse') shape = `<ellipse cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}" ${attrs}/>`;
    if (n.type === 'line') shape = `<line x1="0" y1="0" x2="${w}" y2="${h}" ${attrs}/>`;
    if (n.type === 'path') {
      // Normalize the inner 1000-unit path stroke into project coordinates. Unlike
      // non-scaling-stroke, this still follows the outer responsive canvas scale.
      const pathStroke = n.strokeWidth * 1000 / Math.max(0.00001, Math.sqrt(w * h));
      shape = `<path d="${escape(n.path ?? '')}" transform="scale(${num(w / 1000)} ${num(h / 1000)})" ${attrs.replace(/stroke-width="[^"]*"/, `stroke-width="${num(pathStroke)}"`)}/>`;
    }
    if (n.type === 'text' && n.textWarp) shape = warpedText(n, attrs, id);
    else if (n.type === 'text') {
      const baseFont = n.fontSize ?? 48;
      const lines = (n.text ?? '').split('\n');
      // Text uses the same center scaling as geometry, including non-uniform scale.
      const fit = n.textFit === 'width' ? ` textLength="${num(node.width)}" lengthAdjust="spacingAndGlyphs"` : '';
      shape = `<text ${attrs} font-family="${escape(n.fontFamily ?? 'sans-serif')}" font-size="${num(baseFont)}" font-weight="${n.fontWeight ?? 400}" font-style="${n.fontStyle ?? 'normal'}" letter-spacing="${num(n.letterSpacing ?? 0)}" transform="scale(${num(n.scaleX)} ${num(n.scaleY)})" xml:space="preserve">${lines.map((line, i) => `<tspan x="0" y="${num(baseFont * (0.86 + i * 1.2))}"${fit}>${escape(line)}</tspan>`).join('')}</text>`;
      if ((n.textReveal ?? 1) < 1) { definitions += `<clipPath id="${id}-reveal"><rect width="${num(w * (n.textReveal ?? 1))}" height="${h}"/></clipPath>`; shape = `<g clip-path="url(#${id}-reveal)">${shape}</g>`; }
    }
    if (n.type !== 'text' && n.stackBoundary && n.type !== 'line') {
      const geometryId = `${id}-stack-shape`, contourId = `${id}-stack-contour`;
      const radius = n.stackBoundary.cornerRadiusPx ?? 0;
      const geometry = (geometryId: string, rounded: boolean) => {
        if (n.type === 'rect') return `<rect id="${geometryId}" width="${w}" height="${h}" rx="${num(Math.min(n.borderRadius ?? 0, w / 2, h / 2))}"/>`;
        if (n.type === 'ellipse') return `<ellipse id="${geometryId}" cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"/>`;
        return `<path id="${geometryId}" d="${escape(rounded ? roundedPolygon(n.path ?? '', w, h, radius) : n.path ?? '')}" transform="scale(${num(w / 1000)} ${num(h / 1000)})"/>`;
      };
      definitions += geometry(geometryId, false) + geometry(contourId, true);
      definitions += `<clipPath id="${id}-stack-outline"><use href="#${contourId}"/></clipPath>`;
      // Extend opaque color planes behind the final silhouette only. A stroke
      // does not change SVG objectBoundingBox gradient coordinates, unlike a
      // replacement rectangle. The final clip applies geometric AA just once.
      const padding = Math.max(2, radius * 2), paintStroke = n.type === 'path' ? 2 * padding * 1000 / Math.max(.00001, Math.min(w, h)) : 2 * padding;
      const opaqueColor = (color: string) => {
        const s = color.toLowerCase();
        if (s === 'none' || s === 'transparent') return false;
        if (s[0] === '#') return s.length === 5 ? s[4] === 'f' : s.length === 9 ? s.slice(7) === 'ff' : true;
        const match = /^(?:rgba?|hsla?)\((.*)\)$/.exec(s);
        if (!match) return true;
        const parts = match[1].replace(/[,/]/g, ' ').trim().split(/\s+/);
        return parts.length === 3 || Number.parseFloat(parts[3]) === (parts[3].endsWith('%') ? 100 : 1);
      };
      // A translucent fill and matching stroke would blend twice where they
      // overlap. Only opaque planes need padding; the opaque base already
      // seals the silhouette below transparent internal light/shadow layers.
      const plane = (paint: string, opaque = true) => `<use href="#${geometryId}" fill="${paint}" stroke="${opaque ? paint : 'none'}" stroke-width="${num(paintStroke)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      const alphaMask = (maskId: string, shapeId: string, feather: number, inward: boolean) => {
        const filterId = `${maskId}-soft`;
        // Bounds follow the individual shape, never the full video viewport.
        if (feather > 0) definitions += `<filter id="${filterId}" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">${inward ? `<feMorphology operator="erode" radius="${num(feather / 2)}"/>` : ''}<feGaussianBlur stdDeviation="${num(feather / 3)}"/></filter>`;
        // Explicit local units also keep mask coverage stable when foreground
        // affine patches instance this node through a cross-SVG <use>. Browser
        // objectBoundingBox mask caches can otherwise depend on seek history.
        definitions += `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="${num(-4 * w)}" y="${num(-4 * h)}" width="${num(10 * w)}" height="${num(10 * h)}" style="mask-type:alpha">${inward && feather > 0 ? `<g clip-path="url(#${id}-stack-outline)">` : ''}<use href="#${shapeId}" fill="white" stroke="none"${feather > 0 ? ` filter="url(#${filterId})"` : ''}/>${inward && feather > 0 ? '</g>' : ''}</mask>`;
        return ` mask="url(#${maskId})"`;
      };
      shape = plane(n.gradient ? `url(#${id}-gradient)` : escape(n.fill));
      for (const [index, region] of (n.paintRegions ?? []).entries()) {
        const regionId = `${id}-stack-${index}`, pathId = `${regionId}-path`;
        definitions += `<path id="${pathId}" d="${escape(roundedPolygon(region.path, w, h, radius))}" transform="scale(${num(w / 1000)} ${num(h / 1000)})" fill-rule="evenodd"/>`;
        if (region.gradient) {
          const g = region.gradient, stops = g.stops.map(s => `<stop offset="${num(s.offset)}" stop-color="${escape(s.color)}"/>`).join('');
          definitions += g.type === 'linear' ? `<linearGradient id="${regionId}-gradient" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">${stops}</linearGradient>` : `<radialGradient id="${regionId}-gradient" cx="${g.cx}" cy="${g.cy}" r="${g.r}" fx="${g.fx ?? g.cx}" fy="${g.fy ?? g.cy}">${stops}</radialGradient>`;
        }
        const opaque = region.gradient ? region.gradient.stops.every(s => opaqueColor(s.color)) : opaqueColor(region.fill);
        shape += `<g${alphaMask(`${regionId}-alpha`, pathId, region.featherPx ?? 0, false)} pointer-events="none">${plane(region.gradient ? `url(#${regionId}-gradient)` : escape(region.fill), opaque)}</g>`;
      }
      const outerAlpha = alphaMask(`${id}-stack-alpha`, contourId, n.stackBoundary.featherPx, true);
      // A mask forces a single offscreen composite. A clip alone can be applied
      // to each draw by browsers, creating duplicate AA at stacked silhouettes.
      shape = `<g${outerAlpha}>${shape}</g>`;
      if (n.strokeWidth > 0 && n.stroke !== 'none') {
        const stroke = n.type === 'path' ? n.strokeWidth * 1000 / Math.max(.00001, Math.sqrt(w * h)) : n.strokeWidth;
        shape += `<use href="#${contourId}" fill="none" stroke="${escape(n.stroke)}" stroke-width="${num(stroke)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    }
    else if (n.type !== 'text' && n.paintRegions?.length) {
      // One logical node and one stored contour. Repaint copies share geometry,
      // gradient bounds and the outer opacity/pose, and inherit painter order.
      // Stroke is drawn once above all fill copies, so clips never recolor it.
      const geometryId = `${id}-paint-shape`;
      let geometry = '';
      if (n.type === 'rect') geometry = `<rect id="${geometryId}" width="${w}" height="${h}" rx="${num(Math.min(n.borderRadius ?? 0, w / 2, h / 2))}"/>`;
      if (n.type === 'ellipse') geometry = `<ellipse id="${geometryId}" cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"/>`;
      if (n.type === 'line') geometry = `<line id="${geometryId}" x1="0" y1="0" x2="${w}" y2="${h}"/>`;
      if (n.type === 'path') geometry = `<path id="${geometryId}" d="${escape(n.path ?? '')}" transform="scale(${num(w / 1000)} ${num(h / 1000)})"/>`;
      definitions += geometry;
      // Complementary coverage replaces the old hue instead of stacking paint
      // on it. Matching positive/negative masks and additive premultiplied layers
      // preserve antialias coverage at both the silhouette and material boundary.
      // Isolation keeps the addition independent of lower scene layers.
      for (const [index, region] of n.paintRegions.entries()) {
        definitions += `<path id="${id}-paint-${index}-path" d="${escape(region.path)}" transform="scale(${num(w / 1000)} ${num(h / 1000)})" clip-rule="evenodd" fill-rule="evenodd"/>`;
      }
      const coverage = (index: number) => {
        const maskId = `${id}-paint-${index < 0 ? 'base' : index}-coverage`;
        const bounds = `x="${num(-4 * w)}" y="${num(-4 * h)}" width="${num(10 * w)}" height="${num(10 * h)}"`;
        const positive = index < 0 ? `<rect ${bounds} fill="white"/>` : `<use href="#${id}-paint-${index}-path" fill="white"/>`;
        const negative = n.paintRegions!.slice(index + 1).map((_, i) => `<use href="#${id}-paint-${index + 1 + i}-path" fill="black"/>`).join('');
        definitions += `<mask id="${maskId}" maskUnits="userSpaceOnUse" ${bounds} style="mask-type:luminance">${positive}${negative}</mask>`;
        return ` mask="url(#${maskId})"`;
      };
      shape = `<g style="isolation:isolate"><g${coverage(-1)}><use href="#${geometryId}" fill="${n.gradient ? `url(#${id}-gradient)` : escape(n.fill)}" stroke="none"/></g>`;
      for (const [index, region] of n.paintRegions.entries()) {
        const regionId = `${id}-paint-${index}`;
        if (region.gradient) {
          const g = region.gradient, stops = g.stops.map(s => `<stop offset="${num(s.offset)}" stop-color="${escape(s.color)}"/>`).join('');
          definitions += g.type === 'linear' ? `<linearGradient id="${regionId}-gradient" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">${stops}</linearGradient>` : `<radialGradient id="${regionId}-gradient" cx="${g.cx}" cy="${g.cy}" r="${g.r}" fx="${g.fx ?? g.cx}" fy="${g.fy ?? g.cy}">${stops}</radialGradient>`;
        }
        shape += `<g style="mix-blend-mode:plus-lighter"${coverage(index)} pointer-events="none"><use href="#${geometryId}" fill="${region.gradient ? `url(#${regionId}-gradient)` : escape(region.fill)}" stroke="none"/></g>`;
      }
      shape += '</g>';
      if (n.strokeWidth > 0 && n.stroke !== 'none') {
        const stroke = n.type === 'path' ? n.strokeWidth * 1000 / Math.max(0.00001, Math.sqrt(w * h)) : n.strokeWidth;
        shape += `<use href="#${geometryId}" fill="none" stroke="${escape(n.stroke)}" stroke-width="${num(stroke)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    }
    let overlay = '';
    if (n.occlusionPath) {
      const path = `<path d="${escape(n.occlusionPath)}" transform="scale(${num(w / 1000)} ${num(h / 1000)})"`;
      definitions += `<mask id="${id}-occlusion" maskUnits="userSpaceOnUse" x="${num(-4 * w)}" y="${num(-4 * h)}" width="${num(10 * w)}" height="${num(10 * h)}" style="mask-type:luminance"><rect x="${num(-4 * w)}" y="${num(-4 * h)}" width="${num(10 * w)}" height="${num(10 * h)}" fill="white"/>${path} fill="black"/></mask>`;
      shape = `<g mask="url(#${id}-occlusion)">${shape}</g>`;
      if (options.showOcclusion && (!options.selectedId || options.selectedId === n.id)) overlay = `${path} fill="#ff4567" opacity="0.35" pointer-events="none"/>`;
    }
    const selection = n.id === options.selectedId ? `<rect x="-4" y="-4" width="${num(w + 8)}" height="${num(h + 8)}" fill="none" stroke="#9b91ff" stroke-width="1.5" stroke-dasharray="5 3" pointer-events="none"/><circle cx="-4" cy="-4" r="3" fill="white" stroke="#7766ee" pointer-events="none"/><circle cx="${num(w + 4)}" cy="${num(h + 4)}" r="3" fill="white" stroke="#7766ee" pointer-events="none"/>` : '';
    return `<g data-node-id="${escape(n.id)}" transform="translate(${num(n.x)} ${num(n.y)}) rotate(${num(n.rotation)} ${num(w / 2)} ${num(h / 2)})" opacity="${num(n.opacity)}"><title>${escape(n.name)}</title>${definitions ? `<defs>${definitions}</defs>` : ''}${shape}${overlay}${selection}</g>`;
  }

  function background(project: MotionProject, time: number): string {
    const keys = project.backgroundKeyframes;
    if (!keys?.length || before(time, keys[0].time)) return project.background;
    let color = keys[0].color;
    for (const k of keys) { if (before(time, k.time)) break; color = k.color; }
    return color;
  }

  const assetCache = new WeakMap<MotionProject, { fontCss: string; fontMetadata: string }>();
  const projectIds = new WeakMap<MotionProject, number>();
  const pairCaches = new WeakMap<MotionProject, EndpointCache>();
  let nextProjectId = 0;
  function fontAssets(project: MotionProject) {
    const hit = assetCache.get(project); if (hit) return hit;
    const value = {
      fontCss: (project.fonts ?? []).map(f => `@font-face{font-family:"${f.family}";src:url("data:${f.mimeType};base64,${f.data}");font-weight:${f.weight ?? '100 900'};font-style:${f.style ?? 'normal'};font-display:block}`).join(''),
      fontMetadata: (project.fonts ?? []).filter(f => f.license).map(f => `<metadata data-font-license="${escape(f.family)}">${escape(f.license!)}</metadata>`).join(''),
    };
    assetCache.set(project, value); return value;
  }
  function renderSample(project: MotionProject, time: number, options: RenderOptions = {}, namespace?: string, includeAssets = true, overlay = '', foregroundOverlay = ''): string {
    const t = clamp(time, 0, Math.max(0, project.duration - 0.000001));
    let hash = 0; for (let i = 0; i < project.id.length; i++) hash = ((hash * 31) + project.id.charCodeAt(i)) | 0;
    const prefix = namespace ?? `mf${(hash >>> 0).toString(16)}`;
    const assets = includeAssets ? fontAssets(project) : { fontCss: '', fontMetadata: '' };
    const fonts = assets.fontCss, licenses = assets.fontMetadata;
    const ghosts = (options.onionTimes ?? []).slice(0, 8).filter(Number.isFinite).map((ti, j) => `<g opacity="0.16" pointer-events="none">${project.nodes.map((n, i) => nodeSvg(n, clamp(ti, 0, project.duration), `${prefix}-g${j}-${i}`)).join('')}</g>`).join('');
    const draw = (start: number, end: number, legacySource = false) => { const parts: string[] = []; for (let i = start; i < end; i++) { const svg = nodeSvg(project.nodes[i], t, `${prefix}-${legacySource ? 'fg-' : ''}n${i}`, legacySource ? {} : options, legacySource); parts.push(legacySource ? svg.replace(/ data-node-id=/g, ' data-foreground-node-id=') : svg); } return parts.join(''); };
    const firstText = overlay || foregroundOverlay ? project.nodes.findIndex(n => n.type === 'text') : -1;
    const split = firstText < 0 ? project.nodes.length : firstText;
    // Insert below the first editable text; preserve every original z-order
    // relationship, including non-text objects that intentionally cover text.
    const base = `<rect width="${project.width}" height="${project.height}" fill="${escape(background(project, t))}"/>`;
    // One legacy vector snapshot per endpoint is shared by every affine patch.
    // No snapshot is needed at observations, without a patch, or when the
    // observed foreground has no active stack options. IDs and logical-node
    // attributes stay distinct from visible/editable nodes.
    const legacySnapshot = foregroundOverlay && project.nodes.some((n, i) => {
      if (i >= split || n.hidden || n.opacity <= 0 || before(t, n.start) || !before(t, n.end) || !n.stackBoundary && !n.keyframes.some(k => k.stackBoundary)) return false;
      const observed = evaluate(n, t); return observed.visible && !!observed.stackBoundary;
    });
    const shapes = foregroundOverlay ? `${legacySnapshot ? `<defs><g id="${prefix}-foreground-source">${draw(0, split, true)}</g></defs>${draw(0, split)}` : `<g id="${prefix}-foreground-source">${draw(0, split)}</g>`}${foregroundOverlay}${overlay}${draw(split, project.nodes.length)}` : overlay ? draw(0, split) + overlay + draw(split, project.nodes.length) : draw(0, project.nodes.length);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${project.width} ${project.height}" width="${project.width}" height="${project.height}" role="img" aria-label="${escape(project.name)}" style="display:block;width:100%;height:100%;overflow:hidden">${licenses}${fonts ? `<style>${fonts}</style>` : ''}${base}${ghosts}${shapes}</svg>`;
  }
  const backgroundAssets = new WeakMap<BackgroundMotionTrack, { id: string; definition: string }>();
  function backgroundFrame(motion: BackgroundMotion | undefined, time: number, width: number, height: number): BackgroundFrame {
    const status: BackgroundFrame['backgroundStatus'] = { mode: motion?.mode ?? 'off', activeTrackIds: [], supported: false };
    const result: BackgroundFrame = { key: '', uses: '', sharedDefinitions: '', sharedTransforms: [], backgroundStatus: status };
    if (motion?.mode !== 'on') return result;
    for (const track of motion.tracks) {
      if (before(time, track.start) || !before(time, track.end)) continue;
      let i = 0; while (i + 1 < track.keys.length - 1 && !before(time, track.keys[i + 1].time)) i++;
      const a = track.keys[i], b = track.keys[Math.min(i + 1, track.keys.length - 1)];
      const dt = clamp(time - a.time, 0, b.time - a.time), ratio = b.time === a.time ? 0 : dt / (b.time - a.time);
      const channels = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
      const channel = (name: keyof NonNullable<BackgroundMotionTrack['pchip']>['channels'], left: number, right: number) => {
        if (!before(a.time, time)) return left;
        if (!before(time, b.time)) return right;
        const c = track.interpolation === 'pchip' ? track.pchip?.channels[name]?.[i] : undefined;
        return c ? ((c[0] * dt + c[1]) * dt + c[2]) * dt + c[3] : left + (right - left) * ratio;
      };
      const matrix = channels.map((name, j) => channel(name, a.matrix[j], b.matrix[j])) as AffineMatrix;
      const gain = (['gainR', 'gainG', 'gainB'] as const).map((name, j) => channel(name, a.gain?.[j] ?? 1, b.gain?.[j] ?? 1));
      const bias = (['biasR', 'biasG', 'biasB'] as const).map((name, j) => channel(name, a.bias?.[j] ?? 0, b.bias?.[j] ?? 0));
      const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
      // A polynomial can become singular between its endpoints. Unsupported
      // states reveal the intact original frame rather than an inverted plane.
      if (matrix.some((v, j) => !Number.isFinite(v) || Math.abs(v) > (j < 4 ? 8 : 65536)) || det < 0.01 || det > 64 || gain.some(v => !Number.isFinite(v) || v < 0 || v > 4) || bias.some(v => !Number.isFinite(v) || Math.abs(v) > 1)) continue;
      let asset = backgroundAssets.get(track);
      if (!asset) {
        const id = `bg${++nextProjectId}`, points = track.polygon.map(p => p.map(num).join(',')).join(' ');
        const shape = `<polygon points="${points}"/>`;
        const color = `<filter id="${id}-color" x="0" y="0" width="${width}" height="${height}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feComponentTransfer>${['R', 'G', 'B'].map(c => `<feFunc${c} id="${id}-color-${c}" type="linear" slope="1" intercept="0"/>`).join('')}</feComponentTransfer></filter>`;
        const feather = track.featherPx > 0 ? `<filter id="${id}-soft" x="0" y="0" width="${width}" height="${height}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${num(track.featherPx / 3)}"/></filter><mask id="${id}-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" style="mask-type:luminance"><polygon points="${points}" fill="white" stroke="black" stroke-width="${track.featherPx}" filter="url(#${id}-soft)"/></mask>` : '';
        const nodes = track.anchor.nodes.map((n, j) => nodeSvg(n, 0, `${id}-n${j}`).replace(/ data-node-id=/g, ' data-background-node-id=')).join('');
        const content = `<rect width="${width}" height="${height}" fill="${escape(track.anchor.background)}"/>${nodes}`;
        asset = { id, definition: `<clipPath id="${id}-clip">${shape}</clipPath>${color}${feather}<g id="${id}" clip-path="url(#${id}-clip)" pointer-events="none"><g id="${id}-transform-opacity" opacity="1"><g${track.featherPx ? ` mask="url(#${id}-mask)"` : ''}><g id="${id}-transform" transform="matrix(1 0 0 1 0 0)"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden"><g filter="url(#${id}-color)">${content}</g></svg></g></g></g></g>` };
        backgroundAssets.set(track, asset);
      }
      result.sharedDefinitions += asset.definition;
      const smooth = (v: number) => { const x = clamp(v, 0, 1); return x * x * (3 - 2 * x); };
      const opacity = Math.min(track.fadeIn ? smooth((time - track.start) / track.fadeIn) : 1, track.fadeOut ? smooth((track.end - time) / track.fadeOut) : 1);
      result.sharedTransforms.push({ id: `${asset.id}-transform`, matrix, colorId: `${asset.id}-color`, gain, bias, opacity });
      result.uses += `<use href="#${asset.id}" data-background-track="${escape(track.id)}" pointer-events="none"/>`;
      result.key += `-${asset.id}`; status.activeTrackIds.push(track.id);
    }
    status.supported = status.activeTrackIds.length > 0;
    return result;
  }
  const foregroundIds = new WeakMap<ForegroundMotionTrack, string>();
  const multiplyAffine = (a: AffineMatrix, b: AffineMatrix): AffineMatrix => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  function inverseAffine(m: AffineMatrix): AffineMatrix | undefined {
    const d = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(d) || d < 0.01 || d > 64 || m.some(v => !Number.isFinite(v))) return;
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
  }
  function appearanceWeight(alpha: number, curve: NonNullable<ForegroundMotionTrack['appearance']>): number {
    if (alpha <= 0) return 0;
    if (alpha >= 1) return 1;
    const left = Math.pow(alpha, curve.sharpness);
    const right = Math.pow((1 - alpha) * curve.midpoint / (1 - curve.midpoint), curve.sharpness);
    return clamp(left / (left + right), 0, 1);
  }
  function foregroundFrame(motion: ForegroundMotion | undefined, plan: TemporalPlan, width: number, height: number): ForegroundFrame {
    const status: ForegroundFrame['foregroundStatus'] = { mode: motion?.mode ?? 'off', activeTrackIds: [], supported: false };
    const result: ForegroundFrame = { key: '', fromUses: '', toUses: '', patches: [], foregroundStatus: status };
    if (motion?.mode !== 'on' || plan.cut || plan.to === undefined) return result;
    for (const track of motion.tracks) {
      if (before(track.start, plan.from) || before(plan.from, track.start) || before(track.end, plan.to) || before(plan.to, track.end)) continue;
      const inverse = inverseAffine(track.forward); if (!inverse) continue;
      const identity = [1, 0, 0, 1, 0, 0];
      const from = track.forward.map((v, i) => identity[i] + (v - identity[i]) * plan.mix) as AffineMatrix;
      const to = multiplyAffine(from, inverse);
      const covered = (m: AffineMatrix) => {
        const inv = inverseAffine(m); if (!inv) return false;
        return track.polygon.every(([x, y]) => { const sx = inv[0] * x + inv[2] * y + inv[4], sy = inv[1] * x + inv[3] * y + inv[5]; return sx >= -1e-7 && sy >= -1e-7 && sx <= width + 1e-7 && sy <= height + 1e-7; });
      };
      // One named observation must cover the entire patch. The other is
      // explicitly clipped, revealing known pixels instead of extending it.
      const fallback = track.appearance ? track.viewportFallback : undefined;
      if (fallback === 'from' ? !covered(from) : fallback === 'to' ? !covered(to) : !covered(from) || !covered(to)) continue;
      status.activeTrackIds.push(track.id);
      // Keep exact observation SVGs unchanged. Status still describes support.
      if (plan.mix === 0) continue;
      let id = foregroundIds.get(track); if (!id) { id = `fg${++nextProjectId}`; foregroundIds.set(track, id); }
      result.patches.push({ id, track, from, to, ...(track.appearance ? { appearanceWeight: appearanceWeight(plan.mix, track.appearance) } : {}) }); result.key += `-${id}`;
      result.fromUses += `<use href="#${id}-${track.appearance ? 'common' : 'from'}" data-foreground-track="${escape(track.id)}" pointer-events="none"/>`;
      result.toUses += `<use href="#${id}-${track.appearance ? 'common' : 'to'}" data-foreground-track="${escape(track.id)}" pointer-events="none"/>`;
    }
    status.supported = status.activeTrackIds.length > 0; return result;
  }
  function foregroundAssets(frame: ForegroundFrame, from: TemporalEndpoint, to: TemporalEndpoint | undefined, width: number, height: number) {
    let sharedDefinitions = ''; const sharedMatrixTransforms: NonNullable<TemporalFramePair['sharedMatrixTransforms']> = [];
    const sharedOpacityTransforms: NonNullable<TemporalFramePair['sharedOpacityTransforms']> = [];
    if (!to) return { sharedDefinitions, sharedMatrixTransforms, sharedOpacityTransforms, foregroundStatus: frame.foregroundStatus };
    for (const patch of frame.patches) {
      const { id, track } = patch, points = track.polygon.map(p => p.map(num).join(',')).join(' ');
      sharedDefinitions += `<clipPath id="${id}-clip"><polygon points="${points}"/></clipPath>`;
      if (track.featherPx) sharedDefinitions += `<filter id="${id}-soft" x="0" y="0" width="${width}" height="${height}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${num(track.featherPx / 3)}"/></filter><mask id="${id}-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" style="mask-type:luminance"><polygon points="${points}" fill="white" stroke="black" stroke-width="${track.featherPx}" filter="url(#${id}-soft)"/></mask>`;
      const contents: string[] = [];
      for (const [side, endpoint] of [['from', from], ['to', to]] as const) {
        const source = endpoint.key.replace(/[^a-zA-Z0-9_-]/g, '_') + '-foreground-source', transform = `${id}-${side}-transform`;
        let observed = `<rect width="${width}" height="${height}" fill="${escape(endpoint.foregroundBackground ?? 'none')}"/><use href="#${source}" pointer-events="none"/>`;
        if (track.viewportFallback) {
          // Fade only inside the second observed viewport; an abrupt validity
          // edge would otherwise draw a straight seam through an exiting limb.
          if (side !== track.viewportFallback) {
            const inset = Math.min(Math.max(1, track.featherPx), width / 8, height / 8);
            sharedDefinitions += `<filter id="${transform}-valid-soft" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><feGaussianBlur stdDeviation="${num(inset / 3)}"/></filter><mask id="${transform}-valid" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" style="mask-type:luminance"><rect x="${num(inset / 2)}" y="${num(inset / 2)}" width="${num(width - inset)}" height="${num(height - inset)}" fill="white" filter="url(#${transform}-valid-soft)"/><rect id="${transform}-valid-endpoint" width="${width}" height="${height}" fill="white" opacity="1"/></mask>`;
            // Recover the complete observed edge continuously as its endpoint
            // weight reaches one; the outer viewport clip remains in force.
            sharedOpacityTransforms.push({ id: `${transform}-valid-endpoint`, opacity: side === 'to' ? patch.appearanceWeight! : 1 - patch.appearanceWeight! });
            observed = `<g mask="url(#${transform}-valid)">${observed}</g>`;
          }
          observed = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden">${observed}</svg>`;
        }
        const content = `<g id="${transform}" transform="matrix(1 0 0 1 0 0)">${observed}</g>`;
        if (patch.appearanceWeight !== undefined) contents.push(content);
        else sharedDefinitions += `<g id="${id}-${side}" clip-path="url(#${id}-clip)" pointer-events="none"><g${track.featherPx ? ` mask="url(#${id}-mask)"` : ''}>${content}</g></g>`;
        sharedMatrixTransforms.push({ id: transform, matrix: patch[side] });
      }
      if (patch.appearanceWeight !== undefined) {
        // Both opaque endpoint layers receive the same completed patch. The
        // outer timeline dissolve therefore cannot re-weight local appearance.
        const reversed = track.viewportFallback === 'to';
        sharedDefinitions += `<g id="${id}-common" clip-path="url(#${id}-clip)" pointer-events="none"><g${track.featherPx ? ` mask="url(#${id}-mask)"` : ''}>${contents[reversed ? 1 : 0]}<g id="${id}-appearance" opacity="1">${contents[reversed ? 0 : 1]}</g></g></g>`;
        sharedOpacityTransforms.push({ id: `${id}-appearance`, opacity: reversed ? 1 - patch.appearanceWeight : patch.appearanceWeight });
      }
    }
    return { sharedDefinitions, sharedMatrixTransforms, sharedOpacityTransforms, foregroundStatus: frame.foregroundStatus };
  }
  function definitions(pair: TemporalFramePair) {
    let markup = pair.sharedDefinitions ?? '';
    for (const value of pair.sharedTransforms ?? []) {
      markup = markup.replace(`id="${value.id}-opacity" opacity="1"`, `id="${value.id}-opacity" opacity="${value.opacity}"`);
      markup = markup.replace(`id="${value.id}" transform="matrix(1 0 0 1 0 0)"`, `id="${value.id}" transform="matrix(${value.matrix.join(' ')})"`);
      for (const [i, c] of ['R', 'G', 'B'].entries()) markup = markup.replace(`id="${value.colorId}-${c}" type="linear" slope="1" intercept="0"`, `id="${value.colorId}-${c}" type="linear" slope="${value.gain[i]}" intercept="${value.bias[i]}"`);
    }
    for (const value of pair.sharedMatrixTransforms ?? []) markup = markup.replace(`id="${value.id}" transform="matrix(1 0 0 1 0 0)"`, `id="${value.id}" transform="matrix(${value.matrix.join(' ')})"`);
    for (const value of pair.sharedOpacityTransforms ?? []) markup = markup.replace(`id="${value.id}" opacity="1"`, `id="${value.id}" opacity="${value.opacity}"`);
    return markup ? `<defs>${markup}</defs>` : '';
  }
  function framePlan(temporal: MotionTemporal | undefined, duration: number, requested: number): TemporalPlan {
    if (!Number.isFinite(requested)) throw new Error('time: 유한한 초 단위 숫자가 필요합니다.');
    const time = clamp(requested, 0, duration);
    if (!temporal || temporal.mode === 'off') return { time, from: time, mix: 0, cut: false };
    const fps = temporal.sampleFps, nearest = Math.round(time * fps) / fps;
    const sampleTime = !before(time, nearest) && !before(nearest, time) ? nearest : time;
    let from = Math.floor(sampleTime * fps) / fps;
    // Multiplication by a noninteger FPS can round down by one ULP.
    if (!before(sampleTime, nearest) && !before(nearest, sampleTime)) from = nearest;
    const frames = duration * fps, roundedFrames = Math.round(frames);
    const last = Math.max(0, ((before(roundedFrames / fps, duration) ? Math.ceil(frames) : roundedFrames) - 1) / fps);
    from = Math.min(from, last);
    let to = Math.min((Math.round(from * fps) + 1) / fps, duration), cut = false;
    for (const boundary of temporal.cuts) {
      if (!before(boundary, duration)) break;
      if (!before(time, boundary)) from = Math.max(from, boundary);
      else if (!before(to, boundary)) { to = boundary; cut = true; break; }
    }
    // Never dissolve toward a different shot or toward the blank duration edge.
    if (temporal.mode === 'frames' || cut || !before(to, duration) || !before(from, to)) return { time, from, mix: 0, cut };
    const mix = !before(from, time) ? 0 : clamp((time - from) / (to - from), 0, 1);
    return { time, from, to, mix, cut: false };
  }
  function createEndpointCache(): EndpointCache { return { options: '', revision: 0, frames: new Map() }; }
  function endpoint(project: MotionProject, time: number, options: RenderOptions, cache: EndpointCache, bg?: BackgroundFrame, fg?: ForegroundFrame, side: 'from' | 'to' = 'from'): TemporalEndpoint {
    const settings = JSON.stringify([options.selectedId ?? '', options.onionTimes ?? [], !!options.showOcclusion]);
    if (cache.options !== settings) { cache.options = settings; cache.revision++; cache.frames.clear(); }
    let identity = projectIds.get(project);
    if (identity === undefined) { identity = ++nextProjectId; projectIds.set(project, identity); }
    const key = `ep${identity}r${cache.revision}t${time}${bg?.key ?? ''}${fg?.key ?? ''}`;
    const prior = cache.frames.get(key);
    if (prior) { cache.frames.delete(key); cache.frames.set(key, prior); return prior; }
    const result = { key, time, ...(fg?.key ? { foregroundBackground: background(project, time) } : {}), svg: renderSample(project, time, options, key.replace(/[^a-zA-Z0-9_-]/g, '_'), false, bg?.uses, side === 'from' ? fg?.fromUses : fg?.toUses) };
    cache.frames.set(key, result);
    while (cache.frames.size > 2) cache.frames.delete(cache.frames.keys().next().value!);
    return result;
  }
  function framePair(project: MotionProject, time: number, options: RenderOptions = {}): TemporalFramePair {
    let cache = pairCaches.get(project);
    if (!cache) { cache = createEndpointCache(); pairCaches.set(project, cache); }
    const plan = framePlan(project.temporal, project.duration, time);
    const redraw = project.temporal?.mode === 'frames';
    const bg = backgroundFrame(redraw ? undefined : project.backgroundMotion, plan.time, project.width, project.height);
    const fg = foregroundFrame(redraw ? undefined : project.foregroundMotion, plan, project.width, project.height);
    const from = endpoint(project, plan.from, options, cache, bg, fg, 'from');
    const to = plan.to !== undefined ? endpoint(project, plan.to, options, cache, bg, fg, 'to') : undefined;
    const aligned = foregroundAssets(fg, from, to, project.width, project.height);
    return { time: plan.time, from, ...(to ? { to } : {}), mix: plan.mix, cut: plan.cut, ...fontAssets(project), ...aligned,
      sharedDefinitions: bg.sharedDefinitions + aligned.sharedDefinitions, sharedTransforms: bg.sharedTransforms, backgroundStatus: bg.backgroundStatus };
  }
  function compose(pair: TemporalFramePair, width: number, height: number, name: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escape(name)}" style="display:block;width:100%;height:100%;overflow:hidden">${pair.fontMetadata}${pair.fontCss ? `<style>${pair.fontCss}</style>` : ''}${definitions(pair)}<g data-temporal-layer="from">${pair.from.svg}</g>${pair.to && pair.mix > 0 ? `<g data-temporal-layer="to" opacity="${pair.mix}" pointer-events="none" aria-hidden="true">${pair.to.svg}</g>` : ''}</svg>`;
  }
  function render(project: MotionProject, time: number, options: RenderOptions = {}): string {
    if (project.temporal?.mode === 'frames') return renderSample(project, framePlan(project.temporal, project.duration, time).from, options);
    if (project.backgroundMotion?.mode === 'on') return compose(framePair(project, time, options), project.width, project.height, project.name);
    if (project.temporal?.mode !== 'blend') return renderSample(project, time, options);
    const plan = framePlan(project.temporal, project.duration, time);
    // Original observations retain their exact serialized SVG, fonts and IDs.
    if (!plan.mix) return renderSample(project, plan.from, options);
    return compose(framePair(project, time, options), project.width, project.height, project.name);
  }
  /** Persistent DOM adapter shared by both standalone exporters. Geometry parses
   * once per new endpoint; subframes update only the upper opacity. */
  function createStageRenderer(stage: HTMLElement) {
    const style = document.createElement('style'), metadata = document.createElement('div');
    metadata.hidden = true;
    const layers = [document.createElement('div'), document.createElement('div')];
    stage.style.position = 'relative';
    for (const layer of layers) { layer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'; }
    stage.replaceChildren(style, metadata, ...layers);
    let defs: SVGDefsElement | undefined;
    const keys: Array<string | undefined> = [];
    let css = '', license = '', priorDefinitions = '';
    const sharedElements = new Map<string, Element>();
    return (pair: TemporalFramePair) => {
      if (pair.fontCss !== css) { style.textContent = pair.fontCss; css = pair.fontCss; }
      if (pair.fontMetadata !== license) { metadata.innerHTML = pair.fontMetadata; license = pair.fontMetadata; }
      if ((pair.sharedDefinitions ?? '') !== priorDefinitions) {
        if (!defs) {
          const shared = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          shared.setAttribute('width', '0'); shared.setAttribute('height', '0'); shared.setAttribute('aria-hidden', 'true'); shared.style.cssText = 'position:absolute;pointer-events:none'; shared.append(defs); stage.insertBefore(shared, layers[0]);
        }
        priorDefinitions = pair.sharedDefinitions ?? ''; defs.innerHTML = priorDefinitions; sharedElements.clear();
        for (const el of defs.querySelectorAll('[id]')) sharedElements.set(el.id, el);
      }
      for (const value of pair.sharedTransforms ?? []) {
        sharedElements.get(value.id)?.setAttribute('transform', `matrix(${value.matrix.join(' ')})`);
        sharedElements.get(`${value.id}-opacity`)?.setAttribute('opacity', String(value.opacity));
        for (const [i, c] of ['R', 'G', 'B'].entries()) { const el = sharedElements.get(`${value.colorId}-${c}`); el?.setAttribute('slope', String(value.gain[i])); el?.setAttribute('intercept', String(value.bias[i])); }
      }
      for (const value of pair.sharedMatrixTransforms ?? []) sharedElements.get(value.id)?.setAttribute('transform', `matrix(${value.matrix.join(' ')})`);
      for (const value of pair.sharedOpacityTransforms ?? []) sharedElements.get(value.id)?.setAttribute('opacity', String(value.opacity));
      let lowerIndex = keys.indexOf(pair.from.key);
      if (lowerIndex < 0) lowerIndex = pair.to && keys[0] === pair.to.key ? 1 : 0;
      const upperIndex = 1 - lowerIndex, lower = layers[lowerIndex], upper = layers[upperIndex];
      if (keys[lowerIndex] !== pair.from.key) { lower.innerHTML = pair.from.svg; keys[lowerIndex] = pair.from.key; }
      lower.style.zIndex = '0'; lower.style.opacity = '1'; lower.style.visibility = 'visible';
      lower.style.pointerEvents = 'auto'; lower.removeAttribute('aria-hidden');
      if (pair.to) {
        if (keys[upperIndex] !== pair.to.key) { upper.innerHTML = pair.to.svg; keys[upperIndex] = pair.to.key; }
        upper.style.zIndex = '1'; upper.style.opacity = String(pair.mix); upper.style.visibility = 'visible';
        upper.style.pointerEvents = 'none'; upper.setAttribute('aria-hidden', 'true');
      } else { upper.replaceChildren(); keys[upperIndex] = undefined; upper.style.zIndex = '1'; upper.style.visibility = 'hidden'; }
      stage.dataset.renderTime = String(pair.time); stage.dataset.blendMix = String(pair.mix);
      stage.dataset.frameFrom = String(pair.from.time); stage.dataset.frameTo = pair.to ? String(pair.to.time) : '';
    };
  }
  return { evaluate, render, renderSample, framePlan, framePair, fontAssets, endpoint, createEndpointCache, compose, createStageRenderer, backgroundFrame, foregroundFrame, foregroundAssets, appearanceWeight };

}

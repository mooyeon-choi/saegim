/** Experimental, dependency-free vector motion model. This is deliberately
 * separate from the product renderer and never inserts source video pixels.
 * The closed factory can be embedded in a single offline HTML file. */
export function createParametricVectorRuntime() {
  const EPS = 8 * Number.EPSILON;
  const pchipCache = new WeakMap();
  const before = (a, b) => a < b && b - a > EPS * Math.max(1, Math.abs(a), Math.abs(b));
  const finite = (value, name, min = -1e8, max = 1e8) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}: invalid finite number`);
    return value;
  };
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fixed = value => Number(value.toFixed(9));
  const color = (value, name) => {
    if (typeof value !== 'string' || !/^(?:#[a-f\d]{3,4}|#[a-f\d]{6}|#[a-f\d]{8}|none|transparent|black|white)$/i.test(value)) throw new Error(`${name}: only literal HEX/transparent colors are allowed`);
    return value;
  };
  const array = (value, name, max) => {
    if (!Array.isArray(value) || value.length > max) throw new Error(`${name}: array exceeds ${max}`);
    return value;
  };
  const point = (value, name) => {
    if (!Array.isArray(value) || value.length !== 2) throw new Error(`${name}: [x,y] required`);
    return [finite(value[0], name + '.x'), finite(value[1], name + '.y')];
  };
  const det = h => h[0] * (h[4] * h[8] - h[5] * h[7]) - h[1] * (h[3] * h[8] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);
  function matrix(value, name) {
    let h;
    if (value.homography !== undefined) {
      h = array(value.homography, name + '.homography', 9);
      if (h.length !== 9) throw new Error(`${name}: homography is row-major 3×3`);
    } else {
      const m = array(value.matrix, name + '.matrix', 6);
      if (m.length !== 6) throw new Error(`${name}: SVG matrix [a,b,c,d,e,f] required`);
      h = [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
    }
    h = h.map((v, i) => finite(v, `${name}[${i}]`));
    if (Math.abs(h[8]) < 1e-12) throw new Error(`${name}: h22 cannot normalize to 1`);
    return h.map(v => v / h[8]);
  }
  function projectPoint(h, p) {
    const w = h[6] * p[0] + h[7] * p[1] + h[8];
    if (!Number.isFinite(w) || w < 1e-6) throw new Error('projective-horizon');
    const result = [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w];
    if (result.some(v => !Number.isFinite(v) || Math.abs(v) > 1e8)) throw new Error('unbounded-projection');
    return result;
  }
  function decompose(h) {
    if (Math.abs(h[6]) > 1e-12 || Math.abs(h[7]) > 1e-12) throw new Error('non-affine-matrix');
    const sx = Math.hypot(h[0], h[3]), determinant = h[0] * h[4] - h[1] * h[3];
    if (sx < 1e-8 || determinant <= 1e-10) throw new Error('degenerate-or-reflected-affine');
    const sy = determinant / sx;
    return { tx: h[2], ty: h[5], angle: Math.atan2(h[3], h[0]), logX: Math.log(sx), logY: Math.log(sy), shear: (h[0] * h[1] + h[3] * h[4]) / (sx * sy) };
  }
  function composeAffine(p) {
    const sx = Math.exp(p.logX), sy = Math.exp(p.logY), c = Math.cos(p.angle), s = Math.sin(p.angle);
    return [c * sx, (c * p.shear - s) * sy, p.tx, s * sx, (s * p.shear + c) * sy, p.ty, 0, 0, 1];
  }
  function interpolate(a, b, t, mode, affineInterpolation) {
    if (t <= 0) return a.slice(); if (t >= 1) return b.slice();
    if (mode === 'projective' || affineInterpolation === 'matrix') return a.map((v, i) => v + (b[i] - v) * t);
    const x = decompose(a), y = decompose(b);
    let angle = y.angle - x.angle;
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    const p = Object.fromEntries(Object.keys(x).map(key => [key, x[key] + (y[key] - x[key]) * t]));
    p.angle = x.angle + angle * t;
    return composeAffine(p);
  }
  /** Accept only an SVG emitted by the trusted product renderer. This guard is
   * intentionally not a general-purpose SVG sanitizer or an arbitrary upload API. */
  function trustedSvg(value) {
    if (typeof value !== 'string' || value.length > 16 * 1024 * 1024 || !/^<svg\s/i.test(value) || !/<\/svg>\s*$/i.test(value)) throw new Error('trustedAnchorSvg: bounded standalone SVG required');
    if (/<\s*(?:script|image|video|audio|canvas|foreignObject|iframe|object|embed|a|animate\w*|set)\b/i.test(value) || /\s+on[a-z]+\s*=/i.test(value)) throw new Error('trustedAnchorSvg: active or raster elements forbidden');
    for (const m of value.matchAll(/(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) if (!/^#[\w-]+$/.test(m[2])) throw new Error('trustedAnchorSvg: external references forbidden');
    for (const m of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) if (!/^#[\w-]+$/.test(m[2]) && !/^data:font\/(?:ttf|otf|woff2);base64,[a-z\d+/=]+$/i.test(m[2])) throw new Error('trustedAnchorSvg: external CSS URL forbidden');
    if (/@import\b|expression\s*\(|<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('trustedAnchorSvg: external or executable CSS forbidden');
    return value;
  }
  function validateTriangle(value) {
    const width = finite(value.width, 'width', 1, 16384), height = finite(value.height, 'height', 1, 16384);
    const rgb = (v, name) => { const a = array(v, name, 3); if (a.length !== 3) throw new Error(name + ': RGB triplet required'); return a.map(c => finite(c, name, 0, 255)); };
    const anchors = array(value.anchors, 'anchors', 2000).map((key, i) => ({
      time: finite(key.time, `anchors[${i}].time`, 0, 3600),
      lines: Object.fromEntries(['left', 'right'].map(side => [side, { slope: finite(key.lines?.[side]?.slope, side + '.slope', -1000, 1000), intercept: finite(key.lines?.[side]?.intercept, side + '.intercept') }])),
      planes: Object.fromEntries(['left', 'center', 'right'].map(side => [side, { topRGB: rgb(key.planes?.[side]?.topRGB, side + '.topRGB'), bottomRGB: rgb(key.planes?.[side]?.bottomRGB, side + '.bottomRGB') }])),
    }));
    if (anchors.length < 2 || anchors.some((key, i) => i && !before(anchors[i - 1].time, key.time))) throw new Error('anchors: increasing unique times required');
    const anchorTime = finite(value.anchorTime ?? anchors[0].time, 'anchorTime', anchors[0].time, anchors.at(-1).time);
    const cuts = array(value.cuts ?? [], 'cuts', 1000).map(v => finite(v, 'cut', 0, 3600));
    if (cuts.some((v, i) => i && v <= cuts[i - 1])) throw new Error('cuts: sorted unique times required');
    const validRanges = array(value.validRanges ?? [{ start: anchors[0].time, end: anchors.at(-1).time }], 'validRanges', 1000).map(r => ({ start: finite(r.start, 'range.start', anchors[0].time, anchors.at(-1).time), end: finite(r.end, 'range.end', r.start, anchors.at(-1).time) }));
    const domain = array((Array.isArray(value.domain) ? value.domain : value.domain?.polygon) ?? [[0, 0], [width, 0], [width, height], [0, height]], 'domain', 256).map(p => point(p, 'domain.point'));
    if (domain.length < 3) throw new Error('domain: polygon required');
    const excludedPolygons = array(value.excludedPolygons ?? value.domain?.excludedPolygons ?? [], 'excludedPolygons', 256).map(ring => { const points = array(ring, 'excludedPolygon', 256).map(p => point(p, 'excludedPolygon.point')); if (points.length < 3) throw new Error('excludedPolygon: polygon required'); return points; });
    const parameterInterpolation = value.parameterInterpolation ?? 'linear';
    if (!['linear', 'pchip'].includes(parameterInterpolation)) throw new Error('parameterInterpolation: linear or pchip required');
    let pchip;
    if (value.pchip !== undefined) {
      if (parameterInterpolation !== 'pchip') throw new Error('pchip coefficients require parameterInterpolation=pchip');
      const breakpoints = array(value.pchip.breakpoints, 'pchip.breakpoints', 2000).map(v => finite(v, 'breakpoint', 0, 3600));
      if (breakpoints.length !== anchors.length || breakpoints.some((v, i) => before(v, anchors[i].time) || before(anchors[i].time, v))) throw new Error('pchip breakpoints must match anchor times');
      const names = ['lines.left.slope', 'lines.left.intercept', 'lines.right.slope', 'lines.right.intercept', ...['left', 'center', 'right'].flatMap(side => ['topRGB', 'bottomRGB'].flatMap(edge => [0, 1, 2].map(i => `planes.${side}.${edge}.${i}`)))];
      const coefficients = names.map(name => {
        const intervals = array(value.pchip.channels?.[name], 'pchip.' + name, 1999);
        if (intervals.length !== anchors.length - 1) throw new Error('pchip coefficient interval count mismatch');
        return intervals.map((values, i) => {
          const row = array(values, 'pchip coefficient row', 4);
          if (row.length !== 4) throw new Error('four descending-power coefficients required');
          const c = row.map(v => finite(v, 'pchip coefficient', -1e15, 1e15));
          const h = breakpoints[i + 1] - breakpoints[i], channel = names.indexOf(name), y0 = channels(anchors[i])[channel], y1 = channels(anchors[i + 1])[channel];
          if (Math.abs(c[3] - y0) > 1e-7 * Math.max(1, Math.abs(y0)) || Math.abs(((c[0] * h + c[1]) * h + c[2]) * h + c[3] - y1) > 1e-7 * Math.max(1, Math.abs(y1))) throw new Error('pchip coefficients must preserve observed anchor endpoints');
          return c;
        });
      });
      pchip = { breakpoints, names, coefficients, channels: Object.fromEntries(names.map((name, i) => [name, coefficients[i]])) };
    }
    return { kind: 'triangle-lines', parameterInterpolation, ...(pchip ? { pchip } : {}), width, height, anchorTime, anchors, cuts, validRanges, domain, excludedPolygons, background: color(value.background ?? '#000000', 'background'), clipToDomain: value.clipToDomain === true };
  }
  function clipHalfPlane(polygon, line, keepLeft) {
    const signed = p => (p[0] - line.slope * p[1] - line.intercept) * (keepLeft ? 1 : -1);
    const output = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], fa = signed(a), fb = signed(b), inA = fa <= 1e-9, inB = fb <= 1e-9;
      if (inA) output.push(a);
      if (inA !== inB) { const u = fa / (fa - fb); output.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); }
    }
    return output;
  }
  function channels(key) {
    return [key.lines.left.slope, key.lines.left.intercept, key.lines.right.slope, key.lines.right.intercept,
      ...['left', 'center', 'right'].flatMap(side => [...key.planes[side].topRGB, ...key.planes[side].bottomRGB])];
  }
  function fromChannels(v) {
    return { lines: { left: { slope: v[0], intercept: v[1] }, right: { slope: v[2], intercept: v[3] } },
      planes: Object.fromEntries(['left', 'center', 'right'].map((side, i) => [side, { topRGB: v.slice(4 + 6 * i, 7 + 6 * i), bottomRGB: v.slice(7 + 6 * i, 10 + 6 * i) }])) };
  }
  function pchipSlopes(model) {
    const cached = pchipCache.get(model); if (cached) return cached;
    const x = model.anchors.map(a => a.time), y = model.anchors.map(channels), count = x.length;
    const slopes = y.map(() => Array(22).fill(0));
    const spans = x.slice(1).map((v, i) => v - x[i]);
    const edge = (h0, h1, m0, m1) => {
      const estimate = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
      if (Math.sign(estimate) !== Math.sign(m0)) return 0;
      return Math.sign(m0) !== Math.sign(m1) && Math.abs(estimate) > 3 * Math.abs(m0) ? 3 * m0 : estimate;
    };
    // Fritsch–Butland weighted harmonic derivatives, including the endpoint
    // limiter, as documented by scipy.interpolate.PchipInterpolator. This is
    // a numerical rule, not an extra fitting step or a per-frame observation.
    for (let channel = 0; channel < 22; channel++) {
      const secants = spans.map((h, i) => (y[i + 1][channel] - y[i][channel]) / h);
      if (count === 2) { slopes[0][channel] = slopes[1][channel] = secants[0]; continue; }
      slopes[0][channel] = edge(spans[0], spans[1], secants[0], secants[1]);
      slopes[count - 1][channel] = edge(spans.at(-1), spans.at(-2), secants.at(-1), secants.at(-2));
      for (let i = 1; i < count - 1; i++) {
        const a = secants[i - 1], b = secants[i];
        if (!a || !b || Math.sign(a) !== Math.sign(b)) continue;
        const w1 = 2 * spans[i] + spans[i - 1], w2 = spans[i] + 2 * spans[i - 1];
        slopes[i][channel] = (w1 + w2) / (w1 / a + w2 / b);
      }
    }
    const curve = { values: y, slopes, spans }; pchipCache.set(model, curve); return curve;
  }
  function triangleParameters(left, right, progress, model) {
    if (left === right || progress === 0) return fromChannels(channels(left));
    if (progress === 1) return fromChannels(channels(right));
    const a = channels(left), b = channels(right);
    if (model.parameterInterpolation !== 'pchip') return fromChannels(a.map((v, i) => v + (b[i] - v) * progress));
    const index = model.anchors.indexOf(left);
    if (model.pchip) {
      const dt = (right.time - left.time) * progress;
      return fromChannels(model.pchip.coefficients.map(intervals => { const c = intervals[index]; return ((c[0] * dt + c[1]) * dt + c[2]) * dt + c[3]; }));
    }
    const curve = pchipSlopes(model), h = curve.spans[index], u = progress, u2 = u * u, u3 = u2 * u;
    return fromChannels(a.map((v, i) => (2 * u3 - 3 * u2 + 1) * v + (u3 - 2 * u2 + u) * h * curve.slopes[index][i] + (-2 * u3 + 3 * u2) * b[i] + (u3 - u2) * h * curve.slopes[index + 1][i]));
  }
  function validateModel(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model: object required');
    if (value.kind === 'triangle-lines') return validateTriangle(value);
    const width = finite(value.width, 'width', 1, 16384), height = finite(value.height, 'height', 1, 16384);
    const mode = value.mode ?? 'affine'; if (mode !== 'affine' && mode !== 'projective') throw new Error('mode: affine or projective required');
    const anchors = array(value.anchors, 'anchors', 2000).map((key, i) => ({ time: finite(key.time, `anchors[${i}].time`, 0, 3600), homography: matrix(key, `anchors[${i}]`) }));
    if (anchors.length < 2 || anchors.some((key, i) => i && !before(anchors[i - 1].time, key.time))) throw new Error('anchors: at least two increasing unique times required');
    const anchorTime = finite(value.anchorTime, 'anchorTime', anchors[0].time, anchors.at(-1).time);
    const anchor = anchors.find(key => !before(key.time, anchorTime) && !before(anchorTime, key.time));
    if (!anchor || anchor.homography.some((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) > 1e-6)) throw new Error('anchorTime must be an identity-transform key');
    const cuts = array(value.cuts ?? [], 'cuts', 1000).map((v, i) => finite(v, `cuts[${i}]`, 0, 3600));
    if (cuts.some((v, i) => i && v <= cuts[i - 1])) throw new Error('cuts: sorted unique times required');
    const domain = array((Array.isArray(value.domain) ? value.domain : value.domain?.polygon) ?? [[0, 0], [width, 0], [width, height], [0, height]], 'domain', 256).map((p, i) => point(p, `domain[${i}]`));
    if (domain.length < 3) throw new Error('domain: polygon required');
    const excludedPolygons = array(value.excludedPolygons ?? value.domain?.excludedPolygons ?? [], 'excludedPolygons', 256).map(ring => { const points = array(ring, 'excludedPolygon', 256).map(p => point(p, 'excludedPolygon.point')); if (points.length < 3) throw new Error('excludedPolygon: polygon required'); return points; });
    let points = 0;
    const shapes = array(value.shapes ?? [], 'shapes', 10000).map((shape, i) => {
      const vertices = array(shape.points, `shapes[${i}].points`, 20000).map((p, j) => point(p, `shapes[${i}].points[${j}]`));
      points += vertices.length;
      if (vertices.length < 2 || points > 200000) throw new Error('shapes: 2–200,000 total points required');
      const id = shape.id ?? `shape-${i}`;
      if (typeof id !== 'string' || id.length > 200) throw new Error('shape.id: bounded string required');
      return { id, points: vertices, closed: shape.closed !== false, fill: color(shape.fill ?? '#ffffff', 'shape.fill'), stroke: color(shape.stroke ?? 'none', 'shape.stroke'), strokeWidth: finite(shape.strokeWidth ?? 0, 'strokeWidth', 0, 1000) };
    });
    if (new Set(shapes.map(s => s.id)).size !== shapes.length) throw new Error('shape ids must be unique');
    const svg = value.trustedAnchorSvg === undefined ? undefined : trustedSvg(value.trustedAnchorSvg);
    if (!shapes.length && !svg) throw new Error('shapes or trustedAnchorSvg is required');
    const validRanges = array(value.validRanges ?? [{ start: anchors[0].time, end: anchors.at(-1).time }], 'validRanges', 1000).map((range, i) => {
      const start = finite(range.start, `validRanges[${i}].start`, anchors[0].time, anchors.at(-1).time), end = finite(range.end, `validRanges[${i}].end`, start, anchors.at(-1).time);
      return { start, end };
    });
    const affineInterpolation = value.affineInterpolation ?? 'decomposed';
    if (!['decomposed', 'matrix'].includes(affineInterpolation)) throw new Error('affineInterpolation: decomposed or matrix required');
    return { width, height, anchorTime, background: color(value.background ?? 'transparent', 'background'), mode, anchors, shapes, domain, excludedPolygons, cuts, validRanges, affineInterpolation,
      maxScale: finite(value.maxScale ?? 8, 'maxScale', 1, 100), maxTravel: finite(value.maxTravel ?? Math.hypot(width, height) * 4, 'maxTravel', 1, 1e8), clipToDomain: value.clipToDomain === true,
      ...(svg ? { trustedAnchorSvg: svg } : {}) };
  }
  function safeMatrix(model, h) {
    if (det(h) <= 1e-10) throw new Error('degenerate-or-reflected-transform');
    const mapped = model.domain.map(p => projectPoint(h, p));
    for (let i = 0; i < mapped.length; i++) {
      if (Math.hypot(mapped[i][0] - model.domain[i][0], mapped[i][1] - model.domain[i][1]) > model.maxTravel) throw new Error('excessive-travel');
      const next = (i + 1) % mapped.length;
      const a = Math.hypot(model.domain[i][0] - model.domain[next][0], model.domain[i][1] - model.domain[next][1]);
      const b = Math.hypot(mapped[i][0] - mapped[next][0], mapped[i][1] - mapped[next][1]);
      if (a > 1e-8 && (b / a > model.maxScale || b / a < 1 / model.maxScale)) throw new Error('excessive-scale');
    }
    return mapped;
  }
  function evaluate(model, time, options = {}) {
    finite(time, 'time', -3600, 7200);
    const fallback = reason => ({ status: 'fallback', reason, time, matrix: null, progress: null, sourceProgress: null, svg: null });
    if (!model.validRanges.some(r => !before(time, r.start) && !before(r.end, time))) return fallback('outside-validated-range');
    if (model.cuts.some(c => before(model.anchorTime, c) !== before(time, c))) return fallback('different-shot-from-anchor');
    if (model.mode === 'projective' && model.trustedAnchorSvg) return fallback('projective-requires-explicit-point-shapes');
    const easing = options.easing ?? 'linear';
    if (easing !== 'linear' && easing !== 'smoothstep') throw new Error('easing: linear or smoothstep required');
    let left = model.anchors[0], right = left;
    const exact = model.anchors.find(k => !before(k.time, time) && !before(time, k.time));
    if (exact) left = right = exact;
    else {
      const index = model.anchors.findIndex(k => before(time, k.time));
      if (index <= 0) return fallback('outside-anchor-interval');
      left = model.anchors[index - 1]; right = model.anchors[index];
      if (model.cuts.some(c => before(left.time, c) && !before(right.time, c))) return fallback('anchor-interval-crosses-cut');
    }
    const sourceProgress = left === right ? 0 : (time - left.time) / (right.time - left.time);
    const progress = easing === 'smoothstep' ? sourceProgress * sourceProgress * (3 - 2 * sourceProgress) : sourceProgress;
    try {
      if (model.kind === 'triangle-lines') {
        const parameters = triangleParameters(left, right, progress, model), lines = parameters.lines;
        if (channels(parameters).some((v, i) => !Number.isFinite(v) || (i < 4 ? Math.abs(v) > 1e8 : v < -1e-7 || v > 255 + 1e-7))) return fallback('invalid-interpolated-parameter');
        if ([0, model.height].some(y => lines.left.slope * y + lines.left.intercept > lines.right.slope * y + lines.right.intercept + 1e-7)) return fallback('crossed-plane-boundaries');
        return { status: 'ok', time, matrix: null, parameters, progress, sourceProgress, leftTime: left.time, rightTime: right.time, svg: null };
      }
      const h = interpolate(left.homography, right.homography, progress, model.mode, model.affineInterpolation);
      if (model.mode === 'affine') decompose(h);
      const corners = safeMatrix(model, h);
      if (model.mode === 'projective') for (const shape of model.shapes) for (const p of shape.points) projectPoint(h, p);
      return { status: 'ok', time, matrix: h, progress, sourceProgress, leftTime: left.time, rightTime: right.time, corners, svg: null };
    } catch (cause) { return fallback(cause instanceof Error ? cause.message : String(cause)); }
  }
  function render(model, time, options = {}) {
    const state = evaluate(model, time, options); if (state.status !== 'ok') return state;
    const h = state.matrix, prefix = options.namespace ?? 'parametric-anchor';
    if (typeof prefix !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(prefix)) throw new Error('namespace: safe SVG identifier required');
    const polygon = points => points.map(p => p.map(fixed).join(',')).join(' ');
    const clip = model.clipToDomain ? `<defs><mask id="${prefix}-roi" maskUnits="userSpaceOnUse" x="0" y="0" width="${model.width}" height="${model.height}" style="mask-type:luminance"><polygon points="${polygon(model.domain)}" fill="white"/>${model.excludedPolygons.map(points => `<polygon points="${polygon(points)}" fill="black"/>`).join('')}</mask></defs>` : '';
    let content;
    if (model.kind === 'triangle-lines') {
      const rect = [[0, 0], [model.width, 0], [model.width, model.height], [0, model.height]], p = state.parameters;
      const polygons = { left: clipHalfPlane(rect, p.lines.left, true), center: clipHalfPlane(clipHalfPlane(rect, p.lines.left, false), p.lines.right, true), right: clipHalfPlane(rect, p.lines.right, false) };
      const rgb = values => `rgb(${values.map(fixed).join(' ')})`;
      const defs = ['left', 'center', 'right'].map(side => `<linearGradient id="${prefix}-${side}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${model.height}"><stop offset="0" stop-color="${rgb(p.planes[side].topRGB)}"/><stop offset="1" stop-color="${rgb(p.planes[side].bottomRGB)}"/></linearGradient>`).join('');
      content = `<defs>${defs}</defs>` + ['left', 'center', 'right'].map(side => `<polygon data-shape-id="${side}" points="${polygon(polygons[side])}" fill="url(#${prefix}-${side})" stroke="url(#${prefix}-${side})" stroke-width="0.2"/>`).join('');
    } else if (model.trustedAnchorSvg) {
      // One original vector frame, with all fills/gradients/text preserved. No
      // observations or pixels are duplicated to manufacture intermediate frames.
      content = model.trustedAnchorSvg.replace(/(\s)id="([^"]+)"/g, (_, space, id) => `${space}id="${prefix}-${id}"`).replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}-${id})`).replace(/href="#([^"]+)"/g, (_, id) => `href="#${prefix}-${id}"`);
    } else {
      content = model.shapes.map(shape => {
        const vertices = model.mode === 'projective' ? shape.points.map(p => projectPoint(h, p)) : shape.points;
        return `<${shape.closed ? 'polygon' : 'polyline'} data-shape-id="${escape(shape.id)}" points="${polygon(vertices)}" fill="${shape.fill}" stroke="${shape.stroke}" stroke-width="${shape.strokeWidth}" stroke-linejoin="round"/>`;
      }).join('');
    }
    if (model.kind === 'triangle-lines') content = `<g data-parametric-transform="triangle-lines">${content}</g>`;
    else if (model.mode === 'affine') content = `<g data-parametric-transform="affine" transform="matrix(${[h[0], h[3], h[1], h[4], h[2], h[5]].map(fixed).join(' ')})">${content}</g>`;
    else content = `<g data-parametric-transform="projective">${content}</g>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="Experimental single-anchor vector motion" style="display:block;width:100%;height:100%;overflow:hidden"><rect width="${model.width}" height="${model.height}" fill="${model.background}"/>${clip}${model.clipToDomain ? `<g mask="url(#${prefix}-roi)">${content}</g>` : content}</svg>`;
    return { ...state, svg };
  }
  function createRenderer(input) {
    const model = validateModel(input);
    const freeze = value => { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return; for (const child of Object.values(value)) freeze(child); Object.freeze(value); };
    freeze(model);
    const renderer = (time, options) => render(model, time, options);
    renderer.evaluate = (time, options) => evaluate(model, time, options);
    renderer.model = model;
    return renderer;
  }
  return { validateModel, createRenderer, evaluate, render, projectPoint, interpolate };
}
export const { validateModel, createRenderer, evaluate, render, projectPoint, interpolate } = createParametricVectorRuntime();

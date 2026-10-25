import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { gzipSync } from 'fflate';
import { createDemoProject } from '../../src/demo';
import type { MotionComposition, MotionProject, MotionSegment } from '../../src/types';
import { createCompositionPlayer, decodeSegment, encodeSegment, exportHtml, exportProjectJson, getSegmentAt, parseDocument, renderSvg, replaceCompositionSegment, validateComposition } from '../../src/engine';
import { createCompositionRuntime } from '../../src/engine/composition';
import { createMotionRuntime } from '../../src/engine/runtime';
import { validateProject } from '../../src/engine/validate';

function project(name = 'part'): MotionProject { const p = createDemoProject(); p.name = name; return p; }
async function book(count = 3): Promise<MotionComposition> {
  const p = project();
  const segments = await Promise.all(Array.from({ length: count }, (_, index) => encodeSegment({ id: `part-${index}`, name: `장면 ${index + 1}`, start: index * 8, end: (index + 1) * 8 }, { ...p, name: `part-${index}`, background: ['#123456', '#654321', '#111111'][index % 3] })));
  return { schemaVersion: 2, id: 'book', name: '전체 영상', width: p.width, height: p.height, fps: p.fps, duration: count * 8, background: '#123456', segments };
}
function compressed(value: unknown, metadata: MotionSegment): MotionSegment {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { ...metadata, data: Buffer.from(gzipSync(bytes)).toString('base64'), uncompressedBytes: bytes.length };
}
async function loadPlayer(html: string) {
  const json = html.match(/<script type="application\/json" id="motion-data">([\s\S]*?)<\/script>/)![1];
  const source = html.match(/<script>\n([\s\S]*?)<\/script>/)![1];
  const elements: Record<string, any> = {};
  for (const id of ['motion-data', 'stage', 'seek', 'time', 'play', 'previous', 'next', 'loop', 'error']) elements[id] = { textContent: id === 'motion-data' ? json : '', innerHTML: '', value: '', checked: true, addEventListener() {}, setAttribute() {} };
  const context = vm.createContext({ window: {}, Blob, CompressionStream, DecompressionStream, TextDecoder, TextEncoder, atob, btoa, document: { fonts: { load: async () => [] }, getElementById: (id: string) => elements[id], addEventListener() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  vm.runInContext(source, context, { timeout: 2000 });
  await context.window.motionPlayer.ready;
  return { player: context.window.motionPlayer as { seek(t: number): Promise<number>; currentTime: number; cachedSegmentIds: string[] }, elements };
}

describe('compressed composition', () => {
  it('roundtrips local projects while keeping source references only at the book level', async () => {
    const doc = await book(1), p = project();
    p.source = { name: 'original.mp4', url: '/api/media/clip.mp4', width: p.width, height: p.height, duration: 8, fps: p.fps };
    doc.source = p.source;
    doc.segments[0] = await encodeSegment(doc.segments[0], p);
    const decoded = await decodeSegment(doc.segments[0]);
    expect(decoded.source).toBeUndefined();
    expect(decoded.nodes).toEqual(validateProject(p).nodes);
    expect(parseDocument(exportProjectJson(doc))).toEqual(doc);
    expect(parseDocument(exportProjectJson(p)).schemaVersion).toBe(1);
  });
  it('requires contiguous unique bounded chunks and exact declared metadata', async () => {
    const doc = await book();
    expect(() => validateComposition({ ...doc, duration: 61 })).toThrow();
    expect(() => validateComposition({ ...doc, segments: [] })).toThrow();
    expect(() => validateComposition({ ...doc, segments: [...doc.segments, doc.segments[0]] })).toThrow();
    expect(() => validateComposition({ ...doc, segments: doc.segments.map((s, i) => i === 1 ? { ...s, start: 8.1 } : s) })).toThrow(/연속/);
    expect(() => validateComposition({ ...doc, source: { url: 'https://evil.test/source.mp4' } })).toThrow();
    expect(() => validateComposition({ ...doc, segments: doc.segments.map(s => ({ ...s, nodeCount: 8000 })) })).not.toThrow();
    expect(() => validateComposition({ ...doc, segments: doc.segments.map(s => ({ ...s, nodeCount: 8001 })) })).toThrow(/허용 범위/);
    await expect(decodeSegment({ ...doc.segments[0], nodeCount: 0 })).rejects.toThrow(/요소 수/);
    await expect(decodeSegment({ ...doc.segments[0], end: 9 })).rejects.toThrow(/길이/);
    await expect(decodeSegment({ ...doc.segments[0], uncompressedBytes: doc.segments[0].uncompressedBytes - 1 })).rejects.toThrow(/압축 해제/);
  });
  it('rejects corrupt gzip, UTF8, unexpected source references and unsafe SVG after lazy decode', async () => {
    const doc = await book(1), p = project();
    await expect(decodeSegment({ ...doc.segments[0], data: 'A'.repeat(32) })).rejects.toThrow(/헤더/);
    const bytes = Buffer.from(doc.segments[0].data, 'base64'); bytes[bytes.length - 8] ^= 255;
    await expect(decodeSegment({ ...doc.segments[0], data: bytes.toString('base64') })).rejects.toThrow();
    p.source = { name: 'clip', url: '/api/media/clip.mp4', width: p.width, height: p.height, duration: p.duration, fps: p.fps };
    await expect(decodeSegment(compressed(p, doc.segments[0]))).rejects.toThrow(/composition/);
    delete p.source;
    const path = p.nodes.find(n => n.type === 'path')!; path.path = 'M0 0<script>alert(1)</script>';
    await expect(decodeSegment(compressed(p, doc.segments[0]))).rejects.toThrow(/SVG/);
  });
  it('enforces actual expansion bounds before parsing rather than trusting declared size', async () => {
    const runtime = createMotionRuntime();
    const api = createCompositionRuntime(validateProject, runtime.render, runtime.evaluate, 1024, 8192);
    const data = Buffer.from(gzipSync(new TextEncoder().encode(' '.repeat(16384)))).toString('base64');
    await expect(api.decodeSegment({ id: 'bomb', name: 'bomb', start: 0, end: 8, encoding: 'gzip-base64', data, uncompressedBytes: 1024, nodeCount: 0 })).rejects.toThrow(/실제 압축 해제/);
    expect(() => api.parseDocument(' '.repeat(8193))).toThrow(/한도/);
  });
  it('selects exact global cuts with roundoff tolerance without revealing a later scene early', async () => {
    const doc = await book();
    expect(getSegmentAt(doc, 8).index).toBe(1);
    expect(getSegmentAt(doc, 8 - 1e-10).index).toBe(0);
    expect(getSegmentAt(doc, 8 - Number.EPSILON * 8).index).toBe(1);
    expect(getSegmentAt(doc, 24)).toMatchObject({ index: 2, localTime: 8 });
    expect(getSegmentAt(doc, -5)).toMatchObject({ index: 0, localTime: 0 });
    expect(() => getSegmentAt(doc, NaN)).toThrow();
  });
  it('uses isolated validated snapshots, last-seek-wins and a two-segment cache', async () => {
    const doc = await book(), controller = createCompositionPlayer(doc);
    const requests = [controller.seek(1), controller.seek(9), controller.seek(17)];
    doc.segments[2].data = 'corrupt after prepare';
    const [old, middle, latest] = await Promise.all(requests);
    expect(old).toBeNull(); expect(middle).toBeNull(); expect(latest?.index).toBe(2);
    expect(latest?.svg).toBe(renderSvg(latest!.project, 1));
    expect(latest?.renderer(1)).toBe(latest?.svg);
    expect(latest?.renderer.evaluate(latest!.project.nodes[0].id, 1)).toBeDefined();
    expect(Object.isFrozen(latest!.project.nodes[0].keyframes)).toBe(true);
    expect(controller.cachedSegmentIds.length).toBeLessThanOrEqual(2);
    await controller.preload(1); expect(controller.cachedSegmentIds.length).toBeLessThanOrEqual(2);
    controller.dispose(); await expect(controller.seek(0)).rejects.toThrow(/닫혔/);
  });
  it('replaces one edited chunk without changing other compressed observations', async () => {
    const doc = await book(), p = await decodeSegment(doc.segments[1]);
    p.nodes.find(n => n.type === 'text')!.text = '편집한 문구';
    const changed = await replaceCompositionSegment(doc, 'part-1', p);
    expect(changed.segments[0].data).toBe(doc.segments[0].data);
    expect(changed.segments[2].data).toBe(doc.segments[2].data);
    expect((await decodeSegment(changed.segments[1])).nodes.find(n => n.type === 'text')!.text).toBe('편집한 문구');
  });
  it('executes the actual self-contained HTML with identical global seek results and safe metadata', async () => {
    const doc = await book(); doc.name = '</script><img src=x onerror=alert(1)> 전체';
    doc.source = { name: 'source.mp4', url: '/api/media/private.mp4', width: doc.width, height: doc.height, duration: doc.duration, fps: doc.fps };
    const html = exportHtml(doc);
    expect(html).not.toContain('/api/media/private.mp4');
    expect(html).not.toContain('<img src=x');
    const { player, elements } = await loadPlayer(html);
    for (const time of [0, 7.9, 8, 17.5, 2, 24]) {
      await player.seek(time);
      const location = getSegmentAt(doc, time), p = await decodeSegment(location.segment);
      expect(elements.stage.innerHTML).toBe(renderSvg(p, location.localTime));
      expect(player.currentTime).toBe(time);
    }
    await Promise.all([player.seek(1), player.seek(10), player.seek(18)]);
    expect(player.currentTime).toBe(18);
    expect(player.cachedSegmentIds.length).toBeLessThanOrEqual(2);
    expect(elements.error.textContent).toBe('');
  });
});

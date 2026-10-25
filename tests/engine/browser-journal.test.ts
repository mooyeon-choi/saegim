import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoProject } from '../../src/demo';
import { writeProjectJournal } from '../../src/components/browserProjectStore';
import type { BackgroundMotion } from '../../src/types';

function background(): BackgroundMotion {
  return { mode: 'on', tracks: [{ id: 'a', start: 0, end: 1, anchorTime: 0, polygon: [[0, 0], [100, 0], [100, 100], [0, 100]], featherPx: 0, interpolation: 'linear', keys: [{ time: 0, matrix: [1, 0, 0, 1, 0, 0] }, { time: 1, matrix: [1, 0, 0, 1, 20, 0] }], anchor: { background: '#000000', nodes: [] } }] };
}

afterEach(() => vi.unstubAllGlobals());

describe('background mode exit journal', () => {
  it('records a last-moment mode switch without copying a large unchanged track payload', () => {
    const writes = new Map<string, string>();
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => writes.set(key, value) });
    const backgroundMotion = background();
    backgroundMotion.tracks[0].anchor.nodes = Array.from({ length: 6 }, (_, index) => ({ ...createDemoProject().nodes[0], id: `anchor-${index}`, type: 'path', path: 'M0 0 ' + 'L1 1 '.repeat(9_000), keyframes: [] }));
    const before = Object.assign(createDemoProject(), { backgroundMotion });
    const after = { ...before, backgroundMotion: { ...backgroundMotion, mode: 'off' as const } };
    expect(writeProjectJournal(before, after, 'base-revision')).toBe(true);
    const raw = [...writes.values()][0];
    expect(raw.length).toBeLessThan(1000);
    expect(JSON.parse(raw).meta).toEqual({ set: {}, remove: [], backgroundMotionMode: 'off' });
  });

  it('does not silently drop track changes while compacting a mode switch', () => {
    const writes = new Map<string, string>();
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => writes.set(key, value) });
    const before = Object.assign(createDemoProject(), { backgroundMotion: background() });
    const backgroundMotion: BackgroundMotion = { mode: 'off', tracks: [{ ...before.backgroundMotion.tracks[0], id: 'changed' }] };
    expect(writeProjectJournal(before, { ...before, backgroundMotion }, 'base-revision')).toBe(true);
    expect(JSON.parse([...writes.values()][0]).meta).toEqual({ set: { backgroundMotion }, remove: [] });
  });
});

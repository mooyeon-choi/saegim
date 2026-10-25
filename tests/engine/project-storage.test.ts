import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { createDemoProject } from '../../src/demo';
import { validateProject } from '../../src/engine';
import { COMPRESSED_PROJECT_PREFIX, deserializeProject, MAX_PROJECT_BYTES, serializeProject } from '../../src/components/projectStorage';

describe('project browser storage', () => {
  it('preserves legacy raw JSON and the small-project format', () => {
    const project = createDemoProject();
    const legacy = JSON.stringify(project);
    expect(serializeProject(project)).toBe(legacy);
    expect(deserializeProject(legacy)).toEqual(validateProject(project));
  });

  it('compresses and restores a large Unicode project without losing editable data', () => {
    const project = createDemoProject();
    const template = project.nodes.find(node => node.type === 'text')!;
    project.nodes = Array.from({ length: 150 }, (_, index) => ({ ...template, id: `large-${index}`, name: `모션 ${index}`, text: '한글 모션 '.repeat(1300) }));
    const raw = JSON.stringify(project);
    expect(raw.length).toBeGreaterThan(1_000_000);
    const stored = serializeProject(project);
    expect(stored.startsWith(COMPRESSED_PROJECT_PREFIX)).toBe(true);
    expect(stored.length).toBeLessThan(raw.length / 10);
    expect(deserializeProject(stored)).toEqual(validateProject(project));
  });

  // Full-size limit fixtures test correctness, not a five-second performance budget.
  it('rejects corrupt, invalid, and over-limit stored data before accepting a project', () => {
    expect(() => deserializeProject(COMPRESSED_PROJECT_PREFIX + 'not valid base64')).toThrow(/Base64/);
    const damaged = zlibSync(new TextEncoder().encode(JSON.stringify(createDemoProject())));
    damaged[damaged.length - 1] ^= 1;
    expect(() => deserializeProject(COMPRESSED_PROJECT_PREFIX + Buffer.from(damaged).toString('base64'))).toThrow(/무결성/);
    const oversized = zlibSync(new Uint8Array(MAX_PROJECT_BYTES + 1).fill(32));
    expect(() => deserializeProject(COMPRESSED_PROJECT_PREFIX + Buffer.from(oversized).toString('base64'))).toThrow(/96MB/);
    expect(() => deserializeProject(' '.repeat(MAX_PROJECT_BYTES + 1))).toThrow(/96MB/);
    expect(() => deserializeProject('{"schemaVersion":99}')).toThrow(/schemaVersion/);
  }, 60_000);
});

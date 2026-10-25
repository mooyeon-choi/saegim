import { describe, expect, it } from 'vitest';
import { evaluateNode } from '../../src/engine';
import { createDemoProject } from '../../src/demo';
import { withSolidFill } from '../../src/components/editorUtils';

describe('solid color edits after regional recoloring', () => {
  it('removes regional and observed paint without changing motion or geometry', () => {
    const node = createDemoProject().nodes.find(item => item.type === 'rect')!;
    const region = { path: 'M0 0 L500 0 L500 1000 L0 1000 Z', fill: '#ff0000' };
    node.paintRegions = [region];
    node.keyframes = [
      { time: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, fill: '#00ff00', paintRegions: [region] },
      { time: 1, x: 20, y: 10, scaleX: 2, scaleY: 1, rotation: 20, opacity: .5, paintRegions: [] },
    ];
    const edited = withSolidFill(node, '#123456');
    for (const time of [0, .5, 1]) {
      const original = evaluateNode(node, time), after = evaluateNode(edited, time);
      expect(after).toMatchObject({ x: original.x, y: original.y, width: original.width, height: original.height, rotation: original.rotation, opacity: original.opacity, fill: '#123456' });
      expect(after.paintRegions).toBeUndefined();
    }
    expect(node.paintRegions).toEqual([region]);
    expect(edited.keyframes).toHaveLength(2);
  });
});

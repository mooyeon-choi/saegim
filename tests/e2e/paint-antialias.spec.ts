import { test, expect } from '@playwright/test';
import { renderSvg } from '../../src/engine';
import type { MotionProject, PaintRegion } from '../../src/types';

// A recolored silhouette should have the same coverage as drawing its new paint
// once, including fractional edges, region holes and group opacity.
test('replacement paint preserves silhouette alpha without old hue or clip seams', async ({ page }) => {
  const base = (opacity: number): MotionProject => ({ schemaVersion: 1, id: 'alpha', name: 'alpha', width: 160, height: 160, duration: 1, fps: 24, background: '#37214e', scenes: [], nodes: [{ id: 'edge', name: 'edge', type: 'ellipse', x: 30.37, y: 31.29, width: 94.6, height: 82.4, rotation: 17.3, opacity, fill: '#18bd9c', stroke: 'none', strokeWidth: 0, start: 0, end: 1, hidden: false, locked: false, keyframes: [] }] });
  const color = '#18bd9c';
  const area = (x: number, width: number): PaintRegion => ({ path: `M${x} -100 L${x + width} -100 L${x + width} 1100 L${x} 1100 Z`, fill: color });
  for (const opacity of [1, .43]) for (const variant of ['full', 'adjacent', 'overlap', 'hole', 'gradient', 'priority'] as const) {
    const expected = base(opacity), actual = structuredClone(expected);
    actual.nodes[0].fill = variant === 'full' ? '#ff0066' : color;
    actual.nodes[0].paintRegions = variant === 'full' ? [area(-100, 1200)] : variant === 'adjacent' ? [area(-100, 600), area(500, 600)] : variant === 'overlap' ? [area(-100, 900), area(250, 850)] : [{ path: 'M-100 -100 L1100 -100 L1100 1100 L-100 1100 Z M350 350 L650 350 L650 650 L350 650 Z', fill: color }];
    if (variant === 'priority') {
      expected.nodes[0].fill = '#2485ec'; actual.nodes[0].fill = '#ff6600';
      actual.nodes[0].paintRegions = [area(-100, 1200), { ...area(-100, 1200), fill: '#2485ec' }];
    }
    if (variant === 'gradient') {
      const gradient = { type: 'linear' as const, x1: .1, y1: .2, x2: .8, y2: 1, stops: [{ offset: 0, color: '#16ebd6' }, { offset: 1, color: '#006a71' }] };
      expected.nodes[0].gradient = gradient; actual.nodes[0].fill = '#cc00ff';
      actual.nodes[0].paintRegions = [{ ...area(-100, 1200), gradient }];
    }
    const metrics = await page.evaluate(async ([first, second]) => {
      const raster = async (svg: string) => {
        const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 320; const c = canvas.getContext('2d')!; c.drawImage(image, 0, 0, 320, 320); return c.getImageData(0, 0, 320, 320).data;
      };
      const a = await raster(first), b = await raster(second); let sum = 0, maximum = 0, bad = 0;
      for (let i = 0; i < a.length; i++) { const diff = Math.abs(a[i] - b[i]); sum += diff; maximum = Math.max(maximum, diff); if (diff > 4) bad++; }
      return { mean: sum / a.length, maximum, bad };
    }, [renderSvg(expected, 0), renderSvg(actual, 0)]);
    expect(metrics.maximum, `${variant} opacity ${opacity}`).toBeLessThanOrEqual(2);
    // Isolated premultiplied surfaces can round an 8-bit channel by one level.
    expect(metrics.mean).toBeLessThan(.2);
  }
});

import { expect, test, type Page } from '@playwright/test';
import { gzipSync } from 'fflate';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { MotionComposition, MotionProject } from '../../src/types';

function project(): MotionProject {
  return { schemaVersion: 1, id: 'redraw-demo', name: 'Frame redraw demo', width: 480, height: 270, duration: 1, fps: 24,
    background: '#18201a', scenes: [], temporal: { mode: 'blend', sampleFps: 4, cuts: [] }, nodes: [
      { id: 'title', name: '문구', type: 'text', text: 'FIRST', fontFamily: 'sans-serif', fontSize: 36, fontWeight: 700,
        x: 40, y: 100, width: 360, height: 60, rotation: 0, opacity: 1, fill: '#c9f68b', stroke: 'none', strokeWidth: 0,
        start: 0, end: 1, hidden: false, locked: false,
        keyframes: [{ time: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, { time: 1, x: 70, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }] },
    ] };
}
async function seek(page: Page, time: number) {
  await page.getByTestId('timeline-slider').evaluate((el: HTMLInputElement, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, time);
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-render-time', String(time));
}

for (const schema of [1, 2]) test(`schema ${schema}: frame redraw preserves editing, reload and offline export`, async ({ page, browser }, testInfo) => {
  const p = project();
  const doc: MotionProject | MotionComposition = schema === 1 ? p : {
    schemaVersion: 2, id: 'book', name: 'Frame redraw book', width: p.width, height: p.height, duration: 2, fps: p.fps,
    background: p.background, temporal: { mode: 'blend', sampleFps: 4, cuts: [1] },
    segments: [p, { ...p, id: 'second', nodes: [{ ...p.nodes[0], text: 'SECOND' }] }].map((value, index) => {
      const bytes = Buffer.from(JSON.stringify(value));
      return { id: `chunk-${index}`, name: `Chunk ${index}`, start: index, end: index + 1, encoding: 'gzip-base64',
        data: Buffer.from(gzipSync(bytes)).toString('base64'), uncompressedBytes: bytes.length, nodeCount: value.nodes.length };
    }),
  };
  await page.goto('/');
  await page.getByTestId('import-input').setInputFiles({ name: 'frames.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.header-project')).toContainText(doc.name);
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
  const input = page.getByRole('textbox', { name: '텍스트', exact: true });
  await input.fill('새 문구 <EDIT>'); await input.press('Tab');
  const toggle = page.getByRole('button', { name: '프레임 다시 그리기', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveValue('새 문구 <EDIT>');
  await seek(page, .125);
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-frame-from', '0');
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-frame-to', '');
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-blend-mix', '0');
  await page.locator('.temporal-frame svg').evaluate(el => { (window as any).previousFrame = el; });
  await seek(page, .5);
  expect(await page.locator('.temporal-frame svg').evaluate(el => el !== (window as any).previousFrame)).toBe(true);
  await expect(page.getByTestId('stage-preview')).toContainText('새 문구 <EDIT>');
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await expect(input).toHaveValue('새 문구 <EDIT>');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const downloading = page.waitForEvent('download'); await page.getByTestId('export-html').click();
  const htmlPath = testInfo.outputPath('redraw.html'); await (await downloading).saveAs(htmlPath);
  const context = await browser.newContext({ offline: true });
  const offline = await context.newPage(), errors: string[] = [];
  offline.on('pageerror', e => errors.push(String(e)));
  await offline.goto(pathToFileURL(htmlPath).href);
  await offline.evaluate(async () => { await (window as any).motionPlayer.ready; });
  const result = await offline.evaluate(async () => {
    const player = (window as any).motionPlayer;
    await player.seek(.125); const a = document.querySelector('#stage svg');
    await player.seek(.2); const same = a === document.querySelector('#stage svg');
    await player.seek(.5); const different = a !== document.querySelector('#stage svg');
    const expected = document.querySelector('#stage')!.innerHTML;
    await player.seek(player.duration); const last = document.querySelector('#stage')!.textContent;
    await player.seek(.5); const deterministic = expected === document.querySelector('#stage')!.innerHTML;
    return { same, different, deterministic, last, bad: document.querySelectorAll('#stage image,#stage video,#stage canvas,#stage animate,#stage foreignObject').length,
      mode: JSON.parse(document.querySelector('#motion-data')!.textContent!).temporal.mode };
  });
  expect(result).toMatchObject({ same: true, different: true, deterministic: true, bad: 0, mode: 'frames' });
  expect(result.last).toContain(schema === 1 ? '새 문구 <EDIT>' : 'SECOND');
  expect(errors).toEqual([]); await context.close();
  if (schema === 1) {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(toggle).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await fs.stat(htmlPath);
});

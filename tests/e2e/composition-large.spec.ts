import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MotionComposition } from '../../src/types';

// The ordinary suite stays self-contained. Supply the observed full-video artifact
// to exercise real contour density and compressed scene sizes before delivery.
const observedPath = process.env.FRAMEFORM_COMPOSITION_PROJECT;
test('observed large composition switches scenes, stores edits, and restores the complete book', async ({ page }) => {
  test.skip(!observedPath, 'Set FRAMEFORM_COMPOSITION_PROJECT to the observed composition JSON.');
  test.setTimeout(240_000);
  const input = path.resolve(observedPath!);
  const document = JSON.parse(await fs.readFile(input, 'utf8')) as MotionComposition;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const timings: Record<string, number> = {};
  await page.goto('/');
  let begin = performance.now();
  await page.getByTestId('import-input').setInputFiles(input);
  await expect(page.locator('.header-project')).toContainText(document.name, { timeout: 60_000 });
  await expect(page.locator('.restore-overlay')).not.toBeVisible({ timeout: 60_000 });
  timings.importMs = performance.now() - begin;
  expect(await page.locator('.layer-row').count()).toBeLessThanOrEqual(100);
  await expect(page.getByTestId('timeline-slider')).toHaveAttribute('max', String(document.duration));
  for (const index of [...new Set([1, document.segments.length - 1, 0])]) {
    if (!document.segments[index]) continue;
    begin = performance.now();
    await page.getByLabel('장면 이동', { exact: true }).selectOption(document.segments[index].id);
    await expect(page.locator('.scene-context strong')).toHaveText(document.segments[index].name, { timeout: 60_000 });
    await expect(page.locator('.scene-pending-cover')).not.toBeVisible({ timeout: 60_000 });
    timings[`scene${index}Ms`] = performance.now() - begin;
    expect(await page.locator('.timeline-track').count()).toBeLessThanOrEqual(100);
  }
  await page.getByRole('button', { name: '요소 추가', exact: true }).click();
  await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('FULL VIDEO · EDITABLE');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).press('Tab');
  begin = performance.now();
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('frame-form.project.v1')), { timeout: 60_000 }).toContain('frameform:idb:v1:');
  timings.saveMs = performance.now() - begin;
  begin = performance.now();
  await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.header-project')).toContainText(document.name);
  await page.getByLabel('문구만', { exact: true }).check();
  await page.getByRole('textbox', { name: '요소 검색', exact: true }).fill('FULL VIDEO · EDITABLE');
  await expect(page.locator('.layer-copy strong')).toHaveText('FULL VIDEO · EDITABLE');
  timings.reloadMs = performance.now() - begin;
  const memory = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize);
  await fs.writeFile(test.info().outputPath('composition-performance.json'), JSON.stringify({ input, segments: document.segments.length, compressedBytes: (await fs.stat(input)).size, timings, usedJSHeapBytes: memory, errors }, null, 2));
  await page.screenshot({ path: test.info().outputPath('composition-editor.png'), fullPage: true });
  expect(errors).toEqual([]);
});

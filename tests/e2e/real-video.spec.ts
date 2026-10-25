import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MotionNode, MotionProject } from '../../src/types';

// Opt in with a local 0.2–30 second video. This test never downloads a sample.
const suppliedVideo = process.env.FRAMEFORM_VIDEO_FILE;
const video = suppliedVideo ? path.resolve(suppliedVideo) : undefined;

async function exportedProject(page: Page, filename: string): Promise<MotionProject> {
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-project').click();
  await (await download).saveAs(filename);
  const result = JSON.parse(await fs.readFile(filename, 'utf8')) as MotionProject;
  expect(result.schemaVersion, 'Use a local video of at most 30 seconds for this single-project check.').toBe(1);
  return result;
}

async function selectNode(page: Page, node: MotionNode) {
  await page.getByRole('textbox', { name: '요소 검색', exact: true }).fill(node.name);
  await page.getByRole('button', { name: `${node.name} 선택`, exact: true }).first().click();
}

const motionKeys = (node: MotionNode) => node.keyframes.map(({ fill: _fill, gradient: _gradient, paintRegions: _regions, ...motion }) => motion);

test('user-provided local video supports available-element edits and offline export', async ({ page, context }) => {
  test.skip(!video, 'Set FRAMEFORM_VIDEO_FILE to a local 0.2–30 second video to enable this optional check.');
  expect(existsSync(video!), 'FRAMEFORM_VIDEO_FILE must name an existing local file.').toBe(true);
  const filename = path.basename(video!);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('영상 파일 업로드', { exact: true }).setInputFiles(video!);
  await expect(page.locator('.layers-footer')).toContainText('분석 결과', { timeout: 120_000 });
  await expect(page.locator('.analysis-banner')).not.toBeVisible();
  const original = await exportedProject(page, test.info().outputPath('imported-project.json'));
  expect(original.source?.name).toBe(filename);
  expect(original.nodes.length).toBeGreaterThan(0);

  const title = original.nodes.find(node => node.type === 'text' && !node.hidden && !node.locked);
  const shape = original.nodes.find(node => node.type !== 'text' && !node.hidden && !node.locked && node.fill !== 'none');
  expect(Boolean(title || shape), 'The supplied video must produce at least one editable text or filled vector element.').toBe(true);
  // OCR is optional on this platform/input; record which edit operations were available.
  if (title) {
    await selectNode(page, title);
    await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('새 문구');
    await page.getByRole('textbox', { name: '텍스트', exact: true }).press('Tab');
    await page.getByRole('spinbutton', { name: 'X 위치', exact: true }).fill(String(title.x + 36));
    await page.getByRole('spinbutton', { name: 'X 위치', exact: true }).press('Tab');
  }
  if (shape) {
    await selectNode(page, shape);
    await page.getByRole('textbox', { name: '채우기 값', exact: true }).fill('#8b5cf6');
    await page.getByRole('textbox', { name: '채우기 값', exact: true }).press('Tab');
  }
  const edited = await exportedProject(page, test.info().outputPath('edited-project.json'));
  if (title) {
    const changed = edited.nodes.find(node => node.id === title.id)!;
    expect(changed.text).toBe('새 문구');
    expect(changed.x).toBe(title.x + 36);
    expect(changed.keyframes).toEqual(title.keyframes);
  }
  if (shape) {
    const changed = edited.nodes.find(node => node.id === shape.id)!;
    expect(changed.fill).toBe('#8b5cf6');
    expect(motionKeys(changed)).toEqual(motionKeys(shape));
  }
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-html').click();
  const htmlFile = test.info().outputPath('edited-motion.html');
  await (await download).saveAs(htmlFile);
  const html = await fs.readFile(htmlFile, 'utf8');
  expect(html).not.toContain('<video');
  expect(html).not.toContain('data:image/');
  const offline = await context.newPage();
  const requests: string[] = [];
  offline.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await offline.route(/^https?:/, route => route.abort());
  offline.on('pageerror', error => errors.push(error.message));
  await offline.goto(pathToFileURL(htmlFile).href);
  for (const time of [0, original.duration / 2, Math.max(0, original.duration - 1 / original.fps)]) {
    await offline.evaluate(t => (window as any).motionPlayer.seek(t), time);
    await expect(offline.locator('svg')).toBeVisible();
  }
  if (title) {
    await offline.evaluate(t => (window as any).motionPlayer.seek(t), (title.start + title.end) / 2);
    await expect(offline.locator('svg')).toContainText('새 문구');
  }
  await fs.writeFile(test.info().outputPath('local-video-check.json'), JSON.stringify({ textEditExercised: Boolean(title), colorEditExercised: Boolean(shape), sourceDuration: original.duration, nodes: original.nodes.length, offlineRequests: requests, errors }, null, 2));
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

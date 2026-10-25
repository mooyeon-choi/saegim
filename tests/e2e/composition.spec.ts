import { expect, test } from '@playwright/test';
import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MotionComposition, MotionProject } from '../../src/types';

const storageKey = 'frame-form.project.v1';
function fixture(): MotionComposition {
  const boundaries = [0, 11, 22, 33 + 5 / 24];
  return { schemaVersion: 2, id: 'full-film-test', name: '전체 영상 장면 편집', width: 480, height: 270, fps: 24, duration: boundaries[3], background: '#142010', segments: ['OPENING', 'TITLE', 'CREDITS'].map((text, index) => {
    const duration = boundaries[index + 1] - boundaries[index];
    const project: MotionProject = { schemaVersion: 1, id: `chunk-${index}`, name: text, width: 480, height: 270, duration, fps: 24, background: '#142010', scenes: [{ id: `local-${index}`, name: text, start: 0, end: duration }], nodes: [{ id: `title-${index}`, name: `장면 ${index + 1} 문구`, type: 'text', text, fontSize: 48, fontFamily: 'sans-serif', fontWeight: 700, x: 45, y: 100, width: 400, height: 60, rotation: 0, opacity: 1, fill: '#cdfa7c', stroke: 'none', strokeWidth: 0, start: 0, end: duration, hidden: false, locked: false, keyframes: [] }] };
    const bytes = strToU8(JSON.stringify(project));
    return { id: `segment-${index}`, name: `${index + 1}장 ${text}`, start: boundaries[index], end: boundaries[index + 1], encoding: 'gzip-base64', data: Buffer.from(gzipSync(bytes)).toString('base64'), uncompressedBytes: bytes.length, nodeCount: 1 };
  }) };
}
async function openFixture(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTestId('import-input').setInputFiles({ name: 'whole-film.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture())) });
  await expect(page.locator('.header-project')).toContainText('전체 영상 장면 편집');
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('OPENING');
}

test('whole-video scene navigation keeps edits, handles rapid seeks, and exports every segment', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openFixture(page);
  await expect(page.getByTestId('timeline-slider')).toHaveAttribute('max', String(fixture().duration));
  await page.getByLabel('문구만', { exact: true }).check();
  await expect(page.locator('.layer-copy strong')).toHaveText('OPENING');
  await page.getByLabel('장면 이동', { exact: true }).selectOption('segment-1');
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('TITLE');
  await expect(page.getByRole('spinbutton', { name: '시작 시간', exact: true })).toHaveValue('11');
  await page.getByRole('spinbutton', { name: '시작 시간', exact: true }).fill('12');
  await page.getByRole('spinbutton', { name: '시작 시간', exact: true }).press('Tab');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('NEW TITLE');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).press('Tab');
  await page.getByLabel('장면 이동', { exact: true }).selectOption('segment-2');
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('CREDITS');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('A NEW ENDING');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).press('Tab');
  await page.locator('#scene-select').evaluate((select: HTMLSelectElement) => { for (const value of ['segment-0', 'segment-2', 'segment-1']) { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); } });
  await expect(page.locator('.scene-pending-cover')).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('NEW TITLE');
  expect(Number(await page.getByTestId('timeline-slider').inputValue())).toBeGreaterThanOrEqual(11);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-project').click();
  const download = await downloadPromise;
  const output = JSON.parse(await fs.readFile((await download.path())!, 'utf8')) as MotionComposition;
  expect(output.schemaVersion).toBe(2); expect(output.segments).toHaveLength(3);
  const words = output.segments.map(segment => JSON.parse(strFromU8(gunzipSync(Buffer.from(segment.data, 'base64')))).nodes[0].text);
  expect(words).toEqual(['OPENING', 'NEW TITLE', 'A NEW ENDING']);
  expect(JSON.parse(strFromU8(gunzipSync(Buffer.from(output.segments[1].data, 'base64')))).nodes[0].start).toBe(1);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), storageKey)).toContain('frameform:idb:v1:');
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await page.getByLabel('장면 이동', { exact: true }).selectOption('segment-2');
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('A NEW ENDING');
  expect(errors).toEqual([]);
});

test('composition exit journal restores consecutive unblurred text edits before autosave', async ({ page }) => {
  await openFixture(page);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), storageKey)).toContain('frameform:idb:v1:');
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => schedule(handler, delay === 450 ? 60_000 : delay, ...args)) as typeof window.setTimeout;
  });
  await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('FIRST LAST-MOMENT EDIT');
  await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('FIRST LAST-MOMENT EDIT');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('SECOND LAST-MOMENT EDIT');
  await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('SECOND LAST-MOMENT EDIT');
  await expect(page.getByTestId('storage-warning')).not.toBeVisible();
});

test('a synthetic long upload defaults to full analysis and omits clip fields', async ({ page }) => {
  const video = path.resolve('.data/qa-fixtures/composition-full.mp4');
  await fs.mkdir(path.dirname(video), { recursive: true });
  execFileSync(path.resolve('.venv/bin/python'), ['-c', `import subprocess,imageio_ffmpeg; subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=160x90:r=24:d=33.208333','-c:v','libx264','-pix_fmt','yuv420p',${JSON.stringify(video)}],check=True)`]);
  let body = '';
  await page.route('**/api/analyze', async route => { body = route.request().postData() ?? ''; await route.fulfill({ json: { id: 'whole-mock', status: 'completed', progress: 100, stage: '완료', project: fixture() } }); });
  await page.goto('/');
  await page.getByTestId('upload-input').setInputFiles(video);
  await expect(page.getByRole('dialog', { name: '분석 구간 선택' })).toBeVisible();
  await expect(page.getByRole('button', { name: '전체 영상 분석', exact: false }).first()).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '전체 영상 분석하기', exact: true }).click();
  await expect(page.locator('.header-project')).toContainText('전체 영상 장면 편집');
  expect(body).toContain('name="quality"');
  expect(body).not.toContain('name="clip_start"'); expect(body).not.toContain('name="clip_end"');
  await expect(page.getByTestId('timeline-slider')).toHaveAttribute('max', String(fixture().duration));
});

import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { strFromU8, unzipSync } from 'fflate';
import { createDemoProject } from '../../src/demo';

const artifacts = path.resolve('artifacts/qa');
const fixture = path.resolve('.data/qa-fixtures/motion-shapes.mp4');

async function seek(page: Page, time: number) {
  await page.getByRole('slider', { name: '재생 위치' }).evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, time);
}

test.beforeAll(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  try { await fs.access(fixture); }
  catch {
    execFileSync(path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), ['scripts/create-fixtures.py'], { timeout: 60_000 });
  }
});

test('edit, undo, lock, and restore an editable project', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '움직임을, 편집 가능한 코드로.' })).toBeVisible();
  await page.getByRole('button', { name: '한글 제목 선택', exact: true }).click();
  const text = page.getByRole('textbox', { name: '텍스트', exact: true });
  await text.fill('수정 가능한 움직임');
  await text.press('Tab');
  await expect(page.locator('.svg-preview')).toContainText('수정 가능한 움직임');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(text).toHaveValue('움직임을 코드로');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect(text).toHaveValue('수정 가능한 움직임');
  await page.getByRole('button', { name: '선택 요소 잠금', exact: true }).click();
  await expect(text).toBeDisabled();
  await page.getByRole('button', { name: '선택 요소 잠금 해제', exact: true }).click();
  await expect(text).toBeEnabled();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('frame-form.project.v1'))).toContain('수정 가능한 움직임');
  await page.reload();
  await expect(page.locator('.svg-preview')).toContainText('수정 가능한 움직임');
  expect(errors).toEqual([]);
});

test('export an HTML that plays and seeks without network access', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /독립 HTML/ }).click();
  const downloaded = await downloadPromise;
  const target = path.join(artifacts, 'editable-sample.html');
  await downloaded.saveAs(target);
  const html = await fs.readFile(target, 'utf8');
  expect(html).not.toContain('<video');
  expect(html).not.toContain('data:image/');
  const offline = await context.newPage();
  const errors: string[] = [];
  const network: string[] = [];
  offline.on('pageerror', e => errors.push(e.message));
  offline.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await offline.route(/^https?:/, route => route.abort());
  await offline.goto(pathToFileURL(target).href);
  await offline.evaluate(() => (window as any).motionPlayer.seek(2.5));
  const at25 = await offline.locator('svg').innerHTML();
  await offline.evaluate(() => (window as any).motionPlayer.seek(5));
  expect(await offline.locator('svg').innerHTML()).not.toBe(at25);
  await offline.evaluate(() => (window as any).motionPlayer.seek(2.5));
  expect(await offline.locator('svg').innerHTML()).toBe(at25);
  await expect(offline.locator('svg')).toContainText('움직임을 코드로');
  await offline.screenshot({ path: path.join(artifacts, 'standalone-html.png'), fullPage: true });
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});

test('upload a real video, preserve the source player, and export reconstructed elements', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('영상 파일 업로드', { exact: true }).setInputFiles(fixture);
  await expect(page.locator('.layers-footer')).toContainText('분석 결과', { timeout: 120_000 });
  await expect(page.locator('.svg-preview')).toContainText('HELLO FRAME');
  await expect(page.locator('video')).toBeVisible();
  await page.locator('video').evaluate(video => { (video as HTMLVideoElement).dataset.stable = 'original-element'; });
  await seek(page, 1);
  await page.getByRole('button', { name: '재생', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(1.35);
  await page.getByRole('button', { name: '일시정지', exact: true }).click();
  await expect(page.locator('video')).toHaveAttribute('data-stable', 'original-element');
  await seek(page, 1.5);
  await expect.poll(() => page.locator('video').evaluate(video => Math.abs((video as HTMLVideoElement).currentTime - 1.5))).toBeLessThan(.06);
  await page.screenshot({ path: path.join(artifacts, 'real-upload-editor.png'), fullPage: true });
  await page.getByRole('button', { name: '겹쳐 보기', exact: true }).click();
  await expect(page.locator('.rendered-stage.overlay video')).toBeVisible();
  await page.getByRole('button', { name: '차이 보기', exact: true }).click();
  await expect(page.locator('.rendered-stage.difference')).toBeVisible();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /독립 HTML/ }).click();
  const download = await downloadPromise;
  await download.saveAs(path.join(artifacts, 'reconstructed-video.html'));
  const result = await fs.readFile(path.join(artifacts, 'reconstructed-video.html'), 'utf8');
  expect(result).toContain('HELLO FRAME');
  expect(result).not.toContain('<video');
  expect(errors).toEqual([]);
});

test('invalid input gives recoverable errors and preserves the project', async ({ page }) => {
  await page.goto('/');
  const initial = await page.locator('.header-project').innerText();
  await page.getByLabel('프로젝트 JSON 가져오기', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":55}') });
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.locator('.header-project').innerText()).toBe(initial);
  await page.getByRole('button', { name: '오류 닫기' }).click();
  await page.getByLabel('영상 파일 업로드', { exact: true }).setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a movie') });
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: '영상 업로드', exact: true })).toBeEnabled();
  expect(await page.locator('.header-project').innerText()).toBe(initial);
});

test('cancel a queued analysis without replacing the editor project', async ({ page }) => {
  await page.goto('/');
  const initial = await page.locator('.header-project').innerText();
  await page.getByRole('button', { name: /예제 영상으로 분석해 보기/ }).click();
  await expect(page.locator('.analysis-banner')).toBeVisible();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.locator('.analysis-banner')).not.toBeVisible({ timeout: 30_000 });
  expect(await page.locator('.header-project').innerText()).toBe(initial);
  await expect(page.getByRole('button', { name: '영상 업로드', exact: true })).toBeEnabled();
});

test('desktop and mobile layouts fit the viewport', async ({ page }) => {
  await page.goto('/');
  await seek(page, 2.5);
  await page.screenshot({ path: path.join(artifacts, 'desktop-editor.png'), fullPage: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByRole('button', { name: '내보내기', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '요소 패널', exact: true }).click();
  await expect(page.locator('.layers-panel')).toBeVisible();
  await page.getByRole('button', { name: '요소 패널 닫기', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'mobile-editor.png'), fullPage: true });
});

test('edited project survives JSON roundtrip and source ZIP export', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '한글 제목 선택', exact: true }).click();
  const text = page.getByRole('textbox', { name: '텍스트', exact: true });
  await text.fill('다시 열어도 편집 가능');
  await text.press('Tab');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const jsonDownload = page.waitForEvent('download');
  await page.getByTestId('export-project').click();
  const jsonPath = path.join(artifacts, 'roundtrip-project.json');
  await (await jsonDownload).saveAs(jsonPath);
  await page.getByRole('button', { name: '편집 예제 다시 열기', exact: true }).click();
  await expect(page.locator('.svg-preview')).not.toContainText('다시 열어도 편집 가능');
  await page.getByLabel('프로젝트 JSON 가져오기', { exact: true }).setInputFiles(jsonPath);
  await expect(page.locator('.svg-preview')).toContainText('다시 열어도 편집 가능');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const zipDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /소스 ZIP/ }).click();
  const zipPath = path.join(artifacts, 'roundtrip-project.zip');
  await (await zipDownload).saveAs(zipPath);
  const files = unzipSync(await fs.readFile(zipPath));
  expect(Object.keys(files).sort()).toEqual(['README.txt', 'index.html', 'project.json']);
  expect(strFromU8(files['index.html'])).toContain('다시 열어도 편집 가능');
  expect(JSON.parse(strFromU8(files['project.json'])).nodes.some((node: any) => node.text === '다시 열어도 편집 가능')).toBe(true);
});

test('portrait video changes scene at the cut and fits above the timeline', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('영상 파일 업로드', { exact: true }).setInputFiles(path.resolve('.data/qa-fixtures/portrait-cuts.mp4'));
  await expect(page.locator('.layers-footer')).toContainText('분석 결과', { timeout: 120_000 });
  await seek(page, 1);
  await expect(page.locator('.svg-preview')).toContainText('SCENE ONE');
  await expect(page.locator('.svg-preview')).not.toContainText('SCENE TWO');
  await seek(page, 2);
  await expect(page.locator('.svg-preview')).toContainText('SCENE TWO');
  await expect(page.locator('.svg-preview')).not.toContainText('SCENE ONE');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => {
    const stage = await page.locator('.rendered-stage').boundingBox();
    const playback = await page.locator('.playback-bar').boundingBox();
    return stage!.y + stage!.height <= playback!.y;
  }).toBe(true);
  await page.screenshot({ path: path.join(artifacts, 'portrait-editor.png'), fullPage: true });
});

test('late response from cancelled work cannot replace a new result', async ({ page }) => {
  const oldProject = { ...createDemoProject(), name: '취소된 작업' };
  const newProject = { ...createDemoProject(), name: '새 분석 결과' };
  let uploads = 0;
  let oldPollStarted = false;
  let releaseOld: () => void;
  let oldReturned = false;
  const gate = new Promise<void>(resolve => { releaseOld = resolve; });
  await page.route('**/api/analyze', route => route.fulfill({ json: { id: ++uploads === 1 ? 'old' : 'new', status: 'processing', progress: 1, stage: '요소 분석' } }));
  await page.route('**/api/jobs/old', async route => {
    oldPollStarted = true;
    await gate;
    await route.fulfill({ json: { id: 'old', status: 'completed', progress: 100, stage: '완료', project: oldProject } });
    oldReturned = true;
  });
  await page.route('**/api/jobs/old/cancel', route => route.fulfill({ json: { id: 'old', status: 'cancelled', progress: 1, stage: '취소됨' } }));
  await page.route('**/api/jobs/new', route => route.fulfill({ json: { id: 'new', status: 'completed', progress: 100, stage: '완료', project: newProject } }));
  await page.goto('/');
  await page.getByLabel('영상 파일 업로드', { exact: true }).setInputFiles(fixture);
  await expect.poll(() => oldPollStarted).toBe(true);
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('button', { name: '영상 업로드', exact: true })).toBeEnabled();
  await page.getByLabel('영상 파일 업로드', { exact: true }).setInputFiles(fixture);
  await expect(page.locator('.header-project')).toContainText('새 분석 결과');
  releaseOld!();
  await expect.poll(() => oldReturned).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.locator('.header-project')).toContainText('새 분석 결과');
});

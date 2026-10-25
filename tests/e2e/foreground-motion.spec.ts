import { expect, test, type Page } from '@playwright/test';
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import fs from 'node:fs/promises';
import type { MotionComposition, MotionProject, ForegroundMotion } from '../../src/types';

const foreground = (start = 0, detail = false): ForegroundMotion => ({ mode: 'on', tracks: [{ id: 'eye-pair', label: '눈·안경', start, end: start + 1 / 24, polygon: [[50, 50], [150, 50], [150, 150], [50, 150]], featherPx: 8, forward: [1, 0, 0, 1, 8, 0], ...(detail ? { appearance: { midpoint: .65, sharpness: 2 } } : {}) }] });
function project(id = 'one', text = 'FIRST'): MotionProject {
  return { schemaVersion: 1, id, name: 'Foreground test ' + id, width: 480, height: 270, duration: 1, fps: 24, background: '#18201a', temporal: { mode: 'blend', sampleFps: 24, cuts: [] }, scenes: [{ id: 'scene', name: 'Scene', start: 0, end: 1 }], nodes: [
    { id: 'actor', name: '캐릭터', type: 'rect', x: 75, y: 75, width: 50, height: 50, rotation: 0, opacity: 1, fill: '#86bcff', stroke: 'none', strokeWidth: 0, start: 0, end: 1, hidden: false, locked: false, keyframes: [{ time: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, { time: 1 / 24, x: 8, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }] },
    { id: 'title', name: '문구', type: 'text', text, fontFamily: 'sans-serif', fontSize: 36, fontWeight: 700, x: 35, y: 190, width: 380, height: 45, rotation: 0, opacity: 1, fill: '#c9f68b', stroke: 'none', strokeWidth: 0, start: 0, end: 1, hidden: false, locked: false, keyframes: [] },
  ] };
}
function book(): MotionComposition {
  const first = project(), second = project('two', '한글 문구');
  return { schemaVersion: 2, id: 'foreground-book', name: 'Foreground book', width: 480, height: 270, duration: 2, fps: 24, background: '#18201a', temporal: { mode: 'blend', sampleFps: 24, cuts: [1] }, foregroundMotion: foreground(0, true), backgroundMotion: { mode: 'on', tracks: [{ id: 'bg', start: 0, end: 1, anchorTime: 0, polygon: [[250, 0], [480, 0], [480, 140], [250, 140]], featherPx: 8, interpolation: 'linear', keys: [{ time: 0, matrix: [1, 0, 0, 1, 0, 0] }, { time: 1, matrix: [1, 0, 0, 1, 0, 0] }], anchor: { background: '#243020', nodes: [] } }] }, segments: [first, second].map((chunk, index) => { const bytes = strToU8(JSON.stringify(chunk)); return { id: `segment-${index}`, name: `Storage ${index}`, start: index, end: index + 1, encoding: 'gzip-base64', data: Buffer.from(gzipSync(bytes)).toString('base64'), uncompressedBytes: bytes.length, nodeCount: chunk.nodes.length }; }) };
}
async function open(page: Page, document: MotionProject | MotionComposition) {
  await page.goto('/');
  await page.getByTestId('import-input').setInputFiles({ name: 'foreground.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await expect(page.locator('.header-project')).toContainText(document.name);
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
}
async function seek(page: Page, time: number) {
  await page.getByTestId('timeline-slider').evaluate((element: HTMLInputElement, value) => { element.step = 'any'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await expect.poll(async () => Number(await page.getByTestId('stage-preview').getAttribute('data-render-time'))).toBeCloseTo(time, 6);
  await expect(page.locator('.scene-pending-cover')).not.toBeVisible();
}

test('foreground labeled support, fallback, and single-project undo preserve editable text', async ({ page }) => {
  const doc = project(); doc.foregroundMotion = foreground();
  await open(page, doc); await seek(page, 1 / 48);
  const toggle = page.getByRole('button', { name: '전경 수식 연결', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-foreground-supported', 'true');
  await expect(page.getByRole('combobox', { name: '전경 연결 구간' })).toContainText('눈·안경');
  await seek(page, 0); await expect(page.locator('.connection-interval-detail')).toContainText('원래 관측 화면을 유지');
  await seek(page, .5); await expect(page.getByTestId('foreground-motion-status')).toContainText('기존 연결 사용');
  const field = page.getByRole('textbox', { name: '텍스트', exact: true });
  await field.fill('새 문구'); await field.press('Tab'); await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await expect(field).toHaveValue('새 문구');
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨'); await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await expect(field).toHaveValue('새 문구');
});

test('detail appearance updates within one observation pair without replacing vector DOM', async ({ page }) => {
  await open(page, book()); await seek(page, .25 / 24);
  await expect(page.getByTestId('foreground-motion-status')).toHaveText('세부 형태 연결');
  await expect(page.locator('.connection-interval-detail')).toContainText('위치와 형태 전환을 작은 영역 안에서');
  const patch = page.locator('.temporal-shared-definitions [id$="-appearance"]');
  await expect(patch).toHaveCount(1);
  const before = Number(await patch.getAttribute('opacity'));
  expect(before).toBeGreaterThan(0); expect(before).toBeLessThan(.25);
  const references = await page.evaluateHandle(() => [...document.querySelectorAll('.temporal-frame > svg, .temporal-shared-definitions [id$="-appearance"]')]);
  await seek(page, .65 / 24);
  await expect.poll(async () => Number(await patch.getAttribute('opacity'))).toBeCloseTo(.5, 6);
  expect(await references.evaluate(elements => elements.length === 3 && elements.every(element => element.isConnected))).toBe(true);
  await references.dispose();
  await seek(page, 0); await expect(page.locator('.connection-interval-detail')).toContainText('원래 관측 화면을 유지');
  await expect(patch).toHaveCount(0);
});

test('foreground and background switches independently preserve composition edits, JSON and HTML payloads', async ({ page }) => {
  const original = book(); await open(page, original); await seek(page, 1 / 48);
  const fg = page.getByRole('button', { name: '전경 수식 연결', exact: true }), bg = page.getByRole('button', { name: '배경 수식 연결', exact: true });
  const field = page.getByRole('textbox', { name: '텍스트', exact: true });
  await field.fill('NEW TITLE'); await field.press('Tab'); await fg.click();
  await expect(fg).toHaveAttribute('aria-pressed', 'false'); await expect(bg).toHaveAttribute('aria-pressed', 'true'); await expect(field).toHaveValue('NEW TITLE');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(field).toHaveValue('FIRST');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await expect(field).toHaveValue('NEW TITLE');
  await fg.click(); await bg.click(); await expect(fg).toHaveAttribute('aria-pressed', 'true'); await expect(bg).toHaveAttribute('aria-pressed', 'false'); await bg.click();
  await seek(page, 1.25); await field.fill('새 문구와 함께'); await field.press('Tab');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  let downloaded = page.waitForEvent('download'); await page.getByTestId('export-project').click();
  const exported = JSON.parse(await fs.readFile((await (await downloaded).path())!, 'utf8')) as MotionComposition;
  expect(exported.foregroundMotion).toEqual(original.foregroundMotion); expect(exported.backgroundMotion).toEqual(original.backgroundMotion); expect(exported.temporal).toEqual(original.temporal);
  const texts = exported.segments.map(segment => JSON.parse(strFromU8(gunzipSync(Buffer.from(segment.data, 'base64')))).nodes.find((node: { type: string }) => node.type === 'text').text);
  expect(texts).toEqual(['NEW TITLE', '새 문구와 함께']);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  downloaded = page.waitForEvent('download'); await page.getByTestId('export-html').click();
  const html = await fs.readFile((await (await downloaded).path())!, 'utf8');
  expect(JSON.parse(html.match(/<script type="application\/json" id="motion-data">([\s\S]*?)<\/script>/)![1])).toEqual(exported);
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨'); await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible(); await expect(fg).toHaveAttribute('aria-pressed', 'true'); await expect(field).toHaveValue('NEW TITLE');
  await seek(page, 1.25); await expect(field).toHaveValue('새 문구와 함께');
});

test('foreground last-moment mode journal restores both independent switches', async ({ page }) => {
  const original = book();
  await open(page, original); await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('frame-form.project.v1'))).toContain('frameform:idb:v1:');
  await page.addInitScript(() => { const schedule = window.setTimeout.bind(window); window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => schedule(handler, delay === 450 ? 60_000 : delay, ...args)) as typeof window.setTimeout; });
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  const fg = page.getByRole('button', { name: '전경 수식 연결', exact: true }), bg = page.getByRole('button', { name: '배경 수식 연결', exact: true });
  const field = page.getByRole('textbox', { name: '텍스트', exact: true });
  await field.fill('마지막 문구 · LAST EDIT'); await field.press('Tab');
  await fg.click(); await expect(fg).toHaveAttribute('aria-pressed', 'false'); await bg.click(); await expect(bg).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const raw = await page.evaluate(() => localStorage.getItem('frame-form.project.v1.journal'));
  expect(raw!.length).toBeLessThan(2000); const journal = JSON.parse(raw!);
  expect(journal.meta.foregroundMotionMode).toBe('off'); expect(journal.meta.backgroundMotionMode).toBe('off');
  expect(journal.meta.set.foregroundMotion).toBeUndefined(); expect(journal.meta.set.backgroundMotion).toBeUndefined();
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(fg).toHaveAttribute('aria-pressed', 'false'); await expect(bg).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByTestId('storage-warning')).not.toBeVisible();
  await expect(field).toHaveValue('마지막 문구 · LAST EDIT');
  await fg.click(); await expect(fg).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const repeated = await page.evaluate(() => localStorage.getItem('frame-form.project.v1.journal'));
  expect(repeated!.length).toBeLessThan(2000);
  expect(JSON.parse(repeated!).meta.set.foregroundMotion).toBeUndefined();
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(fg).toHaveAttribute('aria-pressed', 'true'); await expect(bg).toHaveAttribute('aria-pressed', 'false');
  await expect(field).toHaveValue('마지막 문구 · LAST EDIT');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByTestId('export-project').click();
  const exported = JSON.parse(await fs.readFile((await (await download).path())!, 'utf8')) as MotionComposition;
  expect(exported.foregroundMotion).toEqual(original.foregroundMotion);
  expect(exported.backgroundMotion).toEqual({ ...original.backgroundMotion, mode: 'off' });
  expect(exported.temporal).toEqual(original.temporal);
});

test('both motion controls keep a useful canvas in short desktop and narrow viewports', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 }); await open(page, book()); await seek(page, 1 / 48);
  await page.getByRole('button', { name: '재현 화면만 보기', exact: true }).click();
  for (const width of [1280, 871]) {
    await page.setViewportSize({ width, height: 720 });
    await expect.poll(() => page.locator('.rendered-stage').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(150);
    await expect(page.getByRole('button', { name: '배경 수식 연결', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '전경 수식 연결', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '배경 연결 세부정보' }).click(); await expect(page.getByRole('combobox', { name: '배경 연결 구간' })).toBeVisible();
    await page.getByRole('button', { name: '전경 연결 세부정보' }).click(); await expect(page.getByRole('combobox', { name: '전경 연결 구간' })).toContainText('눈·안경');
    expect(await page.locator('.timeline').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`frontend-controls-${width}.png`) });
  }
});

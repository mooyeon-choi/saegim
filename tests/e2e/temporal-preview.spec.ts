import { expect, test, type Page } from '@playwright/test';
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import type { MotionComposition, MotionProject } from '../../src/types';

function chunk(id = 'a', text = 'FIRST'): MotionProject {
  return { schemaVersion: 1, id, name: `Continuity ${id}`, width: 480, height: 270, duration: 1, fps: 24, background: '#18201a', scenes: [{ id: `scene-${id}`, name: 'One shot', start: 0, end: 1 }], nodes: [{ id: `text-${id}`, name: '문구', type: 'text', text, fontFamily: 'sans-serif', fontSize: 48, fontWeight: 700, x: 40, y: 100, width: 360, height: 60, rotation: 0, opacity: 1, fill: '#c9f68b', stroke: 'none', strokeWidth: 0, start: 0, end: 1, hidden: false, locked: false, keyframes: [{ time: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, { time: 1, x: 70, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }] }] };
}
function composition(): MotionComposition {
  return { schemaVersion: 2, id: 'continuous-book', name: 'Continuous book', width: 480, height: 270, duration: 2, fps: 24, background: '#18201a', temporal: { mode: 'blend', sampleFps: 4, cuts: [1.5] }, segments: [chunk(), chunk('b', 'SECOND')].map((project, index) => { project.nodes[0].id = 'shared-title'; const bytes = strToU8(JSON.stringify(project)); return { id: `segment-${index}`, name: `Storage ${index}`, start: index, end: index + 1, encoding: 'gzip-base64', data: Buffer.from(gzipSync(bytes)).toString('base64'), uncompressedBytes: bytes.length, nodeCount: project.nodes.length }; }) };
}
async function open(page: Page, project: MotionProject | MotionComposition) {
  await page.goto('/');
  await page.getByTestId('import-input').setInputFiles({ name: 'continuity.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.locator('.header-project')).toContainText(project.name);
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
}
async function seek(page: Page, time: number) {
  await page.getByTestId('timeline-slider').evaluate((el: HTMLInputElement, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(value)); el.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await expect(page.locator('.scene-pending-cover')).not.toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('stage-preview').getAttribute('data-render-time'))).toBeCloseTo(time, 2);
}

test('smooth preview reuses endpoint DOM, respects cuts, and stores the single-project toggle', async ({ page }) => {
  const project = chunk(); project.temporal = { mode: 'off', sampleFps: 4, cuts: [0.5] };
  await open(page, project);
  const toggle = page.getByRole('button', { name: '부드러운 연결', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await seek(page, 0.125);
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-blend-mix', '0.5');
  await page.locator('.temporal-frame svg').evaluateAll(nodes => { (window as unknown as { endpointNodes: Element[] }).endpointNodes = nodes; });
  await seek(page, 1 / 6);
  expect(await page.locator('.temporal-frame svg').evaluateAll(nodes => nodes.every((node, index) => node === (window as unknown as { endpointNodes: Element[] }).endpointNodes[index]))).toBe(true);
  await seek(page, 11 / 24);
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-frame-to', '');
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await page.reload(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  project.background = 'transparent';
  project.name = 'Transparent continuity';
  await open(page, project); await toggle.click();
  await expect(page.locator('.error-banner')).toContainText('불투명 배경');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('FIRST');
});

test('global continuity crosses storage boundaries, preserves edited text on toggle, and exports metadata', async ({ page }) => {
  await open(page, composition());
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('EDITED FIRST');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).press('Tab');
  const toggle = page.getByRole('button', { name: '부드러운 연결', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('EDITED FIRST');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await seek(page, 23 / 24);
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-frame-from', '0.75');
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-frame-to', '1');
  await expect(page.locator('.svg-preview')).toContainText('EDITED FIRST');
  await expect(page.locator('.svg-preview')).toContainText('SECOND');
  await page.locator('.temporal-frame[data-sample-time="1"] [data-node-id="shared-title"]').click();
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('SECOND');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const downloading = page.waitForEvent('download'); await page.getByTestId('export-project').click();
  const output = JSON.parse(await fs.readFile((await (await downloading).path())!, 'utf8')) as MotionComposition;
  expect(output.temporal).toEqual({ mode: 'blend', sampleFps: 4, cuts: [1.5] });
  expect(JSON.parse(strFromU8(gunzipSync(Buffer.from(output.segments[0].data, 'base64')))).nodes[0].text).toBe('EDITED FIRST');
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('EDITED FIRST');
});

test('a cancelled latest preview clears its pending state', async ({ page }) => {
  const script = await build({ stdin: { contents: `import React, {useCallback,useState} from 'react'; import {createRoot} from 'react-dom/client'; import {TemporalPreview} from './src/components/TemporalPreview'; const resolve=()=>new Promise(resolve=>setTimeout(()=>resolve(null),20)); const onError=()=>{}; function App(){const[pending,setPending]=useState(false);const status=useCallback(value=>setPending(value),[]);return <><output>{pending?'pending':'ready'}</output><TemporalPreview time={0} resolve={resolve} onPending={status} onError={onError}/></>};createRoot(document.getElementById('app')).render(<App/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  await page.route('**/temporal-null-harness', route => route.fulfill({ contentType: 'text/html', body: '<div id="app"></div><script type="module" src="/temporal-null-harness.js"></script>' }));
  await page.route('**/temporal-null-harness.js', route => route.fulfill({ contentType: 'application/javascript', body: script.outputFiles[0].text }));
  await page.goto('/temporal-null-harness');
  await expect(page.locator('output')).toHaveText('ready');
  await page.waitForTimeout(60);
  await expect(page.locator('output')).toHaveText('ready');
});

test('composition exit journal includes a last-moment continuity setting', async ({ page }) => {
  await open(page, composition());
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('frame-form.project.v1'))).toContain('frameform:idb:v1:');
  await page.addInitScript(() => { const schedule = window.setTimeout.bind(window); window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => schedule(handler, delay === 450 ? 60_000 : delay, ...args)) as typeof window.setTimeout; });
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  const toggle = page.getByRole('button', { name: '부드러운 연결', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('storage-warning')).not.toBeVisible();
});

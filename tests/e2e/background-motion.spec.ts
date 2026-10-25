import { expect, test, type Page } from '@playwright/test';
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import type { BackgroundMotion, MotionComposition, MotionNode, MotionProject } from '../../src/types';

const shape = (): MotionNode => ({ id: 'anchor-shape', name: 'Background shape', type: 'rect', x: 10, y: 10, width: 200, height: 200, rotation: 0, opacity: 1, fill: '#c9f68b', stroke: 'none', strokeWidth: 0, start: 0, end: 1, hidden: false, locked: false, keyframes: [] });
function background(large = false): BackgroundMotion {
  const node = shape();
  if (large) { node.type = 'path'; node.path = 'M0 0 ' + 'L1 1 '.repeat(9_000) + 'Z'; }
  return { mode: 'on', tracks: [0, 1].map(index => ({ id: `track-${index}`, start: index, end: index + 1, anchorTime: index, polygon: [[0, 0], [480, 0], [480, 270], [0, 270]], featherPx: 12, interpolation: 'linear', keys: [{ time: index, matrix: [1, 0, 0, 1, 0, 0] }, { time: index + 1, matrix: [1, 0, 0, 1, 30, 0] }], anchor: { background: '#18201a', nodes: index ? [] : large ? Array.from({ length: 6 }, (_, index) => ({ ...node, id: `large-anchor-${index}` })) : [node] } })) };
}
function chunk(id = 'a', text = 'FIRST', duration = 3): MotionProject {
  return { schemaVersion: 1, id, name: `Background ${id}`, width: 480, height: 270, duration, fps: 24, background: '#18201a', temporal: { mode: 'blend', sampleFps: 4, cuts: duration === 3 ? [1, 2] : [] }, scenes: [{ id: `scene-${id}`, name: 'One shot', start: 0, end: duration }], nodes: [{ ...shape(), id: 'title', name: '문구', type: 'text', text, fontFamily: 'sans-serif', fontSize: 48, fontWeight: 700, x: 35, y: 90, width: 380, height: 60, end: duration }] };
}
function book(large = false): MotionComposition {
  return { schemaVersion: 2, id: 'background-book', name: 'Background book', width: 480, height: 270, duration: 3, fps: 24, background: '#18201a', temporal: { mode: 'blend', sampleFps: 4, cuts: [1, 2] }, backgroundMotion: background(large), segments: [chunk('a', 'FIRST', 1), chunk('b', '한글 문구', 1), chunk('c', 'LAST', 1)].map((project, index) => { const bytes = strToU8(JSON.stringify(project)); return { id: `segment-${index}`, name: `Storage ${index}`, start: index, end: index + 1, encoding: 'gzip-base64', data: Buffer.from(gzipSync(bytes)).toString('base64'), uncompressedBytes: bytes.length, nodeCount: project.nodes.length }; }) };
}
async function open(page: Page, project: MotionProject | MotionComposition) {
  await page.goto('/');
  await page.getByTestId('import-input').setInputFiles({ name: 'background.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.locator('.header-project')).toContainText(project.name);
  await expect(page.locator('.restore-overlay')).not.toBeVisible();
}
async function seek(page: Page, time: number) {
  await page.getByTestId('timeline-slider').evaluate((el: HTMLInputElement, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(value)); el.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await expect(page.locator('.scene-pending-cover')).not.toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('stage-preview').getAttribute('data-render-time'))).toBeCloseTo(time, 2);
}

test('background controls distinguish geometry, base color, and fallback while preserving single-project edits', async ({ page }) => {
  const project = chunk(); project.backgroundMotion = background();
  await open(page, project); await seek(page, .25);
  const toggle = page.getByRole('button', { name: '배경 수식 연결', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('background-motion-status')).toContainText('윤곽·면 연결');
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-background-supported', 'true');
  await page.getByRole('combobox', { name: '배경 연결 구간' }).selectOption('background-region-1');
  await expect(page.getByTestId('background-motion-status')).toContainText('기본색 보간');
  await page.getByRole('combobox', { name: '배경 연결 구간' }).selectOption('background-region-2');
  await expect(page.getByTestId('background-motion-status')).toContainText('기존 연결 사용');
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('data-background-supported', 'false');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('새 문구');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).press('Tab');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('새 문구');
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await page.reload(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('새 문구');
});

test('composition background toggle preserves text history, scene edits, export, and reload', async ({ page }) => {
  const original = book(); await open(page, original);
  const field = page.getByRole('textbox', { name: '텍스트', exact: true });
  await field.fill('NEW TITLE'); await field.press('Tab');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(field).toHaveValue('FIRST');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await expect(field).toHaveValue('NEW TITLE');
  const toggle = page.getByRole('button', { name: '배경 수식 연결', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false'); await expect(field).toHaveValue('NEW TITLE');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(field).toHaveValue('FIRST');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await expect(field).toHaveValue('NEW TITLE');
  await seek(page, 1.25); await expect(field).toHaveValue('한글 문구'); await field.fill('새 문구와 함께'); await field.press('Tab');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await expect(field).toHaveValue('새 문구와 함께');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByTestId('export-project').click();
  const output = JSON.parse(await fs.readFile((await (await download).path())!, 'utf8')) as MotionComposition;
  expect(output.backgroundMotion).toEqual(original.backgroundMotion);
  expect(output.temporal).toEqual(original.temporal);
  expect(JSON.parse(strFromU8(gunzipSync(Buffer.from(output.segments[0].data, 'base64')))).nodes[0].text).toBe('NEW TITLE');
  expect(JSON.parse(strFromU8(gunzipSync(Buffer.from(output.segments[1].data, 'base64')))).nodes[0].text).toBe('새 문구와 함께');
  expect(output.segments[2]).toEqual(original.segments[2]);
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await expect(field).toHaveValue('NEW TITLE');
  await seek(page, 1.25); await expect(field).toHaveValue('새 문구와 함께');
});

test('large background mode exit journal restores the last toggle without duplicating anchor paths', async ({ page }) => {
  await open(page, book(true));
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('frame-form.project.v1'))).toContain('frameform:idb:v1:');
  await page.addInitScript(() => { const schedule = window.setTimeout.bind(window); window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => schedule(handler, delay === 450 ? 60_000 : delay, ...args)) as typeof window.setTimeout; });
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  const toggle = page.getByRole('button', { name: '배경 수식 연결', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const journal = await page.evaluate(() => localStorage.getItem('frame-form.project.v1.journal'));
  expect(journal?.length).toBeLessThan(2000); expect(JSON.parse(journal!).meta.backgroundMotionMode).toBe('off');
  await page.reload(); await expect(page.locator('.restore-overlay')).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('storage-warning')).not.toBeVisible();
});

test('shared background geometry persists while only its transform changes', async ({ page }) => {
  const script = await build({ stdin: { contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{TemporalPreview}from'./src/components/TemporalPreview';const defs='<filter id="live-color"><feComponentTransfer><feFuncR id="live-color-R" type="linear"/><feFuncG id="live-color-G" type="linear"/><feFuncB id="live-color-B" type="linear"/></feComponentTransfer></filter><g id="live-background-opacity"><g id="live-background"><rect width="200" height="100" fill="#c9f68b" filter="url(#live-color)"/></g></g>';const svg='<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#18201a"/><use href="#live-background-opacity"/></svg>';const resolve=time=>({time,from:{key:'a',time:0,svg},to:{key:'b',time:1,svg},mix:time,cut:false,fontCss:'',fontMetadata:'',sharedDefinitions:defs,sharedTransforms:[{id:'live-background',matrix:[1,0,0,1,time*100,0],colorId:'live-color',gain:[time,1,1],bias:[time/10,0,0],opacity:time}],backgroundStatus:{mode:'on',activeTrackIds:['test'],supported:true}});const noop=()=>{};function App(){const[t,setT]=useState(.25);return <><button onClick={()=>setT(.75)}>advance</button><TemporalPreview time={t} resolve={resolve} onPending={noop} onError={noop}/></>}createRoot(document.getElementById('app')).render(<App/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  await page.route('**/background-harness', route => route.fulfill({ contentType: 'text/html', body: '<style>.temporal-frame{position:absolute;inset:40px 0 0}.temporal-shared-definitions{position:absolute;width:0;height:0;pointer-events:none}</style><div id="app"></div><script type="module" src="/background-harness.js"></script>' }));
  await page.route('**/background-harness.js', route => route.fulfill({ contentType: 'application/javascript', body: script.outputFiles[0].text }));
  await page.goto('/background-harness');
  await expect(page.locator('#live-background')).toHaveAttribute('transform', 'matrix(1 0 0 1 25 0)');
  await page.locator('#live-background').evaluate(node => { (window as unknown as { backgroundElement: Element }).backgroundElement = node; });
  await page.getByRole('button', { name: 'advance' }).click();
  await expect(page.locator('#live-background')).toHaveAttribute('transform', 'matrix(1 0 0 1 75 0)');
  await expect(page.locator('#live-color-R')).toHaveAttribute('slope', '0.75');
  await expect(page.locator('#live-color-R')).toHaveAttribute('intercept', '0.075');
  await expect(page.locator('#live-background-opacity')).toHaveAttribute('opacity', '0.75');
  expect(await page.locator('#live-background').evaluate(node => node === (window as unknown as { backgroundElement: Element }).backgroundElement)).toBe(true);
  expect(await page.locator('.temporal-frame use').first().evaluate((node: SVGGraphicsElement) => node.getBBox().width)).toBe(200);
});

test('short laptop viewport keeps a useful canvas with scene and background controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, book()); await seek(page, .25);
  const measure = () => page.locator('.rendered-stage').evaluate(node => {
    const canvas = node.getBoundingClientRect();
    const workspace = document.querySelector('.preview-workspace')!.getBoundingClientRect();
    return { width: canvas.width, height: canvas.height, top: canvas.top, bottom: canvas.bottom, workspaceTop: workspace.top, workspaceBottom: workspace.bottom };
  });
  await expect.poll(async () => (await measure()).height).toBeGreaterThan(150);
  await page.getByRole('button', { name: '재현 화면만 보기', exact: true }).click();
  await expect.poll(async () => (await measure()).height).toBeGreaterThan(170);
  const bounds = await measure();
  expect(bounds.width).toBeGreaterThan(300);
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.workspaceTop);
  expect(bounds.bottom).toBeLessThan(bounds.workspaceBottom);
  await expect(page.getByRole('button', { name: '배경 수식 연결', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '장면 이동', exact: true })).toBeVisible();
  await expect(page.getByTestId('timeline-slider')).toBeVisible();
  await page.setViewportSize({ width: 871, height: 720 });
  await expect.poll(async () => (await measure()).height).toBeGreaterThan(150);
});

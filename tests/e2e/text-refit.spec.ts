import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDemoProject } from '../../src/demo';
import type { MotionNode, MotionProject } from '../../src/types';

async function downloadProject(page: import('@playwright/test').Page): Promise<MotionProject> {
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const pending = page.waitForEvent('download'); await page.getByTestId('export-project').click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}

test('delayed text measurement keeps the latest text and unrelated edits in one undo history', async ({ page }) => {
  const project = createDemoProject();
  const title: MotionNode = { ...project.nodes.find(node => node.type === 'text')!, id: 'fit-title', name: '글자 맞춤 검수', text: 'BEFORE', fontFamily: 'Arial', textFit: 'width', textBox: { x: 0, y: -50, width: 300, height: 60, advance: 300 }, textWarp: { top: [{ u: 0, x: 0, y: 0 }, { u: 1, x: 1000, y: 0 }], bottom: [{ u: 0, x: 0, y: 1000 }, { u: 1, x: 1000, y: 1000 }] } };
  project.nodes = [title];
  await page.addInitScript(data => {
    localStorage.setItem('frame-form.project.v1', JSON.stringify(data));
    const load = document.fonts.load.bind(document.fonts);
    document.fonts.check = () => false;
    document.fonts.load = async (font, text) => { await new Promise(resolve => setTimeout(resolve, text === 'FIRST' ? 700 : 250)); return load(font, text); };
  }, project);
  await page.goto('/');
  await page.getByTestId('node-text-input').fill('FIRST'); await page.getByTestId('node-text-input').press('Tab');
  await page.getByTestId('node-text-input').fill('SECOND\n한글'); await page.getByTestId('node-text-input').press('Tab');
  await page.getByTestId('node-x-input').fill('123'); await page.getByTestId('node-x-input').press('Tab');
  const saved = (await downloadProject(page)).nodes[0];
  expect(saved.text).toBe('SECOND\n한글'); expect(saved.x).toBe(123); expect(saved.keyframes).toEqual(title.keyframes);
  expect(saved.textBox!.height).toBeGreaterThan(saved.fontSize!); expect(saved.textBox!.width).toBeGreaterThan(0);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.getByTestId('node-x-input')).toHaveValue(String(title.x));
  await expect(page.getByTestId('node-text-input')).toHaveValue('SECOND\n한글');
  const afterUndo = (await downloadProject(page)).nodes[0]; expect(afterUndo.textBox).toEqual(saved.textBox);
  await page.getByRole('spinbutton', { name: '글자 크기', exact: true }).fill('150'); await page.getByRole('spinbutton', { name: '글자 크기', exact: true }).press('Tab');
  expect((await downloadProject(page)).nodes[0].textBox).toEqual(saved.textBox);
  await page.getByTestId('node-text-input').fill('  \n '); await page.getByTestId('node-text-input').press('Tab');
  const blank = (await downloadProject(page)).nodes[0];
  expect(Object.values(blank.textBox!).every(Number.isFinite)).toBe(true); expect(blank.textBox!.height).toBeGreaterThan(0);
});

test('synthetic perspective title refits English and Korean ink and keeps editable offline SVG text', async ({ page, context }) => {
  const project = createDemoProject();
  const title: MotionNode = {
    ...project.nodes.find(node => node.type === 'text')!, id: 'refit-title', name: '원근 제목 검수', text: 'TITLE',
    fontFamily: 'sans-serif', fontSize: 300, fontWeight: 400, fontStyle: 'normal', letterSpacing: 0,
    x: 60, y: 100, width: 800, height: 220, start: 0, end: project.duration, textFit: 'width',
    textBox: { x: 0, y: -210, width: 800, height: 220, advance: 800 },
    textWarp: { top: [{ u: 0, x: 0, y: 100 }, { u: .5, x: 500, y: 0 }, { u: 1, x: 1000, y: 100 }], bottom: [{ u: 0, x: 0, y: 900 }, { u: .5, x: 500, y: 1000 }, { u: 1, x: 1000, y: 900 }] },
    occlusionPath: 'M 440 0 L 560 0 L 560 1000 L 440 1000 Z',
    keyframes: [{ time: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: 'linear' }, { time: 8, x: 20, y: 15, scaleX: 1, scaleY: 1, rotation: 5, opacity: 1, easing: 'linear' }],
  };
  project.nodes = [title];
  const oldBox = structuredClone(title.textBox);
  const input = test.info().outputPath('synthetic-perspective-title.json'); await writeFile(input, JSON.stringify(project));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByTestId('import-input').setInputFiles(input);
  await expect(page.getByTestId('node-text-input')).toHaveValue('TITLE');
  await page.evaluate(() => document.fonts.load('400 300px sans-serif', 'TITLE새 문구'));
  const untouched = (await downloadProject(page)).nodes.find(node => node.id === title.id)!;
  expect(untouched.textBox).toEqual(oldBox);
  const boxes: Record<string, MotionNode['textBox']> = {};
  for (const [tag, word] of [['english', 'NEW TITLE'], ['korean', '새 문구']]) {
    await page.getByTestId('node-text-input').fill(word); await page.getByTestId('node-text-input').press('Tab');
    const changed = (await downloadProject(page)).nodes.find(node => node.id === title.id)!;
    const metrics = await page.evaluate(text => { const c = document.createElement('canvas').getContext('2d')!; c.font = '400 300px sans-serif'; const m = c.measureText(text); return { x: -m.actualBoundingBoxLeft, y: -m.actualBoundingBoxAscent, width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight, height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent, advance: m.width }; }, word);
    expect(changed.textBox).toEqual(metrics); expect(changed.textWarp).toEqual(title.textWarp); expect(changed.keyframes).toEqual(title.keyframes); expect(changed.occlusionPath).toBe(title.occlusionPath);
    boxes[tag] = changed.textBox;
    await page.getByTestId('timeline-slider').fill('3');
    await page.screenshot({ path: test.info().outputPath(`title-refit-${tag}.png`), fullPage: true });
  }
  expect(boxes.english!.width).not.toBe(boxes.korean!.width);
  expect(boxes.korean!.height).toBeGreaterThan(0);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const pending = page.waitForEvent('download'); await page.getByTestId('export-html').click();
  const exported = test.info().outputPath('title-korean-offline.html'); await (await pending).saveAs(exported);
  const offline = await context.newPage(); const requests: string[] = [];
  offline.on('pageerror', error => errors.push(error.message)); offline.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await offline.route(/^https?:/, route => route.abort()); await offline.goto(pathToFileURL(exported).href);
  await offline.evaluate(async () => { (window as any).motionPlayer.seek(3); await document.fonts.ready; });
  await expect(offline.locator(`[data-node-id="${title.id}"] text`)).toHaveText('새 문구');
  expect(await offline.locator('image,video,canvas').count()).toBe(0);
  await offline.screenshot({ path: test.info().outputPath('title-refit-korean-offline.png'), fullPage: true });
  await writeFile(test.info().outputPath('title-refit-check.json'), JSON.stringify({ originalUnchanged: true, originalBox: oldBox, boxes, motionPreserved: true, requests, errors }, null, 2));
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

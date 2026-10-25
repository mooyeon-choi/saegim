import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createDemoProject } from '../../src/demo';
import type { MotionNode, TextWarp } from '../../src/types';

const shortVideo = path.resolve('.data/qa-fixtures/quality-short.mp4');
const longVideo = path.resolve('.data/qa-fixtures/long-clip-selection.mp4');

test.beforeAll(() => {
  execFileSync(path.resolve('.venv/bin/python'), ['-c', `
from pathlib import Path
import subprocess, imageio_ffmpeg
for filename, duration in [(${JSON.stringify(shortVideo)}, 1), (${JSON.stringify(longVideo)}, 31.5)]:
    target = Path(filename)
    if target.exists(): continue
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'color=c=white:s=160x90:r=10:d={duration}', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(target)], check=True)
`], { timeout: 30_000 });
});

test('quality choices reach direct uploads and clip analysis without changing the current project on cancel', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/api/analyze', async route => {
    bodies.push(route.request().postDataBuffer()!.toString());
    await route.fulfill({ json: { id: `quality-${bodies.length}`, status: 'completed', progress: 100, stage: '완료', project: createDemoProject() } });
  });
  await page.goto('/');
  await expect(page.getByRole('radio', { name: '빠른 분석', exact: true })).toBeChecked();
  await page.getByTestId('upload-input').setInputFiles(shortVideo);
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatch(/name="quality"\r\n\r\nstandard/);
  expect(bodies[0]).not.toContain('name="sample_fps"');
  await expect(page.locator('.analysis-banner')).not.toBeVisible();
  await page.getByRole('radio', { name: '정밀 분석', exact: true }).check();
  await page.getByTestId('upload-input').setInputFiles(shortVideo);
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatch(/name="quality"\r\n\r\nhigh/);
  expect(bodies[1]).toMatch(/name="sample_fps"\r\n\r\n24/);
  await expect(page.locator('.analysis-banner')).not.toBeVisible();
  await page.getByTestId('upload-input').setInputFiles(longVideo);
  const dialog = page.getByRole('dialog', { name: '분석 구간 선택' });
  await expect(dialog.getByRole('radio', { name: '정밀 분석', exact: true })).toBeChecked();
  await dialog.getByRole('radio', { name: '빠른 분석', exact: true }).check();
  await dialog.getByRole('button', { name: '구간 선택 취소' }).click();
  expect(bodies).toHaveLength(2);
  await expect(page.locator('.header-project')).toContainText('움직임을 코드로');
  await page.getByTestId('upload-input').setInputFiles(longVideo);
  await dialog.getByRole('radio', { name: '정밀 분석', exact: true }).check();
  await dialog.getByRole('button', { name: '구간 선택', exact: false }).filter({ hasText: '최대 30초' }).click();
  await dialog.getByRole('spinbutton', { name: '분석 시작 시간' }).fill('29');
  await dialog.getByRole('spinbutton', { name: '분석 종료 시간' }).fill('31');
  await dialog.getByRole('button', { name: '선택 구간 분석하기' }).click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).toMatch(/name="quality"\r\n\r\nhigh/);
  expect(bodies[2]).toMatch(/name="sample_fps"\r\n\r\n24/);
  expect(bodies[2]).toMatch(/name="clip_start"\r\n\r\n29/);
  expect(bodies[2]).toMatch(/name="clip_end"\r\n\r\n31/);
});

test('one perspective title edits text, corners, sizing and color while retaining its occlusion and motion', async ({ page }) => {
  const project = createDemoProject();
  const warp: TextWarp = { top: [{ u: 0, x: 0, y: 100 }, { u: .5, x: 500, y: 0 }, { u: 1, x: 1000, y: 100 }], bottom: [{ u: 0, x: 0, y: 1000 }, { u: .5, x: 500, y: 850 }, { u: 1, x: 1000, y: 1000 }] };
  const title: MotionNode = { ...project.nodes[1], id: 'warp-title', name: '원근 제목', text: 'TITLE', fontFamily: 'Arial, sans-serif', fontSize: 120, letterSpacing: 0, x: 100, y: 150, width: 700, height: 160, textWarp: warp, textFit: 'width', fontStyle: 'italic', occlusionPath: 'M 400 0 L 500 0 L 500 1000 L 400 1000 Z', gradient: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#660000' }] }, keyframes: [{ time: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, textWarp: warp, fill: '#aa0000' }, { time: 8, x: 20, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, textWarp: { top: warp.top.map(point => ({ ...point, x: point.x + 10 })), bottom: warp.bottom.map(point => ({ ...point, x: point.x + 10 })) } }] };
  project.nodes = [title, { ...project.nodes[0], id: 'other-text', y: 400 }];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(data => localStorage.setItem('frame-form.project.v1', JSON.stringify(data)), project);
  await page.goto('/');
  await expect(page.locator('.perspective-notice')).toContainText('하나의 텍스트 요소');
  await expect(page.locator('.svg-preview [data-node-id="warp-title"]')).toHaveCount(1);
  await page.getByTestId('node-text-input').fill('NEW TITLE');
  await page.getByTestId('node-text-input').press('Tab');
  await expect(page.locator('.svg-preview')).toContainText('NEW TITLE');
  await page.getByRole('checkbox', { name: '가림 영역 표시', exact: true }).check();
  await page.getByText('네 모서리 조정', { exact: false }).click();
  await page.getByRole('spinbutton', { name: '왼쪽 위 X', exact: true }).fill('3000');
  await page.getByRole('spinbutton', { name: '왼쪽 위 X', exact: true }).press('Tab');
  await expect(page.locator('.warp-validation')).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: '왼쪽 위 X', exact: true })).toHaveValue('0');
  await page.getByRole('spinbutton', { name: '왼쪽 위 X', exact: true }).fill('25');
  await page.getByRole('spinbutton', { name: '왼쪽 위 X', exact: true }).press('Tab');
  await page.getByRole('spinbutton', { name: '너비', exact: true }).fill('350');
  await page.getByRole('spinbutton', { name: '너비', exact: true }).press('Tab');
  await expect(page.getByRole('spinbutton', { name: '높이', exact: true })).toHaveValue('80');
  await page.getByRole('textbox', { name: '채우기 값', exact: true }).fill('#24a6ff');
  await page.getByRole('textbox', { name: '채우기 값', exact: true }).press('Tab');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('frame-form.project.v1')!).nodes[0].fill)).toBe('#24a6ff');
  const saved: MotionNode = await page.evaluate(() => JSON.parse(localStorage.getItem('frame-form.project.v1')!).nodes[0]);
  expect(saved.text).toBe('NEW TITLE');
  expect(saved.textWarp!.top[0].x).toBe(25);
  expect(saved.keyframes[1].textWarp!.top[0].x).toBe(35);
  expect(saved.textWarp!.top[1]).toEqual(warp.top[1]);
  expect(saved.keyframes[1].x).toBe(20);
  expect(saved.occlusionPath).toBe(title.occlusionPath);
  expect(saved.gradient).toBeUndefined();
  expect(saved.keyframes.every(frame => !frame.fill && !frame.gradient)).toBe(true);
  await page.getByRole('button', { name: '작은 제목 · MOTION, REBUILT 선택', exact: true }).click();
  await page.locator('.svg-preview [data-node-id="warp-title"]').dispatchEvent('click');
  await expect(page.getByTestId('node-text-input')).toHaveValue('NEW TITLE');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '채우기 값', exact: true })).toHaveValue(title.fill);
  await page.setViewportSize({ width: 874, height: 900 });
  await page.getByRole('button', { name: '속성 패널', exact: true }).click();
  await expect(page.locator('.perspective-notice')).toBeVisible();
  expect(errors).toEqual([]);
});

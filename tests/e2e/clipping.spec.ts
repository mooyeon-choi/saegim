import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const video = path.resolve('.data/qa-fixtures/long-clip-selection.mp4');

test.beforeAll(async () => {
  await fs.mkdir(path.dirname(video), { recursive: true });
  execFileSync(path.resolve('.venv/bin/python'), ['-c', `
import subprocess, imageio_ffmpeg
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
 'color=c=white:s=160x90:r=10:d=31.5', '-vf', 'drawbox=x=40:y=25:w=30:h=25:color=red:t=fill',
 '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ${JSON.stringify(video)}], check=True)
`], { timeout: 30_000 });
});

test('long video opens range selection, validates duration, and cancellation preserves the project', async ({ page }) => {
  await page.goto('/');
  const previous = await page.locator('.header-project').innerText();
  await page.getByLabel('영상 파일 업로드', { exact: true }).setInputFiles(video);
  const dialog = page.getByRole('dialog', { name: '분석 구간 선택' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('31.5초');
  await expect(page.getByRole('button', { name: '전체 영상 분석하기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '구간 선택', exact: false }).filter({ hasText: '최대 30초' }).click();
  await page.getByRole('spinbutton', { name: '분석 종료 시간', exact: true }).fill('31.5');
  await expect(page.getByRole('button', { name: '선택 구간 분석하기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '구간 선택 취소', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.header-project')).toHaveText(previous);
  await expect(page.locator('.analysis-banner')).not.toBeVisible();
});

test('selected ending segment is analyzed as a new zero-based source timeline', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('영상 파일 업로드', { exact: true }).setInputFiles(video);
  await expect(page.getByRole('dialog', { name: '분석 구간 선택' })).toBeVisible();
  await page.getByRole('button', { name: '구간 선택', exact: false }).filter({ hasText: '최대 30초' }).click();
  await page.getByRole('spinbutton', { name: '분석 시작 시간', exact: true }).fill('30');
  await page.getByRole('spinbutton', { name: '분석 종료 시간', exact: true }).fill('31.5');
  await page.getByRole('button', { name: '선택 구간 분석하기', exact: true }).click();
  await expect(page.locator('.header-project')).toContainText('30.0–31.5초', { timeout: 60_000 });
  await expect(page.locator('.analysis-banner')).not.toBeVisible();
  const source = page.locator('video.source-video');
  await expect(source).toBeVisible();
  await expect.poll(() => source.evaluate(video => (video as HTMLVideoElement).duration)).toBeCloseTo(1.5, 1);
  await expect(page.getByRole('slider', { name: '재생 위치', exact: true })).toHaveAttribute('max', '1.5');
  expect(errors).toEqual([]);
});

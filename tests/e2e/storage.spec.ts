import { expect, test } from '@playwright/test';
import { createDemoProject } from '../../src/demo';

const key = 'frame-form.project.v1';

test('page exit flushes the current text draft before the debounce without a prompt', async ({ page }) => {
  // Keep the regular debounce pending so only the exit handlers can save this edit.
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => schedule(handler, delay === 450 ? 60_000 : delay, ...args)) as typeof window.setTimeout;
  });
  let dialogs = 0;
  page.on('dialog', dialog => { dialogs++; void dialog.dismiss(); });
  await page.goto('/');
  await page.getByRole('button', { name: '한글 제목 선택', exact: true }).click();
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('바로 새로고침해도 보존');
  // Do not blur: the unload handler must commit the inspector's draft as well.
  await page.reload();
  await page.getByRole('button', { name: '한글 제목 선택', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('바로 새로고침해도 보존');
  await expect(page.locator('.svg-preview')).toContainText('바로 새로고침해도 보존');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('페이지 숨김도 보존');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  const saved = await page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!), key);
  expect(saved.nodes.some((node: { text?: string }) => node.text === '페이지 숨김도 보존')).toBe(true);
  expect(dialogs).toBe(0);
});

test('storage failures stay visible on narrow screens and clear after a successful retry', async ({ page }) => {
  const previous = createDemoProject();
  previous.nodes.find(node => node.type === 'text')!.text = '이전 편집 유지';
  const previousJson = JSON.stringify(previous);
  await page.addInitScript(({ storageKey, snapshot }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, snapshot);
    (window as any).__failProjectSave = true;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === storageKey && (window as any).__failProjectSave) throw new DOMException('Storage quota reached', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, { storageKey: key, snapshot: previousJson });
  await page.setViewportSize({ width: 874, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('storage-warning')).toBeVisible();
  await page.getByRole('button', { name: '속성 패널', exact: true }).click();
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('새 편집도 저장');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).press('Tab');
  await page.getByRole('button', { name: '속성 패널 닫기', exact: true }).click();
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe(previousJson);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('storage-warning')).toBeVisible();
  await expect(page.getByRole('button', { name: '저장 실패 프로젝트 JSON 백업' })).toBeVisible();
  await page.evaluate(() => { (window as any).__failProjectSave = false; });
  await page.getByRole('button', { name: '프로젝트 저장 다시 시도' }).click();
  await expect(page.getByTestId('storage-warning')).not.toBeVisible();
  const saved = await page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!), key);
  expect(saved.nodes.some((node: { text?: string }) => node.text === '새 편집도 저장')).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '속성 패널', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('새 편집도 저장');
});

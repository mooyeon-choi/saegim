import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { largeProjectFixture } from './fixtures/largeProject';

const key = 'frame-form.project.v1';
const pointerPrefix = 'frameform:idb:v1:';

test('large projects paginate, save to IndexedDB, and restore the last text draft through a journal', async ({ page }) => {
  test.setTimeout(240_000);
  const project = largeProjectFixture();
  const titleIndex = project.nodes.findIndex(node => node.id === 'storage-title');
  const targetPage = Math.floor(titleIndex / 100) + 1;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const inputPath = test.info().outputPath('large-motion.json');
  await writeFile(inputPath, JSON.stringify(project));
  await page.getByTestId('import-input').setInputFiles(inputPath);
  await expect(page.locator('.header-project')).toContainText(project.name, { timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('대형 프로젝트 문구');
  expect(Number(await page.getByRole('slider', { name: '재생 위치' }).inputValue())).toBeGreaterThanOrEqual(project.nodes[titleIndex].start);
  const pages = Math.ceil(project.nodes.length / 100);
  await expect(page.getByLabel('요소 페이지', { exact: true })).toHaveText(`${targetPage} / ${pages}`);
  await page.getByRole('button', { name: targetPage > 1 ? '이전 요소 페이지' : '다음 요소 페이지', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(100);
  await expect(page.locator('.timeline-track')).toHaveCount(100);
  expect(await page.locator('.track-segment i').count()).toBeLessThanOrEqual(4000);
  await page.getByRole('textbox', { name: '요소 검색', exact: true }).fill('저장 검수 제목');
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.getByRole('button', { name: '저장 검수 제목 선택', exact: true }).click();
  await page.getByRole('textbox', { name: '요소 검색', exact: true }).fill('');
  await expect(page.getByLabel('요소 페이지', { exact: true })).toHaveText(`${targetPage} / ${pages}`);
  await expect(page.getByRole('button', { name: '저장 검수 제목 선택', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(storageKey => localStorage.getItem(storageKey), key), { timeout: 60_000 }).toContain(pointerPrefix);
  await expect(page.locator('.saved-status')).toContainText('이 브라우저에 저장됨');

  // Preserve the normal 450ms autosave; only this test delays it to exercise exit recovery.
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => schedule(handler, delay === 450 ? 60_000 : delay, ...args)) as typeof window.setTimeout;
  });
  await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('대형 프로젝트 문구');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('마지막 순간의 문구도 복원');
  // No blur: beforeunload must commit the live draft and synchronously write the small journal.
  await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('마지막 순간의 문구도 복원');
  await page.getByRole('textbox', { name: '텍스트', exact: true }).fill('복원 이후 두 번째 문구도 유지');
  await page.reload();
  await expect(page.locator('.restore-overlay')).not.toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: '텍스트', exact: true })).toHaveValue('복원 이후 두 번째 문구도 유지');
  await expect(page.getByTestId('storage-warning')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('late database saves cannot replace a newer committed revision and a damaged snapshot falls back', async ({ page }) => {
  // Serve a bundled test harness on the same origin so this check also runs
  // against the production build, which intentionally does not serve TS files.
  const harness = await build({ stdin: { contents: "export {createDemoProject} from './src/demo'; export * from './src/components/browserProjectStore';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  await page.route('**/__qa-project-store.mjs', route => route.fulfill({ contentType: 'text/javascript', body: harness.outputFiles[0].text }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(storageKey => localStorage.getItem(storageKey), key)).not.toBeNull();
  const result = await page.evaluate(async () => {
    const storeUrl = '/__qa-project-store.mjs';
    const store = await import(storeUrl);
    const { createDemoProject } = store;
    const originalSet = Storage.prototype.setItem;
    // Force otherwise-small fixtures through the same database fallback used after quota errors.
    Storage.prototype.setItem = function (key, value) {
      if (key === 'frame-form.project.v1' && !value.startsWith('frameform:idb:v1:')) throw new DOMException('Quota', 'QuotaExceededError');
      return originalSet.call(this, key, value);
    };
    const a = createDemoProject(); a.name = 'old pending';
    const b = createDemoProject(); b.name = 'latest saved';
    const completeDescriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    let holdNextCompletion = true;
    let releaseOld: (() => void) | undefined;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { configurable: true, get: completeDescriptor.get, set(handler) {
      const hold = holdNextCompletion;
      holdNextCompletion = false;
      completeDescriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
        if (hold) releaseOld = () => handler.call(this, event);
        else handler.call(this, event);
      });
    } });
    let current = 'old';
    const old = store.saveBrowserProject(a, () => current === 'old');
    current = 'new';
    const newer = await store.saveBrowserProject(b, () => current === 'new');
    if (!releaseOld) throw new Error('The older transaction should have completed first.');
    releaseOld();
    await old;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', completeDescriptor);
    const pointer = store.readInitialSave().pointer!;
    const restored = await store.restoreDatabaseProject(pointer);
    const c = createDemoProject(); c.name = 'damaged latest';
    await store.saveBrowserProject(c, () => true, newer!.revision);
    const latest = store.readInitialSave().pointer!;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('frameform-projects', 1);
      request.onsuccess = () => {
        const tx = request.result.transaction('snapshots', 'readwrite');
        tx.objectStore('snapshots').put('corrupt', latest.revision);
        tx.oncomplete = () => { request.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    const fallback = await store.restoreDatabaseProject(latest);
    Storage.prototype.setItem = originalSet;
    return { newest: restored.project.name, markerMatchesNew: pointer.revision === newer!.revision, fallback: fallback.project.name, warning: fallback.warning };
  });
  expect(result.newest).toBe('latest saved');
  expect(result.markerMatchesNew).toBe(true);
  expect(result.fallback).toBe('latest saved');
  expect(result.warning).toContain('이전 저장');
});

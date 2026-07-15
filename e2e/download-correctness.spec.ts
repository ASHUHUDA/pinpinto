import { readFile, stat } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { test, expect } from './fixtures/extension';
import { createPinterestSearchFixture } from './fixtures/pinterest-search';

test('E2E Blob host fetches and packages 80 local images', async ({ openExtensionPage, assetServer }) => {
  const control = await openExtensionPage('popup.html');
  const probeUrls = Array.from({ length: 80 }, (_, index) => (
    `${assetServer.baseUrl}/pinimg.com/236x/pinpinto-e2e/probe-${index + 1}.svg`
  ));
  const blobProbe = await control.evaluate(async (urls) => chrome.runtime.sendMessage({
    action: 'pinpintoE2EBlobProbe',
    urls
  }), probeUrls);
  expect(blobProbe).toMatchObject({
    success: true,
    result: { failedEntries: [] }
  });
  expect(blobProbe.result.zippedEntries).toHaveLength(80);
});

test('automatic search tail excludes recommendations and clears state after disk settlement', async ({
  context,
  extensionId,
  openExtensionPage,
  assetServer
}, testInfo) => {
  const runtimeErrors: string[] = [];
  const extensionLogs: string[] = [];
  context.on('console', (message) => {
    extensionLogs.push(`[${message.type()}] ${message.text().slice(0, 1_000)}`);
    if (extensionLogs.length > 100) extensionLogs.shift();
  });
  const searchPage = await context.newPage();
  searchPage.on('pageerror', (error) => runtimeErrors.push(error.message));

  await context.route('https://www.pinterest.com/search/pins/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: createPinterestSearchFixture(80, 5, assetServer.baseUrl)
  }));

  await searchPage.goto('https://www.pinterest.com/search/pins/?q=pinpinto-e2e', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => searchPage.locator('.pinvault-overlay-controls').count()).toBe(85);

  const control = await openExtensionPage('popup.html');
  control.on('pageerror', (error) => runtimeErrors.push(error.message));
  await control.evaluate(() => {
    const progressFill = document.getElementById('progressFill');
    const values = [Number(progressFill?.getAttribute('aria-valuenow') ?? 0)];
    new MutationObserver(() => {
      values.push(Number(progressFill?.getAttribute('aria-valuenow') ?? 0));
    }).observe(progressFill!, { attributes: true, attributeFilter: ['aria-valuenow'] });
    (globalThis as typeof globalThis & { pinpintoProgressValues?: number[] }).pinpintoProgressValues = values;
  });
  const targetTabId = await findPinterestTabId(control);
  const start = await control.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    action: 'downloadImages',
    mode: 'auto',
    targetTabId: tabId,
    autoBatchLimit: 100,
    settings: {
      highQuality: true,
      maxConcurrentDownloads: 6,
      autoBatchLimit: 100
    }
  }), { tabId: targetTabId });
  expect(start.accepted).toBe(true);

  const zipPath = await waitForBatchZip(control, 90_000, extensionLogs);
  const archive = await JSZip.loadAsync(await readFile(zipPath));
  const filenames = Object.values(archive.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name);
  expect(filenames).toHaveLength(80);
  expect(filenames.some((name) => /recommendation/i.test(name))).toBe(false);
  expect(filenames[0]).toMatch(/^001-/);
  expect(filenames.at(-1)).toMatch(/^080-/);
  const progressValues = await control.evaluate(() => (
    (globalThis as typeof globalThis & { pinpintoProgressValues?: number[] }).pinpintoProgressValues ?? []
  ));
  expect(progressValues.some((value) => value > 0)).toBe(true);

  await expect.poll(() => searchPage.locator('.pinvault-overlay-controls').count(), { timeout: 30_000 }).toBe(0);
  await expect.poll(async () => control.evaluate(async () => ({
    task: (await chrome.storage.session.get('pinpintoBatchTask')).pinpintoBatchTask ?? null,
    snapshot: (await chrome.runtime.sendMessage({ action: 'getBatchTaskState' })).snapshot ?? null
  }))).toEqual({ task: null, snapshot: null });
  expect(runtimeErrors).toEqual([]);

  await control.close();
  const reopenedControl = await openExtensionPage('popup.html');
  await expect.poll(async () => reopenedControl.evaluate(async () => ({
    task: (await chrome.storage.session.get('pinpintoBatchTask')).pinpintoBatchTask ?? null,
    snapshot: (await chrome.runtime.sendMessage({ action: 'getBatchTaskState' })).snapshot ?? null
  }))).toEqual({ task: null, snapshot: null });

  await testInfo.attach('downloaded-zip', { path: zipPath });
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test('single-image interruption stays retryable and succeeds on retry', async ({
  context,
  openExtensionPage,
  assetServer
}) => {
  assetServer.rejectRequests(true);
  await context.route('https://www.pinterest.com/search/pins/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: createPinterestSearchFixture(1, 0, assetServer.baseUrl)
  }));

  const page = await context.newPage();
  await page.goto('https://www.pinterest.com/search/pins/?q=single-retry', { waitUntil: 'domcontentloaded' });
  const singleButton = page.locator('.pinvault-single-download-btn');
  await expect(singleButton).toBeVisible();
  await singleButton.click();
  await expect(singleButton).toHaveText('Retry', { timeout: 30_000 });
  await expect(singleButton).toHaveAttribute('aria-label', /Download failed:/);

  assetServer.rejectRequests(false);
  await singleButton.click();
  await expect(singleButton).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.pinvault-overlay-controls')).toHaveCount(0);
  const control = await openExtensionPage('popup.html');
  const imagePath = await waitForCompletedImageDownload(control, 30_000);
  expect((await stat(imagePath)).size).toBeGreaterThan(0);
});

test('extension surfaces load without CSP errors and expose live progress semantics', async ({ context, extensionId }) => {
  for (const pagePath of ['popup.html', 'sidebar.html', 'welcome.html']) {
    const errors: string[] = [];
    const cspErrors: string[] = [];
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      const text = message.text();
      if (/content security policy|refused to (?:execute|load).*(?:script|style)/i.test(text)) {
        cspErrors.push(text);
      }
    });
    await page.goto(`chrome-extension://${extensionId}/${pagePath}`, { waitUntil: 'domcontentloaded' });

    if (pagePath !== 'welcome.html') {
      await expect(page.locator('#connectionStatus')).toHaveAttribute('role', 'status');
      await expect(page.locator('#connectionStatus')).toHaveAttribute('aria-live', 'polite');
      await expect(page.locator('#progressDetails')).toHaveAttribute('aria-atomic', 'true');
      await expect(page.locator('#progressFill')).toHaveAttribute('role', 'progressbar');
      await expect(page.locator('#progressFill')).toHaveAttribute('aria-valuenow', '0');

      const settingsButton = page.locator('#settingsBtn');
      await settingsButton.focus();
      await expect(settingsButton).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(settingsButton).toHaveAttribute('aria-expanded', 'true');
    }

    expect(errors).toEqual([]);
    expect(cspErrors).toEqual([]);
    await page.close();
  }
});

async function findPinterestTabId(controlPage: Page): Promise<number> {
  const tabId = await controlPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.startsWith('https://www.pinterest.com/search/pins/'))?.id ?? null;
  });
  expect(tabId).not.toBeNull();
  return tabId;
}

async function waitForBatchZip(controlPage: Page, timeoutMs: number, logs: string[]): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let lastDownloads = [];
  while (Date.now() < deadline) {
    const evidence = await controlPage.evaluate(async () => ({
      snapshot: (await chrome.runtime.sendMessage({ action: 'getBatchTaskState' })).snapshot ?? null,
      downloads: await chrome.downloads.search({ limit: 20 })
    }));
    lastState = evidence.snapshot;
    lastDownloads = evidence.downloads;
    const completedZip = evidence.downloads.find((download) => (
      download.state === 'complete'
      && download.exists === true
      && download.fileSize > 0
      && download.mime === 'application/zip'
    ));
    if (completedZip) return completedZip.filename;
    if (['failed', 'cancelled', 'interrupted'].includes(evidence.snapshot?.phase)) {
      throw new Error(`Batch reached ${evidence.snapshot.phase}: ${JSON.stringify({ evidence, logs })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for batch ZIP: ${JSON.stringify({ lastState, lastDownloads, logs })}`);
}

async function waitForCompletedImageDownload(controlPage: Page, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastDownloads = [];
  while (Date.now() < deadline) {
    lastDownloads = await controlPage.evaluate(async () => chrome.downloads.search({ limit: 20 }));
    const completed = lastDownloads.find((download) => (
      download.state === 'complete'
      && download.exists === true
      && download.fileSize > 0
      && download.mime.startsWith('image/')
    ));
    if (completed) return completed.filename;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for completed image download: ${JSON.stringify(lastDownloads)}`);
}

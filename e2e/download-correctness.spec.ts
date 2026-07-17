import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { test, expect } from './fixtures/extension';
import { getBatchTaskSnapshot, waitForTaskSnapshot } from './fixtures/batch-task';
import {
  captureDownloadCheckpoint,
  listDownloadsSince,
  waitForNewCompletedDownloads,
  type DownloadCheckpoint
} from './fixtures/extension-downloads';
import { createPinterestSearchFixture, fixtureImageSvg } from './fixtures/pinterest-search';

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
  const downloadCheckpoint = await captureDownloadCheckpoint(control);
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

  const zipDownload = await waitForBatchZip(control, downloadCheckpoint, 90_000, extensionLogs);
  const zipPath = zipDownload.filename;
  const archive = await JSZip.loadAsync(await readFile(zipPath));
  const filenames = Object.values(archive.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort();
  const archiveTimestamp = /^001-(\d{8}_\d{6})\.svg$/.exec(filenames[0])?.[1];
  expect(archiveTimestamp).toBeTruthy();
  expect(filenames).toEqual(Array.from({ length: 80 }, (_, index) => (
    `${String(index + 1).padStart(3, '0')}-${archiveTimestamp}.svg`
  )));
  expect(filenames.some((name) => /recommendation/i.test(name))).toBe(false);
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

test('single-image Blob retry falls back from failed original candidate and writes real bytes', async ({
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
  assetServer.rejectOriginals(true);
  const control = await openExtensionPage('popup.html');
  const downloadCheckpoint = await captureDownloadCheckpoint(control);
  await singleButton.click();
  await expect(singleButton).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.pinvault-overlay-controls')).toHaveCount(0);
  const imageDownload = (await waitForNewCompletedDownloads(control, downloadCheckpoint, {
    count: 1,
    timeoutMs: 30_000,
    matches: (download) => download.mime.startsWith('image/')
  }))[0];
  expect(imageDownload.error).toBeUndefined();
  expect(basename(imageDownload.filename)).toMatch(/^PinPinto-\d{8}_\d{6}\.svg$/);
  expect(await readFile(imageDownload.filename, 'utf8')).toBe(
    fixtureImageSvg('http://127.0.0.1/pinimg.com/236x/pinpinto-e2e/result-001.svg')
  );
  expect((await stat(imageDownload.filename)).size).toBeGreaterThan(0);
  assetServer.rejectOriginals(false);
});

test('manual ZIP and individual modes save deterministic image bytes', async ({ openExtensionPage, assetServer }) => {
  const control = await openExtensionPage('popup.html');
  const images = Array.from({ length: 3 }, (_, index) => {
    const padded = String(index + 1).padStart(3, '0');
    return {
      id: `manual-${padded}`,
      url: `${assetServer.baseUrl}/pinimg.com/236x/pinpinto-e2e/manual-${padded}.svg`,
      title: `Manual ${padded}`,
      originalFilename: `manual-${padded}.svg`
    };
  });

  const zipCheckpoint = await captureDownloadCheckpoint(control);
  const zipStart = await control.evaluate(async (imagesForDownload) => chrome.runtime.sendMessage({
    action: 'downloadImages',
    mode: 'manual',
    images: imagesForDownload,
    settings: { highQuality: true, downloadAsZip: true, maxConcurrentDownloads: 3 }
  }), images);
  expect(zipStart.accepted).toBe(true);
  const zipDownload = await waitForBatchZip(control, zipCheckpoint, 30_000, []);
  expect(basename(zipDownload.filename)).toMatch(/^PinPinto_\d{8}_\d{6}\.zip$/);
  const zipPath = zipDownload.filename;
  const archive = await JSZip.loadAsync(await readFile(zipPath));
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) => left.name.localeCompare(right.name));
  const zipEntryTimestamp = /^001-(\d{8}_\d{6})\.svg$/.exec(entries[0].name)?.[1];
  expect(zipEntryTimestamp).toBeTruthy();
  expect(entries.map((entry) => entry.name)).toEqual([
    `001-${zipEntryTimestamp}.svg`,
    `002-${zipEntryTimestamp}.svg`,
    `003-${zipEntryTimestamp}.svg`
  ]);
  await Promise.all(entries.map(async (entry, index) => {
    const padded = String(index + 1).padStart(3, '0');
    expect(await entry.async('string')).toBe(
      fixtureImageSvg(`http://127.0.0.1/pinimg.com/236x/pinpinto-e2e/manual-${padded}.svg`)
    );
  }));
  await waitForTaskSnapshot(control, (snapshot) => snapshot === null, 30_000);

  const individualCheckpoint = await captureDownloadCheckpoint(control);
  const individualStart = await control.evaluate(async (imagesForDownload) => chrome.runtime.sendMessage({
    action: 'downloadImages',
    mode: 'manual',
    images: imagesForDownload,
    settings: { highQuality: true, downloadAsZip: false, maxConcurrentDownloads: 3 }
  }), images);
  expect(individualStart.accepted).toBe(true);
  const downloads = await waitForNewCompletedDownloads(control, individualCheckpoint, {
    count: 3,
    timeoutMs: 30_000,
    matches: (download) => download.mime.startsWith('image/')
  });
  const indexedDownloads = downloads.sort((left, right) => (
    basename(left.filename).localeCompare(basename(right.filename))
  ));
  const firstFilename = basename(indexedDownloads[0].filename);
  const timestamp = /^001-(\d{8}_\d{6})\.svg$/.exec(firstFilename)?.[1];
  expect(timestamp).toBeTruthy();
  expect(indexedDownloads.map((download) => basename(download.filename))).toEqual([
    `001-${timestamp}.svg`,
    `002-${timestamp}.svg`,
    `003-${timestamp}.svg`
  ]);
  await Promise.all(indexedDownloads.map(async (download, index) => {
    const padded = String(index + 1).padStart(3, '0');
    expect(await readFile(download.filename, 'utf8')).toBe(
      fixtureImageSvg(`http://127.0.0.1/pinimg.com/236x/pinpinto-e2e/manual-${padded}.svg`)
    );
  }));
});

test('automatic graceful stop preserves remaining cards while immediate cancel leaves the task cancelled', async ({
  context,
  openExtensionPage,
  assetServer
}) => {
  await context.route('https://www.pinterest.com/search/pins/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: createPinterestSearchFixture(4, 0, assetServer.baseUrl)
  }));

  const page = await context.newPage();
  await page.goto('https://www.pinterest.com/search/pins/?q=auto-stop', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.locator('.pinvault-overlay-controls').count()).toBe(4);
  const control = await openExtensionPage('popup.html');
  const targetTabId = await findPinterestTabId(control);
  const gracefulCheckpoint = await captureDownloadCheckpoint(control);
  assetServer.pauseResponses();
  try {
    const start = await control.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
      action: 'downloadImages',
      mode: 'auto',
      targetTabId: tabId,
      autoBatchLimit: 2,
      settings: { highQuality: true, autoBatchLimit: 2, maxConcurrentDownloads: 2 }
    }), { tabId: targetTabId });
    expect(start.accepted).toBe(true);
    await assetServer.waitForHeldRequests(1, 30_000, (url) => url.includes('/originals/'));
    const stop = await control.evaluate(async ({ jobId }) => chrome.runtime.sendMessage({
      action: 'stopAutoBatchAfterCurrent',
      jobId,
      continueAutoScroll: true
    }), { jobId: start.jobId });
    expect(stop.success).toBe(true);
    await waitForTaskSnapshot(control, (snapshot) => (
      snapshot?.jobId === start.jobId && snapshot.autoStopRequested === true
    ), 30_000);
  } finally {
    assetServer.resumeResponses();
  }
  await waitForBatchZip(control, gracefulCheckpoint, 45_000, []);
  await expect.poll(async () => control.evaluate(async () => (
    (await chrome.runtime.sendMessage({ action: 'getBatchTaskState' })).snapshot ?? null
  )), { timeout: 45_000 }).toBeNull();
  await expect.poll(() => page.locator('.pinvault-overlay-controls').count(), { timeout: 30_000 }).toBe(2);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.locator('.pinvault-overlay-controls').count()).toBe(4);
  let cancelJobId = '';
  assetServer.pauseResponses();
  try {
    const cancelStart = await control.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
      action: 'downloadImages',
      mode: 'auto',
      targetTabId: tabId,
      autoBatchLimit: 2,
      settings: { highQuality: true, autoBatchLimit: 2, maxConcurrentDownloads: 2 }
    }), { tabId: targetTabId });
    expect(cancelStart.accepted).toBe(true);
    cancelJobId = cancelStart.jobId;
    await assetServer.waitForHeldRequests(1, 30_000, (url) => url.includes('/originals/'));
    const cancel = await control.evaluate(async ({ jobId }) => chrome.runtime.sendMessage({
      action: 'cancelCurrentBatch',
      jobId
    }), { jobId: cancelStart.jobId });
    expect(cancel.success).toBe(true);
  } finally {
    assetServer.resumeResponses();
  }
  const cancelled = await waitForTaskSnapshot(control, (snapshot) => (
    snapshot?.jobId === cancelJobId && snapshot.phase === 'cancelled'
  ), 30_000);
  expect(cancelled?.phase).toBe('cancelled');
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

async function waitForBatchZip(
  controlPage: Page,
  checkpoint: DownloadCheckpoint,
  timeoutMs: number,
  logs: string[]
): Promise<chrome.downloads.DownloadItem> {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let lastDownloads = [];
  while (Date.now() < deadline) {
    const [snapshot, downloads] = await Promise.all([
      getBatchTaskSnapshot(controlPage),
      listDownloadsSince(controlPage, checkpoint)
    ]);
    const evidence = { snapshot, downloads };
    lastState = evidence.snapshot;
    lastDownloads = evidence.downloads;
    const completedZip = evidence.downloads.find((download) => (
      download.state === 'complete'
      && download.exists === true
      && download.fileSize > 0
      && download.mime === 'application/zip'
    ));
    if (completedZip) return completedZip;
    if (['failed', 'cancelled', 'interrupted'].includes(evidence.snapshot?.phase)) {
      throw new Error(`Batch reached ${evidence.snapshot.phase}: ${JSON.stringify({ evidence, logs })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for batch ZIP: ${JSON.stringify({ lastState, lastDownloads, logs })}`);
}

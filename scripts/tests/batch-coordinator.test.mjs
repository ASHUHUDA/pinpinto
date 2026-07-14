import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function createStorage(initialSnapshot = null) {
  let snapshot = initialSnapshot;
  return {
    async get() { return { pinpintoBatchTask: snapshot }; },
    async set(value) { snapshot = value.pinpintoBatchTask; }
  };
}

function persistedSnapshot(overrides = {}) {
  return {
    jobId: 'restored-job',
    mode: 'manual',
    targetTabId: 9,
    phase: 'downloading',
    batchCursor: 1,
    progress: 100,
    details: 'waiting',
    totalImages: 1,
    zippedCount: 0,
    fallbackCount: 0,
    unresolvedCount: 0,
    associatedDownloadIds: [44],
    pendingFallbackDownloadIds: [44],
    autoSessionFinished: true,
    autoBatchLimit: 100,
    settings: { highQuality: true },
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

function imageResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'image/jpeg' },
    async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; }
  };
}

function createHost(broadcasts) {
  return {
    activeDownloads: new Map(),
    maxConcurrentDownloads: 2,
    normalizeImageUrlForDeduplication(image) { return typeof image === 'string' ? image : image.url; },
    getDownloadCandidateUrls(url) { return [url]; },
    buildIndexedFilename(sequence, timestamp) { return `${String(sequence).padStart(3, '0')}-${timestamp}.jpg`; },
    extractFilenameFromUrl(url) { return url.split('/').pop(); },
    formatLocalTimestamp() { return '20260714_190000'; },
    broadcast(message) { broadcasts.push(message); }
  };
}

async function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

test('manual coordinator start returns a job immediately and completes without an open panel', async () => {
  const storage = createStorage();
  const broadcasts = [];
  const downloadCalls = [];
  globalThis.fetch = async () => imageResponse();
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      async download(options) { downloadCalls.push(options); return 701; },
      async cancel() {},
      async search() { return []; }
    },
    tabs: { async sendMessage() { return { success: true }; } }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));

  const startResult = await coordinator.start({
    mode: 'manual',
    targetTabId: 9,
    images: [{ id: 'a', url: 'https://example.com/a.jpg' }],
    settings: { highQuality: true }
  });

  assert.equal(startResult.accepted, true);
  assert.equal(typeof startResult.jobId, 'string');
  const completed = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.phase === 'completed' ? snapshot : null;
  });
  assert.equal(completed.zippedCount, 1);
  assert.equal(completed.fallbackCount, 0);
  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0].filename, 'PinPinto/PinPinto_20260714_190000.zip');
  assert.equal(broadcasts.every((message) => message.jobId === startResult.jobId), true);
});

test('fallback completion settles the persisted task exactly once', async () => {
  const storage = createStorage();
  const broadcasts = [];
  let nextDownloadId = 801;
  globalThis.fetch = async () => { throw new Error('blocked'); };
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      async download() { return nextDownloadId++; },
      async cancel() {},
      async search() { throw new Error('search temporarily unavailable'); }
    },
    tabs: { async sendMessage() { return { success: true }; } }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const startResult = await coordinator.start({
    mode: 'manual',
    targetTabId: 9,
    images: [{ id: 'a', url: 'https://example.com/a.jpg' }],
    settings: { highQuality: true }
  });
  const downloading = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.pendingFallbackDownloadIds.length === 1 ? snapshot : null;
  });
  const fallbackId = downloading.pendingFallbackDownloadIds[0];
  const downloadInfo = host.activeDownloads.get(fallbackId);

  coordinator.handleDownloadChange({ id: fallbackId, state: { current: 'complete' } }, downloadInfo);
  coordinator.handleDownloadChange({ id: fallbackId, state: { current: 'complete' } }, downloadInfo);
  const completed = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.phase === 'completed' ? snapshot : null;
  });

  assert.equal(completed.jobId, startResult.jobId);
  assert.equal(completed.fallbackCount, 1);
  assert.equal(completed.unresolvedCount, 0);
  assert.deepEqual(completed.pendingFallbackDownloadIds, []);
});

test('automatic coordinator advances only after each explicit content window and finishes the tail', async () => {
  const storage = createStorage();
  const broadcasts = [];
  const tabMessages = [];
  let nextDownloadId = 901;
  globalThis.fetch = async () => imageResponse();
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      async download() { return nextDownloadId++; },
      async cancel() {},
      async search() { return []; }
    },
    tabs: {
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
        return { success: true };
      }
    }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  const startResult = await coordinator.start({
    mode: 'auto',
    targetTabId: 19,
    settings: { highQuality: true, autoBatchLimit: 2 },
    autoBatchLimit: 2
  });
  await waitFor(() => tabMessages.some((entry) => entry.message.action === 'startAutoBatchSession'));

  assert.equal(await coordinator.acceptAutoBatchWindow({
    jobId: startResult.jobId,
    images: [
      { id: 'a', url: 'https://example.com/a.jpg' },
      { id: 'b', url: 'https://example.com/b.jpg' }
    ],
    settings: { highQuality: true },
    startIndex: 0,
    endIndex: 2,
    finalWindow: false
  }, 19), true);
  await waitFor(() => tabMessages.some((entry) => entry.message.action === 'resumeAutoBatchSession'));

  assert.equal(await coordinator.acceptAutoBatchWindow({
    jobId: startResult.jobId,
    images: [{ id: 'c', url: 'https://example.com/c.jpg' }],
    settings: { highQuality: true },
    startIndex: 2,
    endIndex: 3,
    finalWindow: true
  }, 19), true);
  const completed = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.phase === 'completed' ? snapshot : null;
  });

  assert.equal(completed.batchCursor, 3);
  assert.equal(completed.zippedCount, 3);
  assert.equal(tabMessages.some((entry) => entry.message.action === 'finishAutoBatchSession'), true);
});

test('cancelling an in-flight fetch does not create a late fallback download', async () => {
  const storage = createStorage();
  const broadcasts = [];
  const downloadCalls = [];
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      async download(options) { downloadCalls.push(options); return 1001; },
      async cancel() {},
      async search() { return []; }
    },
    tabs: { async sendMessage() { return { success: true }; } }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  const started = await coordinator.start({
    mode: 'manual',
    targetTabId: 9,
    images: [{ id: 'a', url: 'https://example.com/a.jpg' }],
    settings: { highQuality: true }
  });
  await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'fetching');

  assert.equal(await coordinator.cancel('another-job'), false);
  assert.equal(await coordinator.cancel(started.jobId), true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal((await coordinator.getSnapshot()).phase, 'cancelled');
  assert.deepEqual(downloadCalls, []);
});

test('95 percent zip progress remains compressing until the download id is persisted', async () => {
  const storage = createStorage();
  const broadcasts = [];
  let releaseDownload;
  globalThis.fetch = async () => imageResponse();
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      download() { return new Promise((resolve) => { releaseDownload = () => resolve(1101); }); },
      async cancel() {},
      async search() { return []; }
    },
    tabs: { async sendMessage() { return { success: true }; } }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  await coordinator.start({
    mode: 'manual',
    targetTabId: 9,
    images: [{ id: 'a', url: 'https://example.com/a.jpg' }],
    settings: { highQuality: true }
  });
  const compressing = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.phase === 'compressing'
      && snapshot.progress >= 95
      && typeof releaseDownload === 'function'
      ? snapshot
      : null;
  });

  assert.deepEqual(compressing.associatedDownloadIds, []);
  releaseDownload();
  const completed = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.phase === 'completed' ? snapshot : null;
  });
  assert.deepEqual(completed.associatedDownloadIds, [1101]);
});

test('cancelling while the zip download request is pending cancels the late download id', async () => {
  const storage = createStorage();
  const broadcasts = [];
  const cancelCalls = [];
  let releaseDownload;
  globalThis.fetch = async () => imageResponse();
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      download() { return new Promise((resolve) => { releaseDownload = () => resolve(1201); }); },
      async cancel(downloadId) { cancelCalls.push(downloadId); },
      async search() { return []; }
    },
    tabs: { async sendMessage() { return { success: true }; } }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  const started = await coordinator.start({
    mode: 'manual',
    targetTabId: 9,
    images: [{ id: 'a', url: 'https://example.com/a.jpg' }],
    settings: { highQuality: true }
  });
  await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.phase === 'compressing'
      && snapshot.progress >= 95
      && typeof releaseDownload === 'function';
  });

  assert.equal(await coordinator.cancel(started.jobId), true);
  releaseDownload();
  await waitFor(() => cancelCalls.includes(1201));

  assert.equal((await coordinator.getSnapshot()).phase, 'cancelled');
  assert.deepEqual(cancelCalls, [1201]);
});

test('restored fallback downloads settle from onChanged without an in-memory download map', async () => {
  const storage = createStorage(persistedSnapshot());
  const broadcasts = [];
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      async download() { throw new Error('not expected'); },
      async cancel() {},
      async search() { return [{ id: 44, state: 'in_progress' }]; }
    },
    tabs: { async sendMessage() { return { success: true }; } }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'downloading');

  coordinator.handleDownloadChange({ id: 44, state: { current: 'complete' } }, undefined);
  const completed = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.phase === 'completed' ? snapshot : null;
  });

  assert.equal(completed.fallbackCount, 1);
  assert.deepEqual(completed.pendingFallbackDownloadIds, []);
});

test('interrupted fallback is final and increments unresolved without retry', async () => {
  const storage = createStorage(persistedSnapshot());
  const broadcasts = [];
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      async download() { throw new Error('not expected'); },
      async cancel() {},
      async search() { return [{ id: 44, state: 'in_progress' }]; }
    },
    tabs: { async sendMessage() { return { success: true }; } }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'downloading');

  coordinator.handleDownloadChange({ id: 44, state: { current: 'interrupted' } }, undefined);
  const completed = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.phase === 'completed' ? snapshot : null;
  });

  assert.equal(completed.fallbackCount, 0);
  assert.equal(completed.unresolvedCount, 1);
  assert.deepEqual(completed.pendingFallbackDownloadIds, []);
});

test('closing the target tab interrupts an active automatic task', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      async download() { return 1301; },
      async cancel() {},
      async search() { return []; }
    },
    tabs: { async sendMessage() { return { success: true }; } }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  await coordinator.start({
    mode: 'auto',
    targetTabId: 31,
    settings: { autoBatchLimit: 100 }
  });
  await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'scrolling');

  await coordinator.handleTargetTabClosed(99);
  assert.equal((await coordinator.getSnapshot()).phase, 'scrolling');
  await coordinator.handleTargetTabClosed(31);
  const interrupted = await coordinator.getSnapshot();

  assert.equal(interrupted.phase, 'interrupted');
  assert.match(interrupted.details, /标签页已关闭/);
});

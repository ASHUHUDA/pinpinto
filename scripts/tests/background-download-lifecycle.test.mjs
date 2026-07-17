import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

const OFFSCREEN_TARGET = 'pinpinto-blob-offscreen';

function installBackgroundChrome(options = {}) {
  const sessionValues = { ...(options.sessionValues ?? {}) };
  const tabMessages = [];
  const downloadCalls = [];
  const blobCalls = [];
  const blobJobs = new Map((options.initialBlobJobs ?? []).map((jobId) => [jobId, { jobId }]));
  const downloadStates = new Map();
  let onMessage;
  let onDownloadChanged;
  let onTabRemoved;
  let nextDownloadId = 1;
  let rejectNextDownload = false;
  let failNextBlob = false;

  const area = {
    async get(key) {
      if (typeof key === 'string') return { [key]: sessionValues[key] };
      return { ...sessionValues };
    },
    async set(update) { Object.assign(sessionValues, update); },
    async remove(key) { delete sessionValues[key]; }
  };

  async function handleOffscreenMessage(message) {
    blobCalls.push(message);
    switch (message.operation) {
      case 'start': {
        const failed = failNextBlob;
        failNextBlob = false;
        blobJobs.set(message.request.jobId, { request: message.request, failed });
        return {
          ok: true,
          value: {
            jobId: message.request.jobId,
            state: 'running',
            completedEntries: 0,
            totalEntries: message.request.entries.length,
            zipProgress: 0
          }
        };
      }
      case 'result': {
        const job = blobJobs.get(message.jobId);
        if (!job) return { ok: false, error: 'missing Blob job' };
        const entry = job.request?.entries[0];
        return {
          ok: true,
          value: job.failed
            ? {
                jobId: message.jobId,
                output: 'file',
                zippedEntries: [],
                failedEntries: [{ ...entry, error: 'all candidates failed' }]
              }
            : {
                jobId: message.jobId,
                output: 'file',
                objectUrl: `blob:${message.jobId}`,
                contentType: 'image/jpeg',
                zippedEntries: [{ ...entry, resolvedUrl: entry?.candidateUrls.at(-1) }],
                failedEntries: []
              }
        };
      }
      case 'getStatus':
        return { ok: true, value: blobJobs.has(message.jobId) ? { jobId: message.jobId, state: 'completed' } : null };
      case 'cancel':
        return { ok: true, value: blobJobs.has(message.jobId) };
      case 'release': {
        const removed = blobJobs.delete(message.jobId);
        return { ok: true, value: removed };
      }
      case 'listActiveJobs':
        return { ok: true, value: [...blobJobs.keys()] };
    }
  }

  globalThis.chrome = {
    runtime: {
      id: 'pinpinto-test',
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { onMessage = listener; } },
      async sendMessage(message) {
        if (message?.target === OFFSCREEN_TARGET) return handleOffscreenMessage(message);
        return undefined;
      },
      getURL(path) { return `chrome-extension://pinpinto-test/${path}`; },
      async getContexts() {
        return [{
          contextType: 'OFFSCREEN_DOCUMENT',
          documentUrl: 'chrome-extension://pinpinto-test/offscreen.html'
        }];
      },
      getManifest() { return { content_scripts: [{ js: ['content.js'] }] }; },
      openOptionsPage() {}
    },
    offscreen: {
      Reason: { BLOBS: 'BLOBS' },
      async createDocument() {}
    },
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener(listener) { onTabRemoved = listener; } },
      async query() { return []; },
      async sendMessage(tabId, message) { tabMessages.push({ tabId, message }); return { success: true }; }
    },
    contextMenus: {
      removeAll(callback) { callback?.(); },
      create() {},
      onClicked: { addListener() {} }
    },
    downloads: {
      onChanged: { addListener(listener) { onDownloadChanged = listener; } },
      onDeterminingFilename: { addListener() {} },
      async download(downloadOptions) {
        downloadCalls.push(downloadOptions);
        if (rejectNextDownload) {
          rejectNextDownload = false;
          throw new Error('browser rejected');
        }
        const downloadId = nextDownloadId++;
        downloadStates.set(downloadId, 'in_progress');
        return downloadId;
      },
      async search({ id }) {
        const state = downloadStates.get(id) ?? 'in_progress';
        return state === 'missing' ? [] : [{ id, state }];
      },
      async cancel(id) { downloadStates.set(id, 'interrupted'); }
    },
    storage: { session: area, local: area, sync: area },
    scripting: { async executeScript() { return [{ result: true }]; } }
  };

  return {
    sessionValues,
    tabMessages,
    downloadCalls,
    blobCalls,
    blobJobs,
    failNextBlob() { failNextBlob = true; },
    rejectNextDownload() { rejectNextDownload = true; },
    emit(delta) {
      if (delta.state?.current) downloadStates.set(delta.id, delta.state.current);
      onDownloadChanged(delta);
    },
    closeTab(tabId) { onTabRemoved(tabId); },
    async message(request, tabId = 7) {
      return new Promise((resolve) => onMessage(request, { tab: { id: tabId } }, resolve));
    }
  };
}

async function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for background settlement');
}

function request(imageId, overrides = {}) {
  return {
    action: 'downloadImage',
    imageData: {
      id: imageId,
      url: 'https://i.pinimg.com/236x/aa/bb/example.jpg',
      title: 'A',
      originalFilename: 'a.jpg'
    },
    settings: {
      highQuality: true,
      singleImageDownloadMethod: 'browser',
      ...overrides
    }
  };
}

test('browser single uses a file Blob, remains pending, and releases its lease on terminal settlement', async () => {
  const harness = installBackgroundChrome();
  await loadTsModule('src/background.ts');

  const accepted = await harness.message(request('img-1'));
  assert.deepEqual(accepted, {
    success: true,
    method: 'browser',
    state: 'pending',
    downloadId: 1
  });

  const start = harness.blobCalls.find(({ operation }) => operation === 'start');
  assert.equal(start.request.output, 'file');
  assert.equal(start.request.entries.length, 1);
  assert.deepEqual(start.request.entries[0].candidateUrls, [
    'https://i.pinimg.com/originals/aa/bb/example.jpg',
    'https://i.pinimg.com/236x/aa/bb/example.jpg'
  ]);
  assert.match(start.request.jobId, /^single:.+:file$/);
  assert.deepEqual(harness.downloadCalls, [{
    url: `blob:${start.request.jobId}`,
    filename: harness.downloadCalls[0].filename,
    conflictAction: 'uniquify',
    saveAs: false
  }]);
  assert.match(harness.downloadCalls[0].filename, /^PinPinto\/PinPinto-\d{8}_\d{6}\.jpg$/);
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads.map((entry) => ({
    downloadId: entry.downloadId,
    targetTabId: entry.targetTabId,
    imageId: entry.imageId,
    state: entry.state,
    blobLeaseJobId: entry.blobLeaseJobId
  })), [{
    downloadId: 1,
    targetTabId: 7,
    imageId: 'img-1',
    state: 'pending',
    blobLeaseJobId: start.request.jobId
  }]);

  harness.emit({ id: 1, state: { current: 'interrupted' }, error: { current: 'FILE_BLOCKED' } });
  const interrupted = await waitFor(() => harness.tabMessages.find(({ message }) =>
    message.action === 'settleSingleDownload' && message.state === 'interrupted'));
  assert.equal(interrupted.message.error, 'FILE_BLOCKED');
  await waitFor(() => !harness.blobJobs.has(start.request.jobId));
  assert.equal(harness.blobCalls.filter(({ operation, jobId }) =>
    operation === 'release' && jobId === start.request.jobId).length, 1);
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads, []);
});

test('browser single fetch failure is retryable and never submits a direct image URL', async () => {
  const harness = installBackgroundChrome();
  harness.failNextBlob();
  await loadTsModule('src/background.ts');

  const rejected = await harness.message(request('img-2'));

  assert.equal(rejected.success, false);
  assert.equal(rejected.method, 'browser');
  assert.equal(rejected.state, 'rejected');
  assert.match(rejected.error, /all candidates failed/);
  assert.deepEqual(harness.downloadCalls, []);
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads ?? [], []);
  const start = harness.blobCalls.find(({ operation }) => operation === 'start');
  assert.equal(harness.blobCalls.filter(({ operation, jobId }) =>
    operation === 'release' && jobId === start.request.jobId).length, 1);
});

test('browser rejection after Blob creation releases the lease without registry state', async () => {
  const harness = installBackgroundChrome();
  harness.rejectNextDownload();
  await loadTsModule('src/background.ts');

  const rejected = await harness.message(request('img-rejected'));
  const start = harness.blobCalls.find(({ operation }) => operation === 'start');

  assert.deepEqual(rejected, {
    success: false,
    method: 'browser',
    state: 'rejected',
    error: 'browser rejected'
  });
  assert.equal(harness.downloadCalls.length, 1);
  assert.match(harness.downloadCalls[0].url, /^blob:single:/);
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads ?? [], []);
  assert.equal(harness.blobCalls.filter(({ operation, jobId }) =>
    operation === 'release' && jobId === start.request.jobId).length, 1);
});

test('external single submits the best URL without controlled registry tracking', async () => {
  const harness = installBackgroundChrome();
  await loadTsModule('src/background.ts');

  const submitted = await harness.message(request('img-3', { singleImageDownloadMethod: 'external' }));
  assert.deepEqual(submitted, { success: true, method: 'external', state: 'submitted' });
  assert.equal(harness.downloadCalls[0].url, 'https://i.pinimg.com/originals/aa/bb/example.jpg');
  assert.equal(harness.blobCalls.some(({ operation }) => operation === 'start'), false);
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads ?? [], []);

  harness.emit({ id: 1, state: { current: 'complete' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.tabMessages.some(({ message }) => message.action === 'settleSingleDownload'), false);

  harness.rejectNextDownload();
  const rejected = await harness.message(request('img-4', { singleImageDownloadMethod: 'external' }));
  assert.deepEqual(rejected, {
    success: false,
    method: 'external',
    state: 'rejected',
    error: 'Not accepted. Switch to Browser'
  });
});

test('startup preserves active single and individual leases while cleaning their orphans', async () => {
  const activeSingleJob = 'single:active:file';
  const orphanSingleJob = 'single:orphan:file';
  const activeIndividualJob = 'batch-1:file:1';
  const harness = installBackgroundChrome({
    sessionValues: {
      pinpintoSingleDownloads: [{
        downloadId: 99,
        targetTabId: 7,
        imageId: 'img-active',
        requestedFilename: 'PinPinto/a.jpg',
        blobLeaseJobId: activeSingleJob,
        state: 'pending',
        createdAt: 1
      }],
      pinpintoBatchTask: {
        jobId: 'batch-1',
        mode: 'manual',
        outputMode: 'individual',
        targetTabId: 7,
        phase: 'downloading',
        batchCursor: 0,
        progress: 50,
        details: 'working',
        totalImages: 1,
        zippedCount: 0,
        fallbackCount: 0,
        unresolvedCount: 0,
        individualCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        associatedDownloadIds: [],
        pendingFallbackDownloadIds: [],
        activeWindow: {
          windowId: 'batch-1:0:1', startOffset: 0, endOffset: 1, finalWindow: true,
          expectedDownloadIds: [], downloadStates: {}, totalCount: 1, zippedCount: 0,
          fallbackCount: 0, unresolvedCount: 0, hostJobId: null, hostState: 'fetching',
          individualQueue: [{
            imageId: 'img-1', sequence: 1, sourceUrl: 'https://example.com/a.jpg',
            candidateUrls: ['https://example.com/a.jpg'], filename: '001-a.jpg',
            state: 'preparing', blobLeaseJobId: activeIndividualJob
          }],
          contentCommitState: {
            state: 'acknowledged', startOffset: 0, endOffset: 1,
            acknowledgedBaseOffset: 1, retainedCount: null
          }
        },
        autoSessionFinished: true,
        autoBatchLimit: 100,
        autoBatchTotalBatches: 0,
        autoBatchCompletedBatches: 0,
        autoStopRequested: false,
        continueAutoScrollAfterStop: false,
        settings: {},
        createdAt: 1,
        updatedAt: 2
      }
    },
    initialBlobJobs: [activeSingleJob, orphanSingleJob, activeIndividualJob, 'batch-orphan:zip:0:1']
  });
  await loadTsModule('src/background.ts');

  await waitFor(() => !harness.blobJobs.has(orphanSingleJob));
  assert.equal(harness.blobJobs.has(activeSingleJob), true);
  assert.equal(harness.blobJobs.has(activeIndividualJob), true);
  assert.equal(harness.blobJobs.has('batch-orphan:zip:0:1'), false);

  harness.emit({ id: 99, state: { current: 'complete' } });
  await waitFor(() => !harness.blobJobs.has(activeSingleJob));
  assert.equal(harness.blobCalls.filter(({ operation, jobId }) =>
    operation === 'release' && jobId === activeSingleJob).length, 1);
});

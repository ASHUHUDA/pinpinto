import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function entry(sequence, state, extra = {}) {
  return {
    imageId: `img-${sequence}`,
    sequence,
    sourceUrl: `https://example.com/${sequence}.jpg`,
    candidateUrls: [`https://example.com/${sequence}-high.jpg`, `https://example.com/${sequence}.jpg`],
    filename: `${String(sequence).padStart(3, '0')}-batch.jpg`,
    state,
    ...extra
  };
}

function createSnapshot(jobId = 'individual-job') {
  return {
    jobId,
    settings: { highQuality: true },
    individualCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    activeWindow: {
      individualQueue: []
    }
  };
}

function clone(value) {
  return structuredClone(value);
}

function createHarness(overrides = {}) {
  let snapshot = overrides.snapshot ?? createSnapshot();
  let maxOccupied = 0;
  const finished = [];
  const registered = [];
  const settled = [];
  const completedImages = [];
  const cancelledDownloads = [];
  const filenameCalls = [];
  let timestampCalls = 0;

  const dependencies = {
    blobHost: overrides.blobHost,
    getSnapshot: () => clone(snapshot),
    async mutateSnapshot(jobId, updater) {
      assert.equal(jobId, snapshot.jobId);
      const patch = updater(clone(snapshot));
      snapshot = { ...snapshot, ...patch };
      const occupied = snapshot.activeWindow.individualQueue
        .filter(({ state }) => state === 'preparing' || state === 'pending').length;
      maxOccupied = Math.max(maxOccupied, occupied);
      return clone(snapshot);
    },
    normalizeImageUrlForDeduplication(image) {
      return typeof image === 'string' ? image : image.url ?? '';
    },
    getDownloadCandidateUrls(url) {
      return [`${url}?quality=high`, url];
    },
    buildIndexedFilename(sequence, timestamp, url, originalFilename) {
      filenameCalls.push({ sequence, timestamp, url, originalFilename });
      return `${String(sequence).padStart(3, '0')}-${timestamp}.jpg`;
    },
    extractFilenameFromUrl(url) {
      return url.split('/').at(-1) ?? 'image.jpg';
    },
    formatLocalTimestamp() {
      timestampCalls++;
      return '20260716_120000';
    },
    requestDownload: overrides.requestDownload,
    async cancelDownload(downloadId) { cancelledDownloads.push(downloadId); },
    searchDownload: overrides.searchDownload ?? (async () => [{ state: 'in_progress' }]),
    onDownloadRegistered(event) { registered.push(event); },
    onDownloadSettled(event) { settled.push(event); },
    onImageComplete(event) { completedImages.push(event); },
    onQueueFinished(summary) { finished.push(summary); }
  };

  return {
    dependencies,
    snapshot: () => clone(snapshot),
    maxOccupied: () => maxOccupied,
    finished,
    registered,
    settled,
    completedImages,
    cancelledDownloads,
    filenameCalls,
    timestampCalls: () => timestampCalls
  };
}

async function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for individual queue state');
}

function successfulBlobResult(request) {
  const item = request.entries[0];
  return {
    jobId: request.jobId,
    output: 'file',
    objectUrl: `blob:test/${request.jobId}`,
    contentType: 'image/jpeg',
    zippedEntries: [{ ...item, resolvedUrl: item.candidateUrls.at(-1) }],
    failedEntries: []
  };
}

test('start persists the full indexed queue before pumping at most three slots, and cancel releases all work', async () => {
  const requests = [];
  const jobs = new Map();
  const cancelCalls = [];
  const releaseCalls = [];
  const blobHost = {
    async start(request) {
      requests.push(request);
      jobs.set(request.jobId, deferred());
      return { jobId: request.jobId, state: 'running', completedEntries: 0, totalEntries: 1, zipProgress: 0 };
    },
    result(jobId) { return jobs.get(jobId).promise; },
    async cancel(jobId) {
      cancelCalls.push(jobId);
      jobs.get(jobId)?.reject(new Error('cancelled'));
      return true;
    },
    async release(jobId) { releaseCalls.push(jobId); return true; }
  };
  const harness = createHarness({
    blobHost,
    async requestDownload() { throw new Error('download must not start before Blob completion'); }
  });
  const { IndividualDownloadQueue } = await loadTsModule('src/background/individual-download-queue.ts');
  const queue = new IndividualDownloadQueue(harness.dependencies);
  const images = Array.from({ length: 5 }, (_, index) => ({
    id: `img-${index + 1}`,
    url: `https://example.com/${index + 1}.jpg`,
    originalFilename: `${index + 1}.jpg`
  }));

  await queue.start({ jobId: 'individual-job', images, settings: { highQuality: true } });
  await waitFor(() => requests.length === 3);

  assert.equal(harness.timestampCalls(), 1);
  assert.equal(harness.filenameCalls.length, 5);
  assert.deepEqual(harness.snapshot().activeWindow.individualQueue.map(({ state }) => state), [
    'preparing', 'preparing', 'preparing', 'queued', 'queued'
  ]);
  assert.deepEqual(requests.map(({ jobId, output, maxConcurrency, entries }) => ({
    jobId, output, maxConcurrency, entryCount: entries.length
  })), [
    { jobId: 'individual-job:file:1', output: 'file', maxConcurrency: 1, entryCount: 1 },
    { jobId: 'individual-job:file:2', output: 'file', maxConcurrency: 1, entryCount: 1 },
    { jobId: 'individual-job:file:3', output: 'file', maxConcurrency: 1, entryCount: 1 }
  ]);
  assert.equal(harness.maxOccupied(), 3);

  await queue.start({ jobId: 'individual-job', images, settings: { highQuality: true } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 3);

  await queue.cancel('individual-job');

  assert.deepEqual(harness.snapshot().activeWindow.individualQueue.map(({ state }) => state), [
    'cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled'
  ]);
  assert.deepEqual(new Set(cancelCalls), new Set([
    'individual-job:file:1', 'individual-job:file:2', 'individual-job:file:3'
  ]));
  assert.deepEqual(new Set(releaseCalls), new Set(cancelCalls));
  assert.deepEqual(harness.finished, [{
    jobId: 'individual-job', total: 5, success: 0, failed: 0, cancelled: 5
  }]);
});

test('cancel stops queued dispatch, cancels pending Chrome IDs, and releases each file lease once', async () => {
  const requests = new Map();
  const blobCancelCalls = [];
  const releaseCalls = [];
  const requestedSequences = [];
  const blobHost = {
    async start(request) {
      requests.set(request.jobId, request);
      return { jobId: request.jobId, state: 'running' };
    },
    async result(jobId) {
      return successfulBlobResult(requests.get(jobId));
    },
    async cancel(jobId) { blobCancelCalls.push(jobId); return true; },
    async release(jobId) { releaseCalls.push(jobId); return true; }
  };
  const harness = createHarness({
    blobHost,
    async requestDownload({ entry }) {
      requestedSequences.push(entry.sequence);
      return 900 + entry.sequence;
    }
  });
  const { IndividualDownloadQueue } = await loadTsModule('src/background/individual-download-queue.ts');
  const queue = new IndividualDownloadQueue(harness.dependencies);

  await queue.start({
    jobId: 'individual-job',
    images: Array.from({ length: 5 }, (_, index) => ({
      id: `img-${index + 1}`,
      url: `https://example.com/${index + 1}.jpg`
    })),
    settings: {}
  });
  await waitFor(() => {
    const states = harness.snapshot().activeWindow.individualQueue.map(({ state }) => state);
    return states.filter((state) => state === 'pending').length === 3
      && states.filter((state) => state === 'queued').length === 2;
  });

  await queue.cancel('individual-job');

  assert.deepEqual(requestedSequences, [1, 2, 3]);
  assert.deepEqual(harness.cancelledDownloads, [901, 902, 903]);
  assert.deepEqual(harness.snapshot().activeWindow.individualQueue.map(({ state }) => state), [
    'cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled'
  ]);
  assert.deepEqual(blobCancelCalls.sort(), [
    'individual-job:file:1', 'individual-job:file:2', 'individual-job:file:3'
  ]);
  assert.deepEqual(releaseCalls.sort(), [
    'individual-job:file:1', 'individual-job:file:2', 'individual-job:file:3'
  ]);
  assert.equal(new Set(harness.cancelledDownloads).size, harness.cancelledDownloads.length);
  assert.equal(new Set(releaseCalls).size, releaseCalls.length);
  assert.deepEqual(harness.completedImages, []);
  assert.deepEqual(harness.finished, [{
    jobId: 'individual-job', total: 5, success: 0, failed: 0, cancelled: 5
  }]);
});

test('single failures release their leases, continue pumping, and finish with image-scoped success counts', async () => {
  const requests = new Map();
  const releaseCalls = [];
  let nextDownloadId = 100;
  const blobHost = {
    async start(request) { requests.set(request.jobId, request); return { jobId: request.jobId, state: 'running' }; },
    async result(jobId) {
      const request = requests.get(jobId);
      if (request.entries[0].sequence === 2) {
        return {
          jobId, output: 'file', zippedEntries: [],
          failedEntries: [{ ...request.entries[0], error: 'fetch blocked' }]
        };
      }
      return successfulBlobResult(request);
    },
    async cancel() { return true; },
    async release(jobId) { releaseCalls.push(jobId); return true; }
  };
  const harness = createHarness({
    blobHost,
    async requestDownload({ entry }) {
      if (entry.sequence === 3) throw new Error('browser rejected');
      return nextDownloadId++;
    }
  });
  const { IndividualDownloadQueue } = await loadTsModule('src/background/individual-download-queue.ts');
  const queue = new IndividualDownloadQueue(harness.dependencies);

  await queue.start({
    jobId: 'individual-job',
    images: [1, 2, 3, 4].map((sequence) => ({ id: `img-${sequence}`, url: `https://example.com/${sequence}.jpg` })),
    settings: {}
  });
  await waitFor(() => {
    const states = harness.snapshot().activeWindow.individualQueue.map(({ state }) => state);
    return states.filter((state) => state === 'pending').length === 2
      && states.filter((state) => state === 'failed').length === 2;
  });

  const pending = harness.snapshot().activeWindow.individualQueue.filter(({ state }) => state === 'pending');
  await queue.handleTerminal(pending[0].downloadId, 'complete');
  await queue.handleTerminal(pending[1].downloadId, 'interrupted', 'disk full');
  await waitFor(() => harness.finished.length === 1);

  assert.equal(harness.maxOccupied(), 3);
  assert.deepEqual(harness.snapshot().activeWindow.individualQueue.map(({ state }) => state), [
    'complete', 'failed', 'failed', 'failed'
  ]);
  assert.deepEqual(new Set(releaseCalls), new Set([
    'individual-job:file:1', 'individual-job:file:2',
    'individual-job:file:3', 'individual-job:file:4'
  ]));
  assert.deepEqual(harness.completedImages.map(({ imageId }) => imageId), ['img-1']);
  assert.deepEqual(harness.finished, [{
    jobId: 'individual-job', total: 4, success: 1, failed: 3, cancelled: 0
  }]);
});

test('an early terminal event is consumed exactly once after download metadata is persisted', async () => {
  const requests = new Map();
  const releaseCalls = [];
  const blobHost = {
    async start(request) { requests.set(request.jobId, request); return { jobId: request.jobId, state: 'running' }; },
    async result(jobId) { return successfulBlobResult(requests.get(jobId)); },
    async cancel() { return true; },
    async release(jobId) { releaseCalls.push(jobId); return true; }
  };
  let queue;
  const harness = createHarness({
    blobHost,
    async requestDownload() {
      await queue.handleTerminal(501, 'complete');
      return 501;
    }
  });
  const { IndividualDownloadQueue } = await loadTsModule('src/background/individual-download-queue.ts');
  queue = new IndividualDownloadQueue(harness.dependencies);

  await queue.start({
    jobId: 'individual-job',
    images: [{ id: 'early', url: 'https://example.com/early.jpg' }],
    settings: {}
  });
  await waitFor(() => harness.finished.length === 1);
  await queue.handleTerminal(501, 'complete');

  assert.equal(harness.snapshot().activeWindow.individualQueue[0].state, 'complete');
  assert.equal(harness.registered.length, 1);
  assert.equal(harness.settled.length, 1);
  assert.equal(harness.completedImages.length, 1);
  assert.deepEqual(releaseCalls, ['individual-job:file:1']);
  assert.equal(harness.finished.length, 1);
});

test('recover reconciles pending downloads, cleans terminal leases, and only requeues recoverable work', async () => {
  const snapshot = createSnapshot('recovery-job');
  snapshot.activeWindow.individualQueue = [
    entry(1, 'queued'),
    entry(2, 'preparing', { blobLeaseJobId: 'recovery-job:file:2' }),
    entry(3, 'pending', { downloadId: 103, blobLeaseJobId: 'recovery-job:file:3' }),
    entry(4, 'pending', { downloadId: 104, blobLeaseJobId: 'recovery-job:file:4' }),
    entry(5, 'complete', { downloadId: 105, blobLeaseJobId: 'recovery-job:file:5' }),
    entry(6, 'failed', { blobLeaseJobId: 'recovery-job:file:6' }),
    entry(7, 'cancelled', { blobLeaseJobId: 'recovery-job:file:7' }),
    entry(8, 'pending', { blobLeaseJobId: 'recovery-job:file:8' })
  ];
  const requests = [];
  const jobs = new Map();
  const releaseCalls = [];
  const blobHost = {
    async start(request) {
      requests.push(request);
      jobs.set(request.jobId, deferred());
      return { jobId: request.jobId, state: 'running' };
    },
    result(jobId) { return jobs.get(jobId).promise; },
    async cancel() { return true; },
    async release(jobId) { releaseCalls.push(jobId); return true; }
  };
  const harness = createHarness({
    snapshot,
    blobHost,
    async requestDownload() { throw new Error('recovered Blob work is intentionally held'); },
    async searchDownload(downloadId) {
      if (downloadId === 103) return [{ id: 103, state: 'in_progress' }];
      if (downloadId === 104) return [{ id: 104, state: 'complete' }];
      throw new Error(`unexpected search ${downloadId}`);
    }
  });
  const { IndividualDownloadQueue } = await loadTsModule('src/background/individual-download-queue.ts');
  const queue = new IndividualDownloadQueue(harness.dependencies);

  await queue.recover('recovery-job');
  await waitFor(() => requests.length === 2);

  assert.deepEqual(requests.map(({ entries }) => entries[0].sequence).sort((a, b) => a - b), [1, 2]);
  assert.equal(harness.snapshot().activeWindow.individualQueue.find(({ sequence }) => sequence === 3).state, 'pending');
  assert.equal(harness.snapshot().activeWindow.individualQueue.find(({ sequence }) => sequence === 4).state, 'complete');
  assert.equal(harness.snapshot().activeWindow.individualQueue.find(({ sequence }) => sequence === 5).state, 'complete');
  assert.deepEqual(harness.completedImages.map(({ imageId }) => imageId), ['img-4']);
  assert.equal(releaseCalls.includes('recovery-job:file:3'), false);
  for (const lease of [2, 4, 5, 6, 7, 8].map((sequence) => `recovery-job:file:${sequence}`)) {
    assert.equal(releaseCalls.includes(lease), true, `expected ${lease} to be released`);
  }

  await queue.handleTerminal(103, 'complete');
  await waitFor(() => requests.length === 3);
  assert.equal(requests[2].entries[0].sequence, 8);
  assert.equal(requests.some(({ entries }) => [3, 4, 5].includes(entries[0].sequence)), false);
});

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';
import {
  activeWindow,
  completedBroadcast,
  createHost,
  createStorage,
  imageResponse,
  installChrome,
  persistedSnapshot,
  restoreBatchCoordinatorGlobals,
  waitFor
} from './helpers/batch-coordinator-harness.mjs';

afterEach(restoreBatchCoordinatorGlobals);

test('graceful stop without an active window detaches auto batching without clearing page images', async () => {
  const storage = createStorage();
  const broadcasts = [];
  const browser = installChrome(storage);
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  const started = await coordinator.start({ mode: 'auto', targetTabId: 31, autoBatchLimit: 2 });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));

  assert.equal(await coordinator.stopAutoBatchAfterCurrent(started.jobId, true), true);
  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);

  assert.equal(completed.autoStopRequested, true);
  assert.equal(completed.continueAutoScrollAfterStop, true);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);
  assert.deepEqual(
    browser.tabMessages.filter(({ message }) => message.action === 'finishAutoBatchSession').map(({ message }) => message),
    [{ action: 'finishAutoBatchSession', jobId: started.jobId, continueAutoScroll: true }]
  );
  assert.equal(storage.current(), null);
});

test('automatic coordinator tasks force ZIP output even when the request disables ZIP', async () => {
  const storage = createStorage();
  const broadcasts = [];
  const browser = installChrome(storage);
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  const started = await coordinator.start({
    mode: 'auto', targetTabId: 31, autoBatchLimit: 2, downloadAsZip: false,
    settings: { downloadAsZip: false }
  });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));
  const snapshot = await coordinator.getSnapshot();
  assert.equal(snapshot.outputMode, 'zip');
  await coordinator.cancel(started.jobId);
});

test('graceful stop commits the active auto window then refuses another window and does not resume', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage);
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const started = await coordinator.start({ mode: 'auto', targetTabId: 31, autoBatchLimit: 1 });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));
  assert.equal(await coordinator.acceptAutoBatchWindow({
    jobId: started.jobId,
    images: [{ id: 'a', url: 'https://example.com/a.jpg' }],
    startOffset: 0,
    endOffset: 1,
    finalWindow: false
  }, 31), true);
  const pending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.expectedDownloadIds.length
    ? await coordinator.getSnapshot()
    : null);

  assert.equal(await coordinator.stopAutoBatchAfterCurrent(started.jobId, false), true);
  assert.equal(await coordinator.acceptAutoBatchWindow({
    jobId: started.jobId,
    images: [{ id: 'b', url: 'https://example.com/b.jpg' }],
    startOffset: 1,
    endOffset: 2,
    finalWindow: false
  }, 31), false);

  const downloadId = pending.activeWindow.expectedDownloadIds[0];
  coordinator.handleDownloadChange({ id: downloadId, state: { current: 'complete' } }, host.activeDownloads.get(downloadId));
  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);

  assert.equal(completed.batchCursor, 1);
  assert.equal(completed.autoStopRequested, true);
  assert.equal(browser.tabMessages.filter(({ message }) => message.action === 'commitAutoBatchWindow').length, 1);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'), false);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);
  assert.deepEqual(
    browser.tabMessages.filter(({ message }) => message.action === 'finishAutoBatchSession').at(-1)?.message,
    { action: 'finishAutoBatchSession', jobId: started.jobId, continueAutoScroll: false }
  );
});

test('stop intent wins when it interleaves with a newly ready auto window', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage);
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));
  const started = await coordinator.start({ mode: 'auto', targetTabId: 31, autoBatchLimit: 1 });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));

  const [stopped, accepted] = await Promise.all([
    coordinator.stopAutoBatchAfterCurrent(started.jobId, true),
    coordinator.acceptAutoBatchWindow({
      jobId: started.jobId,
      images: [{ id: 'late', url: 'https://example.com/late.jpg' }],
      startOffset: 0,
      endOffset: 1,
      finalWindow: false
    }, 31)
  ]);

  assert.equal(stopped, true);
  assert.equal(accepted, false, 'a window must not register after stop intent enters the coordinator');
  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
  assert.equal(completed.batchCursor, 0);
  assert.equal(browser.downloadCalls.length, 0);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'commitAutoBatchWindow'), false);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'), false);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);
});

test('immediate cancel of an active auto window cancels and releases without commit or cursor advance', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage, { firstDownloadId: 1301 });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const started = await coordinator.start({ mode: 'auto', targetTabId: 31, autoBatchLimit: 1 });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));
  assert.equal(await coordinator.acceptAutoBatchWindow({
    jobId: started.jobId,
    images: [{ id: 'active', url: 'https://example.com/active.jpg' }],
    startOffset: 0,
    endOffset: 1,
    finalWindow: false
  }, 31), true);
  const pending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.expectedDownloadIds.length
    ? await coordinator.getSnapshot()
    : null);
  const downloadId = pending.activeWindow.expectedDownloadIds[0];
  const leaseJobId = pending.activeWindow.downloadStates[downloadId].blobLeaseJobId;

  assert.equal(await coordinator.cancel(started.jobId), true);
  const cancelled = await coordinator.getSnapshot();
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.batchCursor, 0);
  assert.equal(cancelled.autoBatchCompletedBatches, 0);
  assert.deepEqual(browser.cancelCalls, [downloadId]);
  assert.deepEqual(host.cancelCalls, [leaseJobId]);
  assert.deepEqual(host.releaseCalls, [leaseJobId]);
  assert.equal(host.activeDownloads.size, 0);
  assert.equal(completedBroadcast(broadcasts), undefined);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'commitAutoBatchWindow'), false);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'), false);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);
});

test('coordinator cancel stops individual dispatch, cancels pending IDs, and releases leases exactly once', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage, { firstDownloadId: 1401 });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const images = Array.from({ length: 5 }, (_, index) => ({
    id: `individual-${index + 1}`,
    url: `https://example.com/individual-${index + 1}.jpg`
  }));
  const started = await coordinator.start({
    mode: 'manual',
    targetTabId: 31,
    images,
    downloadAsZip: false,
    settings: { downloadAsZip: false }
  });
  const pending = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    const states = snapshot?.activeWindow?.individualQueue.map(({ state }) => state) ?? [];
    return states.filter((state) => state === 'pending').length === 3
      && states.filter((state) => state === 'queued').length === 2
      ? snapshot
      : null;
  });
  const pendingIds = pending.activeWindow.individualQueue
    .filter(({ state }) => state === 'pending')
    .map(({ downloadId }) => downloadId)
    .sort((a, b) => a - b);
  const leaseJobIds = pending.activeWindow.individualQueue
    .filter(({ state }) => state === 'pending')
    .map(({ blobLeaseJobId }) => blobLeaseJobId)
    .sort();

  assert.equal(await coordinator.cancel(started.jobId), true);
  const cancelled = await coordinator.getSnapshot();
  assert.equal(cancelled.phase, 'cancelled');
  assert.deepEqual(cancelled.activeWindow.individualQueue.map(({ state }) => state), [
    'cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled'
  ]);
  assert.equal(cancelled.cancelledCount, 5);
  assert.equal(browser.downloadCalls.length, 3, 'queued entries must not be dispatched after cancellation');
  assert.deepEqual([...browser.cancelCalls].sort((a, b) => a - b), pendingIds);
  assert.deepEqual([...host.cancelCalls].sort(), leaseJobIds);
  assert.deepEqual([...host.releaseCalls].sort(), leaseJobIds);
  assert.equal(new Set(browser.cancelCalls).size, browser.cancelCalls.length);
  assert.equal(new Set(host.releaseCalls).size, host.releaseCalls.length);
  assert.equal(host.activeDownloads.size, 0);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'settleSingleDownload'), false);
});

test('restart preserves graceful stop intent and finishes a settled active window without resuming', async () => {
  const storage = createStorage(persistedSnapshot({
    mode: 'auto',
    outputMode: 'zip',
    targetTabId: 31,
    autoSessionFinished: false,
    autoStopRequested: true,
    continueAutoScrollAfterStop: true,
    autoBatchTotalBatches: 0,
    autoBatchCompletedBatches: 0,
    activeWindow: activeWindow({
      finalWindow: false,
      contentCommitState: {
        state: 'pending', startOffset: 0, endOffset: 1, acknowledgedBaseOffset: null, retainedCount: null
      }
    })
  }));
  const broadcasts = [];
  const browser = installChrome(storage, { search() { return [{ id: 44, state: 'complete' }]; } });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const coordinator = new BatchCoordinator(createHost(broadcasts));

  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
  assert.equal(completed.batchCursor, 1);
  assert.equal(await coordinator.getSnapshot(), null);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'), false);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);
  assert.deepEqual(
    browser.tabMessages.filter(({ message }) => message.action === 'finishAutoBatchSession').at(-1)?.message,
    { action: 'finishAutoBatchSession', jobId: 'restored-job', continueAutoScroll: true }
  );
});

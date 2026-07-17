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

test('manual ZIP stays pending until browser completion, then releases its lease and atomically clears state', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage);
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const started = await coordinator.start({
    mode: 'manual', targetTabId: 9,
    images: [{ id: 'a', url: 'https://example.com/a.jpg' }], settings: { highQuality: true }
  });

  const pending = await waitFor(async () => {
    const snapshot = await coordinator.getSnapshot();
    return snapshot?.activeWindow?.expectedDownloadIds.length === 1 ? snapshot : null;
  });
  const zipId = pending.activeWindow.expectedDownloadIds[0];
  assert.equal(pending.phase, 'downloading');
  assert.equal(pending.batchCursor, 0, 'allocation must not advance the durable cursor');
  assert.deepEqual(host.releaseCalls, []);

  coordinator.handleDownloadChange({ id: zipId, state: { current: 'complete' } }, host.activeDownloads.get(zipId));
  await waitFor(() => completedBroadcast(broadcasts));
  assert.equal(storage.current(), null);
  assert.equal(await coordinator.getSnapshot(), null);
  assert.deepEqual(host.releaseCalls, [`${started.jobId}:zip:0:1`]);
  assert.equal(host.activeDownloads.has(zipId), false);
  assert.deepEqual(browser.tabMessages.slice(-1)[0].message.action, 'clearAllImages');
});

test('ZIP interruption fails the window, preserves content state, and late events cannot change counts', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage);
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  await coordinator.start({ mode: 'manual', targetTabId: 9, images: [{ id: 'a', url: 'https://example.com/a.jpg' }] });
  const pending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.expectedDownloadIds.length ? await coordinator.getSnapshot() : null);
  const zipId = pending.activeWindow.expectedDownloadIds[0];

  coordinator.handleDownloadChange({ id: zipId, state: { current: 'interrupted' } }, host.activeDownloads.get(zipId));
  const failed = await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'failed' ? await coordinator.getSnapshot() : null);
  assert.equal(failed.batchCursor, 0);
  assert.equal(failed.zippedCount, 0);
  assert.ok(failed.activeWindow);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);

  coordinator.handleDownloadChange({ id: zipId, state: { current: 'complete' } }, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await coordinator.getSnapshot(), failed);
});

test('fallback completion is browser-settled exactly once and interruption fails instead of succeeding unresolved', async () => {
  for (const terminalState of ['complete', 'interrupted']) {
    const storage = createStorage();
    const broadcasts = [];
    globalThis.fetch = async () => { throw new Error('blocked'); };
    installChrome(storage, { firstDownloadId: terminalState === 'complete' ? 801 : 811 });
    const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
    const host = createHost(broadcasts);
    const coordinator = new BatchCoordinator(host);
    await coordinator.start({ mode: 'manual', targetTabId: 9, images: [{ id: 'a', url: 'https://example.com/a.jpg' }] });
    const pending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.expectedDownloadIds.length ? await coordinator.getSnapshot() : null);
    const fallbackId = pending.activeWindow.expectedDownloadIds[0];
    assert.equal(pending.activeWindow.downloadStates[fallbackId].kind, 'fallback');
    coordinator.handleDownloadChange({ id: fallbackId, state: { current: terminalState } }, host.activeDownloads.get(fallbackId));
    coordinator.handleDownloadChange({ id: fallbackId, state: { current: terminalState } }, host.activeDownloads.get(fallbackId));
    if (terminalState === 'complete') {
      const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
      assert.equal(completed.fallbackCount, 1);
      assert.equal(storage.current(), null);
    } else {
      const failed = await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'failed' ? await coordinator.getSnapshot() : null);
      assert.equal(failed.fallbackCount, 0);
      assert.ok(failed.activeWindow);
    }
  }
});

test('automatic windows serialize browser settlement, content commit, cursor advance, and resume', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage, { firstDownloadId: 901 });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const started = await coordinator.start({ mode: 'auto', targetTabId: 19, settings: { autoBatchLimit: 2 }, autoBatchLimit: 2 });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));

  assert.equal(await coordinator.acceptAutoBatchWindow({
    jobId: started.jobId,
    images: [{ id: 'a', url: 'https://example.com/a.jpg' }, { id: 'b', url: 'https://example.com/b.jpg' }],
    startOffset: 0, endOffset: 2, finalWindow: false
  }, 19), true);
  const firstPending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.expectedDownloadIds.length ? await coordinator.getSnapshot() : null);
  assert.equal(firstPending.batchCursor, 0);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'commitAutoBatchWindow'), false);
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'), false);

  const firstZip = firstPending.activeWindow.expectedDownloadIds[0];
  coordinator.handleDownloadChange({ id: firstZip, state: { current: 'complete' } }, host.activeDownloads.get(firstZip));
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'));
  const afterFirst = await coordinator.getSnapshot();
  assert.equal(afterFirst.batchCursor, 2);
  assert.equal(afterFirst.activeWindow, null);
  assert.equal(browser.tabMessages.find(({ message }) => message.action === 'commitAutoBatchWindow').message.endOffset, 2);

  assert.equal(await coordinator.acceptAutoBatchWindow({
    jobId: started.jobId,
    images: [{ id: 'c', url: 'https://example.com/c.jpg' }],
    startOffset: 2, endOffset: 3, finalWindow: true
  }, 19), true);
  const secondPending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.startOffset === 2
    && (await coordinator.getSnapshot()).activeWindow.expectedDownloadIds.length ? await coordinator.getSnapshot() : null);
  const secondZip = secondPending.activeWindow.expectedDownloadIds[0];
  coordinator.handleDownloadChange({ id: secondZip, state: { current: 'complete' } }, host.activeDownloads.get(secondZip));
  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
  assert.equal(completed.batchCursor, 3);
  assert.equal(completed.zippedCount, 3);
  assert.equal(storage.current(), null);
  assert.deepEqual(
    browser.tabMessages.filter(({ message }) => ['commitAutoBatchWindow', 'finishAutoBatchSession', 'clearAllImages'].includes(message.action))
      .map(({ message }) => message.action),
    ['commitAutoBatchWindow', 'commitAutoBatchWindow', 'finishAutoBatchSession', 'clearAllImages']
  );
});

test('automatic batch stops after the configured total batch count', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage, { firstDownloadId: 950 });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const started = await coordinator.start({
    mode: 'auto',
    targetTabId: 21,
    autoBatchLimit: 1,
    autoBatchTotalBatches: 2,
    settings: { autoBatchLimit: 1, autoBatchTotalBatches: 2 }
  });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));

  for (let index = 0; index < 2; index++) {
    assert.equal(await coordinator.acceptAutoBatchWindow({
      jobId: started.jobId,
      images: [{ id: 'img-' + index, url: 'https://example.com/' + index + '.jpg' }],
      startOffset: index,
      endOffset: index + 1,
      finalWindow: false
    }, 21), true);
    const pending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.startOffset === index
      && (await coordinator.getSnapshot()).activeWindow.expectedDownloadIds.length ? await coordinator.getSnapshot() : null);
    const zipDownloadId = pending.activeWindow.expectedDownloadIds[0];
    coordinator.handleDownloadChange({ id: zipDownloadId, state: { current: 'complete' } }, host.activeDownloads.get(zipDownloadId));
    if (index === 0) {
      await waitFor(async () => (await coordinator.getSnapshot())?.batchCursor === 1);
    }
  }

  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
  assert.equal(completed.batchCursor, 2);
  assert.equal(completed.autoBatchCompletedBatches, 2);
  assert.equal(completed.autoSessionFinished, true);
  assert.equal(storage.current(), null);
  assert.deepEqual(
    browser.tabMessages.filter(({ message }) => ['resumeAutoBatchSession', 'finishAutoBatchSession', 'clearAllImages'].includes(message.action))
      .map(({ message }) => message.action),
    ['resumeAutoBatchSession', 'finishAutoBatchSession', 'clearAllImages']
  );
});

test('ten automatic windows preserve absolute cursor order and never overlap transactions', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage, { firstDownloadId: 1000 });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const started = await coordinator.start({ mode: 'auto', targetTabId: 20, autoBatchLimit: 1 });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));

  for (let index = 0; index < 10; index++) {
    assert.equal(await coordinator.acceptAutoBatchWindow({
      jobId: started.jobId,
      images: [{ id: `img-${index}`, url: `https://example.com/${index}.jpg` }],
      startOffset: index,
      endOffset: index + 1,
      finalWindow: index === 9
    }, 20), true);
    assert.equal(await coordinator.acceptAutoBatchWindow({
      jobId: started.jobId, images: [{ id: 'overlap', url: 'https://example.com/overlap.jpg' }],
      startOffset: index, endOffset: index + 1, finalWindow: false
    }, 20), false);
    const pending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.startOffset === index
      && (await coordinator.getSnapshot()).activeWindow.expectedDownloadIds.length ? await coordinator.getSnapshot() : null);
    const downloadId = pending.activeWindow.expectedDownloadIds[0];
    coordinator.handleDownloadChange({ id: downloadId, state: { current: 'complete' } }, host.activeDownloads.get(downloadId));
    if (index < 9) await waitFor(async () => (await coordinator.getSnapshot())?.batchCursor === index + 1);
  }
  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
  assert.equal(completed.batchCursor, 10);
  assert.equal(completed.zippedCount, 10);
  assert.deepEqual(
    browser.tabMessages.filter(({ message }) => message.action === 'commitAutoBatchWindow').map(({ message }) => message.endOffset),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
});

test('invalid content commit fails without cursor advance or success cleanup', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage, {
    sendMessage(_tabId, message) {
      if (message.action === 'commitAutoBatchWindow') return { success: true, baseOffset: 999, retainedCount: 0 };
      return { success: true };
    }
  });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const started = await coordinator.start({ mode: 'auto', targetTabId: 19, autoBatchLimit: 2 });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));
  await coordinator.acceptAutoBatchWindow({
    jobId: started.jobId, images: [{ id: 'a', url: 'https://example.com/a.jpg' }],
    startOffset: 0, endOffset: 1, finalWindow: true
  }, 19);
  const pending = await waitFor(async () => (await coordinator.getSnapshot())?.activeWindow?.expectedDownloadIds.length ? await coordinator.getSnapshot() : null);
  const id = pending.activeWindow.expectedDownloadIds[0];
  coordinator.handleDownloadChange({ id, state: { current: 'complete' } }, host.activeDownloads.get(id));
  const failed = await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'failed' ? await coordinator.getSnapshot() : null);
  assert.equal(failed.batchCursor, 0);
  assert.equal(failed.activeWindow.contentCommitState.state, 'failed');
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);
});

test('early ZIP and fallback terminal events before metadata are buffered for complete and interrupted states', async () => {
  for (const kind of ['zip', 'fallback']) {
    for (const terminalState of ['complete', 'interrupted']) {
      const storage = createStorage();
      const broadcasts = [];
      globalThis.fetch = kind === 'zip' ? async () => imageResponse() : async () => { throw new Error('blocked'); };
      let coordinator;
      installChrome(storage, {
        async onDownload(downloadId) {
          coordinator.handleDownloadChange({ id: downloadId, state: { current: terminalState } }, undefined);
        }
      });
      const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
      const host = createHost(broadcasts);
      coordinator = new BatchCoordinator(host);
      await coordinator.start({ mode: 'manual', targetTabId: 9, images: [{ id: 'a', url: 'https://example.com/a.jpg' }] });
      if (terminalState === 'complete') {
        const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
        assert.equal(completed[kind === 'zip' ? 'zippedCount' : 'fallbackCount'], 1);
        assert.equal(storage.current(), null);
      } else {
        const failed = await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'failed' ? await coordinator.getSnapshot() : null);
        assert.equal(failed[kind === 'zip' ? 'zippedCount' : 'fallbackCount'], 0);
      }
    }
  }
});

test('terminal event in the activeDownloads-before-activeWindow gap is buffered even with batch metadata', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  installChrome(storage, { search() { throw new Error('search unavailable'); } });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  let coordinator;
  class TerminalOnMetadataMap extends Map {
    set(downloadId, info) {
      super.set(downloadId, info);
      if (info.isBatch) coordinator.handleDownloadChange({ id: downloadId, state: { current: 'complete' } }, info);
      return this;
    }
  }
  host.activeDownloads = new TerminalOnMetadataMap();
  coordinator = new BatchCoordinator(host);
  await coordinator.start({ mode: 'manual', targetTabId: 9, images: [{ id: 'a', url: 'https://example.com/a.jpg' }] });

  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
  assert.equal(completed.zippedCount, 1);
  assert.equal(storage.current(), null);
});

test('restart reconciles complete, missing, and interrupted browser IDs deterministically', async () => {
  for (const browserState of ['complete', 'interrupted', 'missing']) {
    const storage = createStorage(persistedSnapshot());
    const broadcasts = [];
    installChrome(storage, {
      search() { return browserState === 'missing' ? [] : [{ id: 44, state: browserState }]; }
    });
    const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
    const host = createHost(broadcasts);
    const coordinator = new BatchCoordinator(host);
    if (browserState === 'complete') {
      await waitFor(() => completedBroadcast(broadcasts));
      assert.equal(await coordinator.getSnapshot(), null);
      assert.equal(storage.current(), null);
    } else {
      const failed = await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'failed' ? await coordinator.getSnapshot() : null);
      assert.match(failed.details, /浏览器下载/);
      assert.ok(failed.activeWindow);
    }
  }
});

test('restart reattaches one completed host result but interrupts and cleans running host work', async () => {
  for (const hostState of ['completed', 'running']) {
    const hostJobId = 'restored-job:zip:0:1';
    const storage = createStorage(persistedSnapshot({
      phase: 'fetching',
      associatedDownloadIds: [],
      activeWindow: activeWindow({
        expectedDownloadIds: [],
        downloadStates: {},
        hostState: 'fetching'
      })
    }));
    const broadcasts = [];
    installChrome(storage, { search(query) { return query.id === 701 ? [{ id: 701, state: 'complete' }] : []; } });
    const seedResult = {
      jobId: hostJobId,
      objectUrl: 'blob:test/recovered',
      zippedEntries: [{ imageId: 'a', sequence: 1, sourceUrl: 'a', filename: '001.jpg', resolvedUrl: 'a' }],
      failedEntries: []
    };
    const seed = {
      jobId: hostJobId,
      status: { jobId: hostJobId, state: hostState, completedEntries: hostState === 'completed' ? 1 : 0, totalEntries: 1, zipProgress: hostState === 'completed' ? 100 : 0 },
      result: seedResult
    };
    const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
    const host = createHost(broadcasts, [seed]);
    const coordinator = new BatchCoordinator(host);
    if (hostState === 'completed') {
      await waitFor(() => completedBroadcast(broadcasts));
      assert.equal(await coordinator.getSnapshot(), null);
    } else {
      const interrupted = await waitFor(async () => (await coordinator.getSnapshot())?.phase === 'interrupted' ? await coordinator.getSnapshot() : null);
      assert.match(interrupted.details, /did not retain/);
      assert.ok(host.cancelCalls.includes(hostJobId));
      assert.ok(host.releaseCalls.includes(hostJobId));
    }
  }
});

test('restart registers recovered fallback and ZIP downloads before terminal reconciliation', async () => {
  const hostJobId = 'restored-mixed-job:zip:0:2';
  const storage = createStorage(persistedSnapshot({
    phase: 'fetching',
    associatedDownloadIds: [],
    activeWindow: activeWindow({
      endOffset: 2,
      expectedDownloadIds: [],
      downloadStates: {},
      totalCount: 2,
      hostJobId,
      hostState: 'fetching'
    })
  }));
  const broadcasts = [];
  const browser = installChrome(storage, {
    firstDownloadId: 701,
    search(query) {
      return [701, 702].includes(query.id) ? [{ id: query.id, state: 'complete' }] : [];
    }
  });
  const seedResult = {
    jobId: hostJobId,
    objectUrl: 'blob:test/recovered-mixed',
    zippedEntries: [{ imageId: 'a', sequence: 1, sourceUrl: 'a', filename: '001.jpg', resolvedUrl: 'a' }],
    failedEntries: [{ imageId: 'b', sequence: 2, sourceUrl: 'b', filename: '002.jpg', error: 'blocked' }]
  };
  const seed = {
    jobId: hostJobId,
    status: { jobId: hostJobId, state: 'completed', completedEntries: 2, totalEntries: 2, zipProgress: 100 },
    result: seedResult
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts, [seed]);
  const coordinator = new BatchCoordinator(host);

  const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
  assert.equal(completed.zippedCount, 1);
  assert.equal(completed.fallbackCount, 1);
  assert.equal(browser.downloadCalls.length, 2);
  assert.deepEqual(host.releaseCalls, [hostJobId]);
  assert.equal(host.activeDownloads.size, 0);
  assert.equal(await coordinator.getSnapshot(), null);
});

test('startup removes orphan Blob jobs even without an active snapshot', async () => {
  const storage = createStorage();
  const broadcasts = [];
  installChrome(storage);
  const orphanJobId = 'orphan-job:zip:0:1';
  const seed = {
    jobId: orphanJobId,
    status: { jobId: orphanJobId, state: 'completed', completedEntries: 1, totalEntries: 1, zipProgress: 100 },
    result: {
      jobId: orphanJobId,
      objectUrl: 'blob:test/orphan',
      zippedEntries: [],
      failedEntries: []
    }
  };
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts, [seed]);
  const coordinator = new BatchCoordinator(host);

  assert.equal(await coordinator.getSnapshot(), null);
  assert.deepEqual(host.cancelCalls, [orphanJobId]);
  assert.deepEqual(host.releaseCalls, [orphanJobId]);
});

test('final completion broadcasts before clearing the target page session', async () => {
  const storage = createStorage();
  const broadcasts = [];
  const events = [];
  globalThis.fetch = async () => imageResponse();
  installChrome(storage, {
    sendMessage(_tabId, message) {
      if (message.action === 'clearAllImages') events.push('clearAllImages');
      return { success: true };
    }
  });
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  host.broadcast = (message) => {
    broadcasts.push(message);
    if (message.snapshot?.phase === 'completed') events.push('completedBroadcast');
  };
  const coordinator = new BatchCoordinator(host);
  await coordinator.start({ mode: 'manual', targetTabId: 9, images: [] });

  await waitFor(() => completedBroadcast(broadcasts));
  assert.deepEqual(events, ['completedBroadcast', 'clearAllImages']);
});

test('manual empty and exhausted auto no-window are successful no-ops through final clear', async () => {
  for (const mode of ['manual', 'auto']) {
    const storage = createStorage();
    const broadcasts = [];
    globalThis.fetch = async () => imageResponse();
    const browser = installChrome(storage);
    const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
    const coordinator = new BatchCoordinator(createHost(broadcasts));
    const started = await coordinator.start({ mode, targetTabId: 9, images: [] });
    if (mode === 'auto') {
      await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));
      assert.equal(await coordinator.finishAutoSession(started.jobId, 9), true);
    }
    const completed = await waitFor(() => completedBroadcast(broadcasts)?.snapshot);
    assert.equal(completed.totalImages, 0);
    assert.equal(browser.downloadCalls.length, 0);
    assert.equal(storage.current(), null);
  }
});

test('target-tab close interrupts and explicit cancel aborts, cancels, and releases without page cleanup', async () => {
  const storage = createStorage();
  const broadcasts = [];
  globalThis.fetch = async () => imageResponse();
  const browser = installChrome(storage);
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  const host = createHost(broadcasts);
  const coordinator = new BatchCoordinator(host);
  const started = await coordinator.start({ mode: 'auto', targetTabId: 31, autoBatchLimit: 1 });
  await waitFor(() => browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));
  await coordinator.handleTargetTabClosed(31);
  assert.equal((await coordinator.getSnapshot()).phase, 'interrupted');
  assert.equal(browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);

  const storage2 = createStorage();
  const broadcasts2 = [];
  let releaseDownload;
  installChrome(storage2, {
    onDownload() { return new Promise((resolve) => { releaseDownload = resolve; }); }
  });
  const host2 = createHost(broadcasts2);
  const coordinator2 = new BatchCoordinator(host2);
  const manual = await coordinator2.start({ mode: 'manual', targetTabId: 9, images: [{ id: 'a', url: 'https://example.com/a.jpg' }] });
  await waitFor(() => typeof releaseDownload === 'function');
  assert.equal(await coordinator2.cancel(manual.jobId), true);
  releaseDownload();
  assert.equal((await coordinator2.getSnapshot()).phase, 'cancelled');
});

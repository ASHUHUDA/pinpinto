import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

test('ZIP and fallback ids remain pending until every browser download settles complete', async () => {
  const {
    createDownloadSettlement,
    registerExpectedDownload,
    settleDownload,
    getSettlementOutcome
  } = await loadTsModule('src/background/download-settlement.ts');

  let settlement = createDownloadSettlement();
  settlement = registerExpectedDownload(settlement, { downloadId: 11, kind: 'zip' });
  settlement = registerExpectedDownload(settlement, { downloadId: 12, kind: 'fallback' });

  assert.deepEqual(getSettlementOutcome(settlement), {
    status: 'pending',
    pendingIds: [11, 12]
  });

  settlement = settleDownload(settlement, 11, 'complete');
  assert.deepEqual(getSettlementOutcome(settlement), {
    status: 'pending',
    pendingIds: [12]
  });

  settlement = settleDownload(settlement, 12, 'complete');
  assert.deepEqual(getSettlementOutcome(settlement), {
    status: 'complete',
    pendingIds: []
  });
});

test('an interrupted ZIP or fallback fails settlement and duplicate events are exactly once', async () => {
  const {
    createDownloadSettlement,
    registerExpectedDownload,
    settleDownload,
    getSettlementOutcome
  } = await loadTsModule('src/background/download-settlement.ts');

  let zipSettlement = registerExpectedDownload(createDownloadSettlement(), {
    downloadId: 21,
    kind: 'zip'
  });
  zipSettlement = settleDownload(zipSettlement, 21, 'interrupted');
  assert.deepEqual(getSettlementOutcome(zipSettlement), {
    status: 'failed',
    failedIds: [21],
    pendingIds: []
  });

  let fallbackSettlement = registerExpectedDownload(createDownloadSettlement(), {
    downloadId: 22,
    kind: 'fallback'
  });
  fallbackSettlement = settleDownload(fallbackSettlement, 22, 'complete');
  const afterDuplicate = settleDownload(fallbackSettlement, 22, 'interrupted');
  assert.deepEqual(afterDuplicate, fallbackSettlement, 'a terminal download must settle exactly once');
  assert.deepEqual(getSettlementOutcome(afterDuplicate), {
    status: 'complete',
    pendingIds: []
  });
});

function createQueuedStorage(events) {
  let value = null;
  return {
    async get() {
      return { pinpintoBatchTask: value };
    },
    async set(update) {
      value = update.pinpintoBatchTask;
      events.push(`set:${value?.jobId ?? 'null'}`);
    },
    async remove(key) {
      assert.equal(key, 'pinpintoBatchTask');
      value = null;
      events.push('remove');
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    current() {
      return value;
    }
  };
}

test('clearCompleted atomically broadcasts, removes terminal storage, and cannot delete the next task', async () => {
  const { BatchTaskManager } = await loadTsModule('src/background/batch-task-manager.ts');
  const events = [];
  const storage = createQueuedStorage(events);
  let nextJob = 1;
  const manager = new BatchTaskManager({
    storage,
    createJobId: () => `job-${nextJob++}`,
    now: () => nextJob,
    broadcast(snapshot) {
      events.push(`broadcast:${snapshot.jobId}:${snapshot.phase}`);
    }
  });
  await manager.initialize();

  const first = await manager.start({ mode: 'manual', targetTabId: 7, totalImages: 1 });
  const clearPromise = manager.clearCompleted(first.jobId, { progress: 100, details: 'done' });
  const nextStartPromise = manager.start({ mode: 'manual', targetTabId: 7, totalImages: 1 });
  const [cleared, second] = await Promise.all([clearPromise, nextStartPromise]);

  assert.equal(cleared, true);
  assert.equal(second.accepted, true);
  assert.equal(storage.current().jobId, second.jobId);
  assert.equal((await manager.getSnapshot()).jobId, second.jobId);

  const finalBroadcastIndex = events.lastIndexOf(`broadcast:${first.jobId}:completed`);
  const removeIndex = events.indexOf('remove');
  const nextWriteIndex = events.indexOf(`set:${second.jobId}`);
  assert.ok(finalBroadcastIndex >= 0 && finalBroadcastIndex < removeIndex);
  assert.ok(removeIndex < nextWriteIndex, `expected atomic clear/start order, received ${events.join(', ')}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function createStorage(initialValue = null) {
  let value = initialValue;
  return {
    async get() { return { pinpintoBatchTask: value }; },
    async set(update) { value = update.pinpintoBatchTask; },
    async remove() { value = null; },
    current() { return value; }
  };
}

test('task manager rejects a second active job and restores popup state from its snapshot', async () => {
  const { BatchTaskManager } = await loadTsModule('src/background/batch-task-manager.ts');
  const storage = createStorage();
  const broadcasts = [];
  const manager = new BatchTaskManager({
    storage,
    broadcast(snapshot) { broadcasts.push(snapshot); },
    now: () => 1000,
    createJobId: () => 'job-1'
  });
  await manager.initialize();

  const first = await manager.start({ mode: 'manual', targetTabId: 8, totalImages: 2 });
  const second = await manager.start({ mode: 'manual', targetTabId: 9, totalImages: 1 });

  assert.deepEqual(first, { accepted: true, jobId: 'job-1' });
  assert.deepEqual(second, { accepted: false, jobId: 'job-1', reason: 'batch-task-running' });
  assert.equal((await manager.getSnapshot()).targetTabId, 8);
  assert.equal(storage.current().jobId, 'job-1');
  assert.equal(broadcasts.at(-1).jobId, 'job-1');
});

test('task manager removes a completed snapshot left behind by an interrupted final clear', async () => {
  const { BatchTaskManager } = await loadTsModule('src/background/batch-task-manager.ts');
  const storage = createStorage({
    jobId: 'completed-job', mode: 'manual', targetTabId: 8, phase: 'completed', batchCursor: 0,
    progress: 100, details: 'done', totalImages: 0, zippedCount: 0, fallbackCount: 0,
    unresolvedCount: 0, associatedDownloadIds: [], pendingFallbackDownloadIds: [], activeWindow: null,
    autoSessionFinished: true, autoBatchLimit: 100, settings: {}, createdAt: 1, updatedAt: 2
  });
  const broadcasts = [];
  const manager = new BatchTaskManager({ storage, broadcast(snapshot) { broadcasts.push(snapshot); } });

  assert.equal(await manager.initialize(), null);
  assert.equal(storage.current(), null);
  assert.deepEqual(broadcasts.map(({ phase }) => phase), ['completed']);
});

test('task manager preserves active work for coordinator restart reconciliation', async () => {
  const { BatchTaskManager } = await loadTsModule('src/background/batch-task-manager.ts');
  const storage = createStorage({
    jobId: 'old-job',
    mode: 'manual',
    targetTabId: 8,
    phase: 'fetching',
    batchCursor: 0,
    progress: 25,
    details: 'fetching',
    totalImages: 2,
    zippedCount: 0,
    fallbackCount: 0,
    unresolvedCount: 0,
    associatedDownloadIds: [],
    pendingFallbackDownloadIds: [],
    autoSessionFinished: true,
    createdAt: 1,
    updatedAt: 2
  });
  const manager = new BatchTaskManager({ storage, broadcast() {}, now: () => 2000 });

  await manager.initialize();
  const restored = await manager.getSnapshot();

  assert.equal(restored.phase, 'fetching');
  assert.equal(restored.activeWindow, null);
});

test('shared task client ignores another job and cancels only its current job', async () => {
  const runtimeCalls = [];
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        runtimeCalls.push(message);
        if (message.action === 'getBatchTaskState') {
          return { snapshot: { jobId: 'job-7', phase: 'fetching', progress: 30, details: 'working' } };
        }
        return { success: true };
      }
    }
  };
  const { BatchTaskClient } = await loadTsModule('src/shared/batch-task-client.ts');
  const snapshots = [];
  const client = new BatchTaskClient((snapshot) => snapshots.push(snapshot));

  await client.restore();
  assert.equal(client.acceptMessage({ action: 'batchTaskStateChanged', snapshot: { jobId: 'other-job' } }), false);
  assert.equal(client.acceptMessage({ action: 'batchTaskStateChanged', snapshot: { jobId: 'job-7', phase: 'completed' } }), true);
  await client.cancel();

  assert.deepEqual(runtimeCalls.at(-1), { action: 'cancelCurrentBatch', jobId: 'job-7' });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.phase), ['fetching', 'completed']);
});

test('task manager persists output mode and forces automatic tasks to ZIP', async () => {
  const { BatchTaskManager } = await loadTsModule('src/background/batch-task-manager.ts');
  const manualStorage = createStorage();
  const manual = new BatchTaskManager({
    storage: manualStorage,
    broadcast() {},
    createJobId: () => 'manual-individual'
  });
  await manual.initialize();
  await manual.start({ mode: 'manual', outputMode: 'individual', targetTabId: 8, totalImages: 2 });
  assert.equal((await manual.getSnapshot()).outputMode, 'individual');

  const autoStorage = createStorage();
  const auto = new BatchTaskManager({
    storage: autoStorage,
    broadcast() {},
    createJobId: () => 'auto-zip'
  });
  await auto.initialize();
  await auto.start({ mode: 'auto', outputMode: 'individual', targetTabId: 8 });
  const snapshot = await auto.getSnapshot();
  assert.equal(snapshot.outputMode, 'zip');
  assert.equal(snapshot.autoStopRequested, false);
  assert.equal(snapshot.continueAutoScrollAfterStop, false);
  assert.equal(snapshot.individualCount, 0);
  assert.equal(snapshot.failedCount, 0);
  assert.equal(snapshot.cancelledCount, 0);
});

test('task manager migrates legacy snapshots and serializes graceful stop intent', async () => {
  const storage = createStorage({
    jobId: 'legacy-auto', mode: 'auto', targetTabId: 8, phase: 'waiting-for-batch', batchCursor: 0,
    progress: 0, details: 'waiting', totalImages: 0, zippedCount: 0, fallbackCount: 0,
    unresolvedCount: 0, associatedDownloadIds: [], pendingFallbackDownloadIds: [], activeWindow: null,
    autoSessionFinished: false, autoBatchLimit: 100, autoBatchTotalBatches: 0,
    autoBatchCompletedBatches: 0, settings: {}, createdAt: 1, updatedAt: 2
  });
  const { BatchTaskManager } = await loadTsModule('src/background/batch-task-manager.ts');
  const manager = new BatchTaskManager({ storage, broadcast() {}, now: () => 3 });
  await manager.initialize();

  const migrated = await manager.getSnapshot();
  assert.equal(migrated.outputMode, 'zip');
  assert.equal(migrated.autoStopRequested, false);
  assert.equal(migrated.continueAutoScrollAfterStop, false);
  assert.equal(migrated.individualCount, 0);
  assert.equal(migrated.failedCount, 0);
  assert.equal(migrated.cancelledCount, 0);

  const stopped = await manager.requestAutoStop('legacy-auto', true);
  assert.equal(stopped.autoStopRequested, true);
  assert.equal(stopped.continueAutoScrollAfterStop, true);
  assert.match(stopped.details, /current batch|当前批次/i);
  assert.equal(storage.current().autoStopRequested, true);
});

test('shared task client sends graceful stop separately from immediate cancel', async () => {
  const runtimeCalls = [];
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        runtimeCalls.push(message);
        if (message.action === 'getBatchTaskState') {
          return { snapshot: { jobId: 'job-stop', phase: 'downloading' } };
        }
        return { success: true };
      }
    }
  };
  const { BatchTaskClient } = await loadTsModule('src/shared/batch-task-client.ts');
  const client = new BatchTaskClient(() => {});
  await client.restore();
  assert.equal(await client.stopAfterCurrent(true), true);
  assert.equal(await client.cancel(), true);

  assert.deepEqual(runtimeCalls.slice(-2), [
    { action: 'stopAutoBatchAfterCurrent', jobId: 'job-stop', continueAutoScroll: true },
    { action: 'cancelCurrentBatch', jobId: 'job-stop' }
  ]);
});

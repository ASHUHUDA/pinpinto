import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function createStorage(initialValue = null) {
  let value = initialValue;
  return {
    async get() { return { pinpintoBatchTask: value }; },
    async set(update) { value = update.pinpintoBatchTask; },
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

test('task manager marks fetch/compression work interrupted after a service-worker restart', async () => {
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

  assert.equal(restored.phase, 'interrupted');
  assert.match(restored.details, /重新开始/);
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

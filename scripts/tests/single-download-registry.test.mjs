import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function createStorage(initial = []) {
  let records = initial;
  return {
    async get() { return { pinpintoSingleDownloads: records }; },
    async set(value) { records = value.pinpintoSingleDownloads; },
    current() { return records; }
  };
}

function record(downloadId = 41) {
  return {
    downloadId,
    targetTabId: 7,
    imageId: 'img-1',
    requestedFilename: 'PinPinto/a.jpg',
    state: 'pending',
    createdAt: 1
  };
}

test('single terminal event before metadata is buffered, delivered, and removed exactly once', async () => {
  const storage = createStorage();
  const notifications = [];
  const removed = [];
  const { SingleDownloadRegistry } = await loadTsModule('src/background/single-download-registry.ts');
  const registry = new SingleDownloadRegistry({
    storage,
    async search() { return [{ id: 41, state: 'in_progress' }]; },
    async notify(meta, state, error) { notifications.push({ meta, state, error }); },
    onRemoved(meta) { removed.push(meta.downloadId); },
    now: () => 10
  });

  const early = registry.handleTerminal(41, 'complete');
  const registered = registry.register({
    downloadId: 41,
    targetTabId: 7,
    imageId: 'img-1',
    requestedFilename: 'PinPinto/a.jpg'
  });
  await Promise.all([early, registered]);
  await registry.handleTerminal(41, 'interrupted', 'duplicate');

  assert.deepEqual(notifications.map(({ state }) => state), ['complete']);
  assert.deepEqual(removed, [41]);
  assert.deepEqual(storage.current(), []);
  assert.deepEqual(await registry.getRecords(), []);
});

test('single interruption before metadata is buffered as retryable failure', async () => {
  const storage = createStorage();
  const notifications = [];
  const { SingleDownloadRegistry } = await loadTsModule('src/background/single-download-registry.ts');
  const registry = new SingleDownloadRegistry({
    storage,
    async search() { return [{ id: 42, state: 'in_progress' }]; },
    async notify(_meta, state, error) { notifications.push({ state, error }); }
  });
  const early = registry.handleTerminal(42, 'interrupted', 'early failure');
  const registered = registry.register({
    downloadId: 42, targetTabId: 7, imageId: 'img-1', requestedFilename: 'a.jpg'
  });
  await Promise.all([early, registered]);
  assert.deepEqual(notifications, [{ state: 'interrupted', error: 'early failure' }]);
  assert.deepEqual(storage.current(), []);
});

test('single interruption exposes retry and a new accepted id can later complete', async () => {
  const storage = createStorage();
  const notifications = [];
  const { SingleDownloadRegistry } = await loadTsModule('src/background/single-download-registry.ts');
  const registry = new SingleDownloadRegistry({
    storage,
    async search({ id }) { return [{ id, state: 'in_progress' }]; },
    async notify(meta, state, error) { notifications.push({ id: meta.downloadId, state, error }); }
  });

  await registry.register({ downloadId: 51, targetTabId: 7, imageId: 'img-1', requestedFilename: 'a.jpg' });
  await registry.handleTerminal(51, 'interrupted', 'network failed');
  await registry.register({ downloadId: 52, targetTabId: 7, imageId: 'img-1', requestedFilename: 'a.jpg' });
  await registry.handleTerminal(52, 'complete');

  assert.deepEqual(notifications, [
    { id: 51, state: 'interrupted', error: 'network failed' },
    { id: 52, state: 'complete', error: undefined }
  ]);
  assert.deepEqual(await registry.getRecords(), []);
});

test('restart reconciles complete, interrupted, and missing pending singles and clears persistence', async () => {
  for (const browserState of ['complete', 'interrupted', 'missing']) {
    const storage = createStorage([record(61)]);
    const notifications = [];
    const { SingleDownloadRegistry } = await loadTsModule('src/background/single-download-registry.ts');
    const registry = new SingleDownloadRegistry({
      storage,
      async search() {
        return browserState === 'missing' ? [] : [{ id: 61, state: browserState, error: browserState === 'interrupted' ? 'disk' : undefined }];
      },
      async notify(_meta, state, error) { notifications.push({ state, error }); }
    });

    await registry.getRecords();
    assert.deepEqual(storage.current(), []);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].state, browserState === 'complete' ? 'complete' : 'interrupted');
    if (browserState === 'missing') assert.match(notifications[0].error, /missing/);
  }
});

test('tab disappearance removes pending metadata without stale content messaging', async () => {
  const storage = createStorage([record(71), { ...record(72), targetTabId: 8, imageId: 'img-2' }]);
  const notifications = [];
  const removed = [];
  const { SingleDownloadRegistry } = await loadTsModule('src/background/single-download-registry.ts');
  const registry = new SingleDownloadRegistry({
    storage,
    async search({ id }) { return [{ id, state: 'in_progress' }]; },
    async notify(meta) { notifications.push(meta.downloadId); },
    onRemoved(meta) { removed.push(meta.downloadId); }
  });
  await registry.getRecords();
  await registry.removeForTab(7);
  await registry.handleTerminal(71, 'complete');

  assert.deepEqual(notifications, []);
  assert.deepEqual(removed, [71]);
  assert.deepEqual((await registry.getRecords()).map(({ downloadId }) => downloadId), [72]);
});

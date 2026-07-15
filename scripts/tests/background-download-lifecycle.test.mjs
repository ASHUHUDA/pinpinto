import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function installBackgroundChrome() {
  globalThis.document = {};
  const sessionValues = {};
  const tabMessages = [];
  const downloadCalls = [];
  let onMessage;
  let onDownloadChanged;
  let nextDownloadId = 1;
  let rejectNext = false;
  const area = {
    async get(key) {
      if (typeof key === 'string') return { [key]: sessionValues[key] };
      return { ...sessionValues };
    },
    async set(update) { Object.assign(sessionValues, update); },
    async remove(key) { delete sessionValues[key]; }
  };
  globalThis.chrome = {
    runtime: {
      id: 'pinpinto-test',
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { onMessage = listener; } },
      async sendMessage() {},
      getManifest() { return { content_scripts: [{ js: ['content.js'] }] }; },
      openOptionsPage() {}
    },
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
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
      async download(options) {
        downloadCalls.push(options);
        if (rejectNext) {
          rejectNext = false;
          throw new Error('browser rejected');
        }
        return nextDownloadId++;
      },
      async search({ id }) { return [{ id, state: 'in_progress' }]; },
      async cancel() {}
    },
    storage: { session: area, local: area, sync: area },
    scripting: { async executeScript() { return [{ result: true }]; } }
  };
  return {
    sessionValues,
    tabMessages,
    downloadCalls,
    rejectNext() { rejectNext = true; },
    emit(delta) { onDownloadChanged(delta); },
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

function request(imageId) {
  return {
    action: 'downloadImage',
    imageData: { id: imageId, url: 'https://example.com/a.jpg', title: 'A', originalFilename: 'a.jpg' },
    settings: { highQuality: false }
  };
}

test('background persists single origin, reports pending acceptance, settles retry/success, and removes records immediately', async () => {
  const harness = installBackgroundChrome();
  await loadTsModule('src/background.ts');

  const first = await harness.message(request('img-1'));
  assert.deepEqual(first, { success: true, downloadId: 1 });
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads.map(({ downloadId, targetTabId, imageId, state }) => ({
    downloadId, targetTabId, imageId, state
  })), [{ downloadId: 1, targetTabId: 7, imageId: 'img-1', state: 'pending' }]);

  harness.emit({ id: 1, state: { current: 'interrupted' }, error: { current: 'disk full' } });
  const interrupted = await waitFor(() => harness.tabMessages.find(({ message }) =>
    message.action === 'settleSingleDownload' && message.state === 'interrupted'));
  assert.equal(interrupted.tabId, 7);
  assert.equal(interrupted.message.imageId, 'img-1');
  assert.equal(interrupted.message.error, 'disk full');
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads, []);

  const retry = await harness.message(request('img-1'));
  assert.deepEqual(retry, { success: true, downloadId: 2 });
  harness.emit({ id: 2, state: { current: 'complete' } });
  await waitFor(() => harness.tabMessages.find(({ message }) =>
    message.action === 'settleSingleDownload' && message.state === 'complete'));
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads, []);

  harness.rejectNext();
  const rejected = await harness.message(request('img-2'));
  assert.match(rejected.error, /browser rejected/);
  assert.equal(rejected.success, undefined);
  assert.deepEqual(harness.sessionValues.pinpintoSingleDownloads, []);
});

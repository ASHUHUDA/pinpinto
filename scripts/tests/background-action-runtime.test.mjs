import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'node:timers';

import { loadTsModule } from './helpers/load-ts-module.mjs';
import {
  installMinimalDom,
  restoreActionRuntimeGlobals
} from './helpers/action-runtime-harness.mjs';

afterEach(restoreActionRuntimeGlobals);

test('background generic cancel does not cancel an in-flight single-image download', async () => {
  installMinimalDom();
  globalThis.setTimeout = nodeSetTimeout;
  globalThis.clearTimeout = nodeClearTimeout;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; }
  });

  let onMessageListener;
  const downloadCalls = [];
  const cancelCalls = [];

  globalThis.chrome = {
    runtime: {
      id: 'pinpinto-test',
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          onMessageListener = listener;
        }
      },
      async sendMessage() {},
      openOptionsPage() {}
    },
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      async query() { return []; },
      async sendMessage() {},
      async get() { return null; }
    },
    contextMenus: {
      removeAll(callback) { callback?.(); },
      create() {},
      onClicked: { addListener() {} }
    },
    downloads: {
      onChanged: { addListener() {} },
      onDeterminingFilename: { addListener() {} },
      async download(options) {
        downloadCalls.push(options);
        return 77;
      },
      async cancel(downloadId) {
        cancelCalls.push(downloadId);
      }
    },
    sidePanel: { setPanelBehavior() {} },
    storage: {
      sync: {
        async get() { return {}; },
        async set() {},
        async remove() {}
      },
      local: {
        async get() { return {}; },
        async set() {}
      },
      session: {
        async get() { return {}; },
        async set() {}
      }
    },
    scripting: {
      async executeScript() { return [{ result: true }]; }
    }
  };

  await loadTsModule('src/background.ts');
  assert.equal(typeof onMessageListener, 'function');

  class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) super('2026-05-05T10:11:12Z');
      else super(...args);
    }
  }
  globalThis.Date = FixedDate;

  const singleDownloadResponse = await new Promise((resolve) => {
    onMessageListener({
      action: 'downloadImage',
      imageData: {
        url: 'https://example.com/a.png',
        title: 'A',
        originalFilename: 'a.png'
      },
      settings: {}
    }, {}, resolve);
  });

  assert.equal(singleDownloadResponse.success, true);
  assert.equal(downloadCalls.length, 1);
  assert.match(downloadCalls[0].filename, /^PinPinto\/PinPinto-\d{8}_\d{6}\.png$/);

  const cancelResponse = await new Promise((resolve) => {
    onMessageListener({ action: 'cancelDownload' }, {}, resolve);
  });

  assert.equal(cancelResponse.success, true);
  assert.deepEqual(cancelCalls, []);
});

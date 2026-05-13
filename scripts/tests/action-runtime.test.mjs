import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function installMinimalDom() {
  const elements = new Map();

  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          id,
          style: {},
          textContent: '0'
        });
      }
      return elements.get(id);
    }
  };

  globalThis.window = globalThis;
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };
  globalThis.clearTimeout = () => {};
}

test('popup toggleAutoScroll anchors and discards historical images before starting auto-scroll', async () => {
  installMinimalDom();

  const calls = [];
  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, payload) {
        calls.push({ tabId, action: payload.action, payload });
        if (payload.action === 'getViewportAnchor') {
          return { anchorIndex: 3 };
        }
        return { success: true };
      }
    },
    storage: {
      sync: {
        async get() {
          return {
            highQuality: true,
            autoScroll: false,
            autoBatchDownload: true,
            filenameFormat: 'title_date',
            folderOrganization: 'date',
            customFolder: ''
          };
        }
      }
    }
  };

  const timerCallbacks = [];
  globalThis.window.setInterval = (callback) => {
    timerCallbacks.push(callback);
    return 11;
  };
  globalThis.window.clearInterval = () => {};

  const popupActions = await loadTsModule('src/popup/download-actions.ts');

  const savedSettings = [];
  let updateImageCountsCalls = 0;
  const controller = {
    language: 'zh',
    batchCount: 99,
    nextBatchStartIndex: 88,
    activeAutoBatchSize: 77,
    isBatchingNow: false,
    isAutoScrolling: false,
    autoScrollStatsTimer: null,
    async getActivePinterestTab() {
      return { id: 123, url: 'https://www.pinterest.com/test/' };
    },
    async rememberSidebarTargetTab() {},
    async ensureContentScriptInjected() { return true; },
    updateStatsDisplay() {},
    async saveSetting(key, value) {
      savedSettings.push([key, value]);
    },
    setAutoScrollUi() {},
    async updateImageCounts() {
      updateImageCountsCalls++;
    },
    async startDownload() { return true; },
    async toggleAutoScroll() {}
  };

  await popupActions.toggleAutoScroll(controller, true);

  assert.deepEqual(
    calls.map((entry) => entry.action).slice(0, 3),
    ['getViewportAnchor', 'discardImagesBeforeIndex', 'startAutoScroll']
  );
  assert.equal(updateImageCountsCalls, 1);
  assert.equal(controller.isAutoScrolling, true);
  assert.equal(controller.batchCount, 0);
  assert.equal(controller.nextBatchStartIndex, 0);
  assert.equal(controller.activeAutoBatchSize, 0);
  assert.deepEqual(savedSettings.at(-1), ['autoScroll', true]);
  assert.equal(timerCallbacks.length, 1);
});

test('sidebar toggleAutoScroll anchors and discards historical images before starting auto-scroll', async () => {
  installMinimalDom();

  const calls = [];
  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, payload) {
        calls.push({ tabId, action: payload.action, payload });
        if (payload.action === 'getViewportAnchor') {
          return { anchorIndex: 5 };
        }
        return { success: true };
      }
    },
    storage: {
      sync: {
        async get() {
          return {
            highQuality: true,
            autoScroll: false,
            autoBatchDownload: true,
            filenameFormat: 'title_date',
            folderOrganization: 'date',
            customFolder: ''
          };
        }
      }
    }
  };

  const timerCallbacks = [];
  globalThis.window.setInterval = (callback) => {
    timerCallbacks.push(callback);
    return 21;
  };
  globalThis.window.clearInterval = () => {};

  const sidebarActions = await loadTsModule('src/sidebar/download-actions.ts');

  const savedSettings = [];
  let updateStatsCalls = 0;
  const controller = {
    batchCount: 7,
    nextBatchStartIndex: 66,
    activeAutoBatchSize: 12,
    isBatchingNow: false,
    autoScrollStatsTimer: null,
    async resolveTargetTab() {
      return { id: 321, url: 'https://www.pinterest.com/test/' };
    },
    async ensureContentScriptInjected() { return true; },
    updateStatsDisplay() {},
    updateStats() {
      updateStatsCalls++;
      return Promise.resolve();
    },
    async saveSetting(key, value) {
      savedSettings.push([key, value]);
    },
    async startDownload() { return true; },
    async toggleAutoScroll() {},
    t() { return ''; }
  };

  await sidebarActions.toggleAutoScroll(controller, true);

  assert.deepEqual(
    calls.map((entry) => entry.action).slice(0, 3),
    ['getViewportAnchor', 'discardImagesBeforeIndex', 'startAutoScroll']
  );
  assert.equal(updateStatsCalls, 1);
  assert.equal(controller.batchCount, 0);
  assert.equal(controller.nextBatchStartIndex, 0);
  assert.equal(controller.activeAutoBatchSize, 0);
  assert.deepEqual(savedSettings.at(-1), ['autoScroll', true]);
  assert.equal(timerCallbacks.length, 1);
});

test('popup cancelDownload sends batch-cancel message and clears local auto-scroll state', async () => {
  installMinimalDom();

  const runtimeCalls = [];
  globalThis.chrome = {
    runtime: {
      sendMessage(payload) {
        runtimeCalls.push(payload);
      }
    }
  };

  const clearedTimers = [];
  globalThis.window.clearInterval = (timerId) => {
    clearedTimers.push(timerId);
  };

  const popupActions = await loadTsModule('src/popup/download-actions.ts');

  const toggleCalls = [];
  const controller = {
    isBatchingNow: true,
    activeAutoBatchSize: 42,
    autoScrollStatsTimer: 19,
    async toggleAutoScroll(enabled, options) {
      toggleCalls.push({ enabled, options });
    }
  };

  popupActions.cancelDownload(controller);

  assert.deepEqual(runtimeCalls, [{ action: 'cancelCurrentBatch' }]);
  assert.equal(controller.isBatchingNow, false);
  assert.equal(controller.activeAutoBatchSize, 0);
  assert.equal(controller.autoScrollStatsTimer, null);
  assert.deepEqual(clearedTimers, [19]);
  assert.deepEqual(toggleCalls, [{ enabled: false, options: { resetBatchState: false } }]);
});

test('popup deselectAllImages clears the page session and resets batching state', async () => {
  installMinimalDom();

  const tabMessages = [];
  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, payload) {
        tabMessages.push({ tabId, action: payload.action, payload });
        return { success: true };
      }
    }
  };

  const popupActions = await loadTsModule('src/popup/download-actions.ts');

  let updateImageCountsCalls = 0;
  const controller = {
    batchCount: 4,
    nextBatchStartIndex: 120,
    activeAutoBatchSize: 17,
    isBatchingNow: true,
    async getActivePinterestTab() {
      return { id: 456, url: 'https://www.pinterest.com/test/' };
    },
    async ensureContentScriptInjected() { return true; },
    async updateImageCounts() {
      updateImageCountsCalls++;
    }
  };

  await popupActions.deselectAllImages(controller);

  assert.deepEqual(
    tabMessages.map((entry) => entry.action),
    ['clearAllImages']
  );
  assert.equal(controller.batchCount, 0);
  assert.equal(controller.nextBatchStartIndex, 0);
  assert.equal(controller.activeAutoBatchSize, 0);
  assert.equal(controller.isBatchingNow, false);
  assert.equal(updateImageCountsCalls, 1);
});

test('sidebar cancelDownload sends batch-cancel message and clears local auto-scroll state', async () => {
  installMinimalDom();

  const runtimeCalls = [];
  globalThis.chrome = {
    runtime: {
      sendMessage(payload) {
        runtimeCalls.push(payload);
      }
    }
  };

  const clearedTimers = [];
  globalThis.window.clearInterval = (timerId) => {
    clearedTimers.push(timerId);
  };

  const sidebarActions = await loadTsModule('src/sidebar/download-actions.ts');

  const toggleCalls = [];
  const controller = {
    isBatchingNow: true,
    activeAutoBatchSize: 17,
    autoScrollStatsTimer: 33,
    async toggleAutoScroll(enabled, options) {
      toggleCalls.push({ enabled, options });
    }
  };

  sidebarActions.cancelDownload(controller);

  assert.deepEqual(runtimeCalls, [{ action: 'cancelCurrentBatch' }]);
  assert.equal(controller.isBatchingNow, false);
  assert.equal(controller.activeAutoBatchSize, 0);
  assert.equal(controller.autoScrollStatsTimer, null);
  assert.deepEqual(clearedTimers, [33]);
  assert.deepEqual(toggleCalls, [{ enabled: false, options: { resetBatchState: false } }]);
});

test('sidebar deselectAll clears the page session and resets batching state', async () => {
  installMinimalDom();

  const tabMessages = [];
  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, payload) {
        tabMessages.push({ tabId, action: payload.action, payload });
        return { success: true };
      }
    }
  };

  const sidebarActions = await loadTsModule('src/sidebar/download-actions.ts');

  let updateStatsCalls = 0;
  const controller = {
    batchCount: 3,
    nextBatchStartIndex: 88,
    activeAutoBatchSize: 9,
    isBatchingNow: true,
    async resolveTargetTab() {
      return { id: 654, url: 'https://www.pinterest.com/test/' };
    },
    async ensureContentScriptInjected() { return true; },
    updateStats() {
      updateStatsCalls++;
    }
  };

  await sidebarActions.deselectAll(controller);

  assert.deepEqual(
    tabMessages.map((entry) => entry.action),
    ['clearAllImages']
  );
  assert.equal(controller.batchCount, 0);
  assert.equal(controller.nextBatchStartIndex, 0);
  assert.equal(controller.activeAutoBatchSize, 0);
  assert.equal(controller.isBatchingNow, false);
  assert.equal(updateStatsCalls, 1);
});

test('background generic cancel does not cancel an in-flight single-image download', async () => {
  installMinimalDom();

  let onMessageListener;
  const downloadCalls = [];
  const cancelCalls = [];

  globalThis.chrome = {
    runtime: {
      id: 'pinpinto-test',
      onInstalled: {
        addListener() {}
      },
      onMessage: {
        addListener(listener) {
          onMessageListener = listener;
        }
      },
      async sendMessage() {},
      openOptionsPage() {}
    },
    tabs: {
      onUpdated: {
        addListener() {}
      },
      async query() {
        return [];
      },
      async sendMessage() {},
      async get() {
        return null;
      }
    },
    contextMenus: {
      removeAll(callback) {
        callback?.();
      },
      create() {},
      onClicked: {
        addListener() {}
      }
    },
    downloads: {
      onChanged: {
        addListener() {}
      },
      onDeterminingFilename: {
        addListener() {}
      },
      async download(options) {
        downloadCalls.push(options);
        return 77;
      },
      async cancel(downloadId) {
        cancelCalls.push(downloadId);
      }
    },
    sidePanel: {
      setPanelBehavior() {}
    },
    storage: {
      sync: {
        async get() { return {}; },
        async set() {},
        async remove() {}
      },
      local: {
        async get() { return {}; },
        async set() {}
      }
    },
    scripting: {
      async executeScript() {
        return [{ result: true }];
      }
    }
  };

  await loadTsModule('src/background.ts');

  assert.equal(typeof onMessageListener, 'function');

  const originalDate = globalThis.Date;
  class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super('2026-05-05T10:11:12Z');
      } else {
        super(...args);
      }
    }
  }
  globalThis.Date = FixedDate;

  try {
    const singleDownloadResponse = await new Promise((resolve) => {
      onMessageListener(
        {
          action: 'downloadImage',
          imageData: {
            url: 'https://example.com/a.png',
            title: 'A',
            originalFilename: 'a.png'
          },
          settings: {}
        },
        {},
        resolve
      );
    });

    assert.equal(singleDownloadResponse.success, true);
    assert.equal(downloadCalls.length, 1);
    assert.equal(downloadCalls[0].filename, 'PinPinto/PinPinto-20260505_181112.png');

    const cancelResponse = await new Promise((resolve) => {
      onMessageListener(
        { action: 'cancelDownload' },
        {},
        resolve
      );
    });

    assert.equal(cancelResponse.success, true);
    assert.deepEqual(cancelCalls, []);
  } finally {
    globalThis.Date = originalDate;
  }
});

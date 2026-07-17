import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';
import {
  installMinimalDom,
  restoreActionRuntimeGlobals
} from './helpers/action-runtime-harness.mjs';

afterEach(restoreActionRuntimeGlobals);

test('popup auto-batch delegates scrolling ownership to the background task', async () => {
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
  const startCalls = [];
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
    async startDownload(options) { startCalls.push(options); return true; },
    async toggleAutoScroll() {}
  };

  await popupActions.toggleAutoScroll(controller, true);

  assert.deepEqual(calls, []);
  assert.deepEqual(startCalls, [{ autoBatchMode: true }]);
  assert.equal(updateImageCountsCalls, 0);
  assert.equal(controller.isAutoScrolling, false);
  assert.deepEqual(savedSettings.at(-1), ['autoScroll', true]);
  assert.equal(timerCallbacks.length, 0);
});
test('sidebar auto-batch delegates scrolling ownership to the background task', async () => {
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
  const startCalls = [];
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
    async startDownload(options) { startCalls.push(options); return true; },
    async toggleAutoScroll() {},
    t() { return ''; }
  };

  await sidebarActions.toggleAutoScroll(controller, true);

  assert.deepEqual(calls, []);
  assert.deepEqual(startCalls, [{ autoBatchMode: true }]);
  assert.equal(updateStatsCalls, 0);
  assert.deepEqual(savedSettings.at(-1), ['autoScroll', true]);
  assert.equal(timerCallbacks.length, 0);
});


test('popup auto-batch honors the visible limit input before storage catches up', async () => {
  installMinimalDom();
  document.getElementById('totalImages').textContent = '25';
  document.getElementById('autoBatchLimit').value = '25';
  document.getElementById('autoBatchTotalBatches').value = '3';

  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, payload) {
        if (payload.action === 'getViewportAnchor') return { anchorIndex: 0 };
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
            autoBatchLimit: 100,
            autoBatchTotalBatches: 0,
            filenameFormat: 'title_date',
            folderOrganization: 'date',
            customFolder: ''
          };
        }
      }
    }
  };

  const popupActions = await loadTsModule('src/popup/download-actions.ts');
  const startCalls = [];
  const savedSettings = [];
  const controller = {
    language: 'zh',
    isBatchingNow: false,
    isAutoScrolling: false,
    autoScrollStatsTimer: null,
    async getActivePinterestTab() { return { id: 123, url: 'https://www.pinterest.com/test/' }; },
    async rememberSidebarTargetTab() {},
    async ensureContentScriptInjected() { return true; },
    updateStatsDisplay() {},
    async saveSetting(key, value) { savedSettings.push([key, value]); },
    setAutoScrollUi() {},
    async updateImageCounts() {},
    async startBatchTask(request) { startCalls.push(request); return { accepted: true, jobId: 'job-visible-25' }; },
    async cancelBatchTask() { return true; },
    async toggleAutoScroll() {}
  };

  await popupActions.startDownload(controller, { autoBatchMode: true });

  assert.equal(startCalls[0].autoBatchLimit, 25);
  assert.equal(startCalls[0].autoBatchTotalBatches, 3);
  assert.deepEqual(savedSettings, [
    ['autoBatchLimit', 25],
    ['autoBatchTotalBatches', 3]
  ]);
});

test('popup auto-batch uses the configured image limit', async () => {
  installMinimalDom();
  document.getElementById('totalImages').textContent = '25';

  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, payload) {
        if (payload.action === 'getViewportAnchor') {
          return { anchorIndex: 0 };
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
            autoBatchLimit: 25,
            autoBatchTotalBatches: 3,
            filenameFormat: 'title_date',
            folderOrganization: 'date',
            customFolder: ''
          };
        }
      }
    }
  };

  const popupActions = await loadTsModule('src/popup/download-actions.ts');
  const startCalls = [];
  const controller = {
    language: 'zh',
    batchCount: 0,
    nextBatchStartIndex: 0,
    activeAutoBatchSize: 0,
    isBatchingNow: false,
    isAutoScrolling: false,
    autoScrollStatsTimer: null,
    async getActivePinterestTab() {
      return { id: 123, url: 'https://www.pinterest.com/test/' };
    },
    async rememberSidebarTargetTab() {},
    async ensureContentScriptInjected() { return true; },
    updateStatsDisplay() {},
    async saveSetting() {},
    setAutoScrollUi() {},
    async updateImageCounts() {},
    async startBatchTask(request) { startCalls.push(request); return { accepted: true, jobId: 'job-25' }; },
    async cancelBatchTask() { return true; },
    async toggleAutoScroll() {}
  };

  await popupActions.startDownload(controller, { autoBatchMode: true });

  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].mode, 'auto');
  assert.equal(startCalls[0].targetTabId, 123);
  assert.equal(startCalls[0].autoBatchLimit, 25);
  assert.equal(startCalls[0].autoBatchTotalBatches, 3);
});


test('sidebar auto-batch honors the visible limit input before storage catches up', async () => {
  installMinimalDom();
  document.getElementById('totalImages').textContent = '25';
  document.getElementById('autoBatchLimit').value = '25';
  document.getElementById('autoBatchTotalBatches').value = '3';

  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, payload) {
        if (payload.action === 'getViewportAnchor') return { anchorIndex: 0 };
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
            autoBatchLimit: 100,
            autoBatchTotalBatches: 0,
            filenameFormat: 'title_date',
            folderOrganization: 'date',
            customFolder: ''
          };
        }
      }
    }
  };

  const sidebarActions = await loadTsModule('src/sidebar/download-actions.ts');
  const startCalls = [];
  const savedSettings = [];
  const controller = {
    isBatchingNow: false,
    autoScrollStatsTimer: null,
    async resolveTargetTab() { return { id: 321, url: 'https://www.pinterest.com/test/' }; },
    async ensureContentScriptInjected() { return true; },
    updateStatsDisplay() {},
    async updateStats() {},
    async saveSetting(key, value) { savedSettings.push([key, value]); },
    async startBatchTask(request) { startCalls.push(request); return { accepted: true, jobId: 'job-visible-25' }; },
    async cancelBatchTask() { return true; },
    async toggleAutoScroll() {},
    t() { return ''; }
  };

  await sidebarActions.startDownload(controller, { autoBatchMode: true });

  assert.equal(startCalls[0].autoBatchLimit, 25);
  assert.equal(startCalls[0].autoBatchTotalBatches, 3);
  assert.deepEqual(savedSettings, [
    ['autoBatchLimit', 25],
    ['autoBatchTotalBatches', 3]
  ]);
});

test('sidebar auto-batch uses the configured image limit', async () => {
  installMinimalDom();
  document.getElementById('totalImages').textContent = '25';

  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, payload) {
        if (payload.action === 'getViewportAnchor') {
          return { anchorIndex: 0 };
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
            autoBatchLimit: 25,
            autoBatchTotalBatches: 3,
            filenameFormat: 'title_date',
            folderOrganization: 'date',
            customFolder: ''
          };
        }
      }
    }
  };

  const sidebarActions = await loadTsModule('src/sidebar/download-actions.ts');
  const startCalls = [];
  const controller = {
    batchCount: 0,
    nextBatchStartIndex: 0,
    activeAutoBatchSize: 0,
    isBatchingNow: false,
    autoScrollStatsTimer: null,
    async resolveTargetTab() {
      return { id: 321, url: 'https://www.pinterest.com/test/' };
    },
    async ensureContentScriptInjected() { return true; },
    updateStatsDisplay() {},
    async updateStats() {},
    async saveSetting() {},
    async startBatchTask(request) { startCalls.push(request); return { accepted: true, jobId: 'job-25' }; },
    async cancelBatchTask() { return true; },
    async toggleAutoScroll() {},
    t() { return ''; }
  };

  await sidebarActions.startDownload(controller, { autoBatchMode: true });

  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].mode, 'auto');
  assert.equal(startCalls[0].targetTabId, 321);
  assert.equal(startCalls[0].autoBatchLimit, 25);
  assert.equal(startCalls[0].autoBatchTotalBatches, 3);
});

test('popup cancelDownload sends batch-cancel message and clears local auto options', async () => {
  installMinimalDom();
  document.getElementById('autoScrollToggle').checked = true;
  document.getElementById('autoBatchToggle').checked = true;

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

  const savedSettings = [];
  const autoScrollUiCalls = [];
  const controller = {
    language: 'zh',
    isBatchingNow: true,
    isAutoScrolling: true,
    activeAutoBatchSize: 42,
    autoScrollStatsTimer: 19,
    async saveSetting(key, value) {
      savedSettings.push([key, value]);
    },
    setAutoScrollUi(enabled) {
      autoScrollUiCalls.push(enabled);
      document.getElementById('autoScrollToggle').checked = enabled;
    },
    async cancelBatchTask() {
      runtimeCalls.push({ action: 'cancelCurrentBatch' });
      return true;
    }
  };

  popupActions.cancelDownload(controller);

  assert.deepEqual(runtimeCalls, [{ action: 'cancelCurrentBatch' }]);
  assert.equal(controller.isBatchingNow, false);
  assert.equal(controller.isAutoScrolling, false);
  assert.equal(controller.autoScrollStatsTimer, null);
  assert.deepEqual(clearedTimers, [19]);
  assert.deepEqual(autoScrollUiCalls, [false]);
  assert.equal(document.getElementById('autoScrollToggle').checked, false);
  assert.equal(document.getElementById('autoBatchToggle').checked, false);
  assert.deepEqual(savedSettings, [
    ['autoScroll', false],
    ['autoBatchDownload', false]
  ]);
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
  assert.equal(controller.isBatchingNow, false);
  assert.equal(updateImageCountsCalls, 1);
});

test('sidebar cancelDownload sends batch-cancel message and clears local auto options', async () => {
  installMinimalDom();
  document.getElementById('autoScrollToggle').checked = true;
  document.getElementById('autoBatchToggle').checked = true;

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

  const savedSettings = [];
  const controller = {
    isBatchingNow: true,
    activeAutoBatchSize: 17,
    autoScrollStatsTimer: 33,
    async saveSetting(key, value) {
      savedSettings.push([key, value]);
    },
    async cancelBatchTask() {
      runtimeCalls.push({ action: 'cancelCurrentBatch' });
      return true;
    }
  };

  sidebarActions.cancelDownload(controller);

  assert.deepEqual(runtimeCalls, [{ action: 'cancelCurrentBatch' }]);
  assert.equal(controller.isBatchingNow, false);
  assert.equal(controller.autoScrollStatsTimer, null);
  assert.deepEqual(clearedTimers, [33]);
  assert.equal(document.getElementById('autoScrollToggle').checked, false);
  assert.equal(document.getElementById('autoBatchToggle').checked, false);
  assert.deepEqual(savedSettings, [
    ['autoScroll', false],
    ['autoBatchDownload', false]
  ]);
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
  assert.equal(controller.isBatchingNow, false);
  assert.equal(updateStatsCalls, 1);
});

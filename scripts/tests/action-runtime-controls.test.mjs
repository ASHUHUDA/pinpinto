import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';
import {
  installMinimalDom,
  restoreActionRuntimeGlobals
} from './helpers/action-runtime-harness.mjs';

afterEach(restoreActionRuntimeGlobals);

for (const surface of ['popup', 'sidebar']) {
  test(`${surface} auto-download toggle persists both switches before start and requests graceful stop without disabling scroll`, async () => {
    installMinimalDom();
    const actions = await loadTsModule(`src/${surface}/download-actions.ts`);
    const events = [];
    const controller = {
      isBatchingNow: true,
      isAutoScrolling: false,
      autoScrollStatsTimer: null,
      async saveSetting(key, value) { events.push(`save:${key}:${value}`); },
      setAutoScrollUi(value) { events.push(`scroll-ui:${value}`); },
      setAutoBatchUi(value) { events.push(`batch-ui:${value}`); },
      async toggleAutoScroll(value) { events.push(`toggle-scroll:${value}`); },
      async stopBatchAfterCurrent(value) { events.push(`stop-after:${value}`); return true; }
    };

    await actions.toggleAutoBatchDownload(controller, true);
    assert.deepEqual(events, [
      'save:autoScroll:true',
      'save:autoBatchDownload:true',
      'scroll-ui:true',
      'batch-ui:true',
      'toggle-scroll:true'
    ]);

    events.length = 0;
    await actions.toggleAutoBatchDownload(controller, false);
    assert.deepEqual(events, [
      'save:autoBatchDownload:false',
      'save:autoScroll:true',
      'batch-ui:false',
      'scroll-ui:true',
      'stop-after:true'
    ]);
    assert.equal(controller.isBatchingNow, true, 'graceful stopping keeps task progress active');
  });

  test(`${surface} auto-scroll off distinguishes an active auto task from ordinary scrolling`, async () => {
    installMinimalDom();
    const tabMessages = [];
    let storedAutoBatch = true;
    globalThis.chrome = {
      storage: { sync: { async get() { return { autoBatchDownload: storedAutoBatch }; } } },
      tabs: {
        async sendMessage(tabId, message) {
          tabMessages.push({ tabId, message });
          return { success: true };
        }
      }
    };
    const actions = await loadTsModule(`src/${surface}/download-actions.ts`);
    const events = [];
    const controller = {
      language: 'en',
      isBatchingNow: true,
      isAutoScrolling: true,
      autoScrollStatsTimer: null,
      async getActivePinterestTab() { return { id: 41, url: 'https://www.pinterest.com/test/' }; },
      async resolveTargetTab() { return { id: 41, url: 'https://www.pinterest.com/test/' }; },
      async ensureContentScriptInjected() { return true; },
      async saveSetting(key, value) { events.push(`save:${key}:${value}`); },
      setAutoScrollUi(value) { events.push(`scroll-ui:${value}`); },
      setAutoBatchUi(value) { events.push(`batch-ui:${value}`); },
      async stopBatchAfterCurrent(value) { events.push(`stop-after:${value}`); return true; },
      async updateImageCounts() {},
      async updateStats() {},
      t() { return ''; }
    };

    await actions.toggleAutoScroll(controller, false);
    assert.deepEqual(events, [
      'save:autoScroll:false',
      'save:autoBatchDownload:false',
      'scroll-ui:false',
      'batch-ui:false',
      'stop-after:false'
    ]);
    assert.deepEqual(tabMessages, [], 'background finish owns the active auto session');
    assert.equal(controller.isBatchingNow, true);

    events.length = 0;
    storedAutoBatch = false;
    controller.isBatchingNow = false;
    await actions.toggleAutoScroll(controller, false);
    assert.deepEqual(events, [
      'scroll-ui:false',
      'batch-ui:false',
      'save:autoScroll:false'
    ]);
    assert.deepEqual(tabMessages.map(({ message }) => message.action), ['stopAutoScroll']);
  });

  test(`${surface} manual start explicitly supplies the persisted ZIP choice`, async () => {
    installMinimalDom();
    globalThis.chrome = {
      storage: {
        sync: {
          async get() {
            return {
              highQuality: true,
              autoScroll: false,
              autoBatchDownload: false,
              downloadAsZip: false,
              singleImageDownloadMethod: 'browser',
              autoBatchLimit: 100,
              autoBatchTotalBatches: 0,
              filenameFormat: 'title_date',
              folderOrganization: 'date',
              customFolder: ''
            };
          }
        }
      },
      tabs: {
        async sendMessage(_tabId, message) {
          if (message.action === 'getSelectedImages') {
            return { images: [{ id: 'image-1', url: 'https://i.pinimg.com/a.jpg' }] };
          }
          return { success: true };
        }
      }
    };
    const actions = await loadTsModule(`src/${surface}/download-actions.ts`);
    const starts = [];
    const controller = {
      language: 'en',
      isBatchingNow: false,
      isAutoScrolling: false,
      autoScrollStatsTimer: null,
      async getActivePinterestTab() { return { id: 51, url: 'https://www.pinterest.com/test/' }; },
      async resolveTargetTab() { return { id: 51, url: 'https://www.pinterest.com/test/' }; },
      async rememberSidebarTargetTab() {},
      async ensureContentScriptInjected() { return true; },
      async updateImageCounts() {},
      async updateStats() {},
      async startBatchTask(request) { starts.push(request); return { accepted: true, jobId: 'manual-1' }; },
      t(key) { return key; }
    };

    assert.equal(await actions.startDownload(controller), true);
    assert.equal(starts[0].mode, 'manual');
    assert.equal(starts[0].downloadAsZip, false);
    assert.equal(starts[0].settings.downloadAsZip, false);
  });
}

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/load-ts-module.mjs';
import { installIndexedDb } from './helpers/indexeddb.mjs';
import { createGlobalCleanup } from './helpers/global-cleanup.mjs';
import { createHost, createStorage, installChrome, waitFor, completedBroadcast, persistedSnapshot, activeWindow, restoreBatchCoordinatorGlobals } from './helpers/batch-coordinator-harness.mjs';
afterEach(restoreBatchCoordinatorGlobals);
afterEach(createGlobalCleanup(['indexedDB']));
const image = (id) => ({ id, url: `https://i.pinimg.com/originals/${id}.jpg` });

async function harness(options = {}) {
  const storage = createStorage(options.snapshot);
  const messages = [];
  const browser = installChrome(storage, options.browser);
  const host = createHost(messages);
  const calls = [];
  const { BatchCoordinator } = await loadTsModule('src/background/batch-coordinator.ts');
  host.createAria2Client = async () => ({ addUri: async (...args) => { calls.push(args); return options.submit?.(...args) ?? '0123456789abcdef'; } });
  const coordinator = new BatchCoordinator(host);
  return { coordinator, browser, storage, messages, calls, host };
}

test('manual aria2 handoff deduplicates and never invokes browser/Blob or clears cards', async () => {
  const h = await harness();
  h.host.createAria2Client = async () => ({ addUri: async (url) => { h.calls.push([url]); return '0123456789abcdef'; } });
  await h.coordinator.start({ mode: 'manual', targetTabId: 9, images: [image('a'), image('a'), image('b')], settings: { batchDownloadMethod: 'aria2' } });
  const finished = await waitFor(() => completedBroadcast(h.messages)?.snapshot);
  assert.equal(finished.outputMode, 'aria2');
  assert.equal(finished.aria2SubmittedCount, 2);
  assert.match(finished.details, /并非下载完成/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.browser.downloadCalls, []);
  assert.deepEqual(h.host.releaseCalls, []);
  assert.equal(h.browser.tabMessages.some(({ message }) => message.action === 'clearAllImages'), false);
  assert.equal(h.storage.current(), null);
});

test('explicit RPC rejection is skipped in an automatic window and does not block the next image', async () => {
  installIndexedDb();
  const h = await harness();
  delete h.host.createAria2Client;
  globalThis.chrome.permissions = { async contains() { return true; } };
  globalThis.fetch = async (_, request) => {
    const body = JSON.parse(request.body);
    const url = body.method === 'aria2.addUri' ? body.params[0][0] : '';
    if (url) h.calls.push([url]);
    return { ok: true, async json() {
      return { jsonrpc: '2.0', id: body.id,
        ...(!url || url.endsWith('/b.jpg') ? { error: { code: 1, message: 'rejected' } } : { result: body.params[1].gid }) };
    } };
  };
  const started = await h.coordinator.start({ mode: 'auto', targetTabId: 19, settings: { batchDownloadMethod: 'aria2' } });
  await waitFor(() => h.browser.tabMessages.length > 0);
  await h.coordinator.acceptAutoBatchWindow({ jobId: started.jobId, images: [image('a'), image('b'), image('c')], startOffset: 0, endOffset: 3, finalWindow: true }, 19);
  const finished = await waitFor(() => completedBroadcast(h.messages)?.snapshot);
  assert.equal(finished.aria2SubmittedCount, 2);
  assert.equal(finished.aria2RejectedCount, 1);
  assert.equal(finished.batchCursor, 3);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.browser.downloadCalls, []);
});

test('automatic aria2 handoff commits then advances cursor and resumes; no browser download terminal is needed', async () => {
  const h = await harness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.host.createAria2Client = async () => ({ addUri: async (url) => { h.calls.push([url]); await gate; return '0123456789abcdef'; } });
  const started = await h.coordinator.start({ mode: 'auto', targetTabId: 19, autoBatchLimit: 1, settings: { batchDownloadMethod: 'aria2' } });
  await waitFor(() => h.browser.tabMessages.some(({ message }) => message.action === 'startAutoBatchSession'));
  assert.equal(await h.coordinator.acceptAutoBatchWindow({ jobId: started.jobId, images: [image('a')], startOffset: 0, endOffset: 1 }, 19), true);
  await waitFor(() => h.calls.length === 1);
  assert.equal((await h.coordinator.getSnapshot()).batchCursor, 0);
  assert.equal(h.browser.tabMessages.some(({ message }) => message.action === 'commitAutoBatchWindow'), false);
  release();
  await waitFor(() => h.browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'));
  const snapshot = await h.coordinator.getSnapshot();
  assert.equal(snapshot.batchCursor, 1);
  assert.equal(snapshot.aria2SubmittedCount, 1);
  assert.equal(snapshot.activeWindow, null);
  assert.deepEqual(h.browser.downloadCalls, []);
  assert.deepEqual(h.browser.tabMessages.filter(({ message }) => ['commitAutoBatchWindow', 'resumeAutoBatchSession'].includes(message.action)).map(({ message }) => message.action), ['commitAutoBatchWindow', 'resumeAutoBatchSession']);
  assert.equal(await h.coordinator.acceptAutoBatchWindow({ jobId: started.jobId, images: [image('b')], startOffset: 1, endOffset: 2, finalWindow: true }, 19), true);
  const finished = await waitFor(() => completedBroadcast(h.messages)?.snapshot);
  assert.equal(finished.aria2SubmittedCount, 2);
  assert.equal(finished.batchCursor, 2);
});

test('transport ambiguity stops automatic submissions without commit, cursor advance, fallback or replay', async () => {
  const h = await harness({ submit: async () => { throw new Error('connection lost'); } });
  const started = await h.coordinator.start({ mode: 'auto', targetTabId: 19, settings: { batchDownloadMethod: 'aria2' } });
  await waitFor(() => h.browser.tabMessages.length > 0);
  await h.coordinator.acceptAutoBatchWindow({ jobId: started.jobId, images: [image('a'), image('b')], startOffset: 0, endOffset: 2 }, 19);
  const failed = await waitFor(async () => { const s = await h.coordinator.getSnapshot(); return s?.phase === 'failed' ? s : null; });
  assert.equal(failed.batchCursor, 0);
  assert.equal(failed.activeWindow.aria2Submission.uncertainCount, 1);
  assert.equal(failed.activeWindow.aria2Submission.remainingCount, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.browser.tabMessages.some(({ message }) => ['commitAutoBatchWindow', 'resumeAutoBatchSession'].includes(message.action)), false);
  assert.deepEqual(h.browser.downloadCalls, []);
});

test('cancel stops later submissions and never removes tasks already handed to aria2', async () => {
  let release;
  const h = await harness({ submit: async () => new Promise((resolve) => { release = resolve; }) });
  const started = await h.coordinator.start({ mode: 'manual', images: [image('a'), image('b')], settings: { batchDownloadMethod: 'aria2' } });
  await waitFor(() => h.calls.length === 1);
  assert.equal(await h.coordinator.cancel(started.jobId), true);
  release('0123456789abcdef');
  const snapshot = await h.coordinator.getSnapshot();
  assert.equal(snapshot.phase, 'cancelled');
  assert.match(snapshot.details, /不会撤销/);
  assert.match(snapshot.details, /状态不明 1/);
  assert.deepEqual(h.browser.cancelCalls, []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.calls.length, 1);
  assert.equal((await h.coordinator.getSnapshot()).phase, 'cancelled');
});

test('worker recovery never resubmits an unfinished aria2 window', async () => {
  const h = await harness({ snapshot: persistedSnapshot({
    mode: 'auto', outputMode: 'aria2', phase: 'downloading',
    activeWindow: activeWindow({ expectedDownloadIds: [], downloadStates: {}, hostJobId: null,
      aria2Submission: { submittedCount: 1, rejectedCount: 0, uncertainCount: 0, remainingCount: 1, inFlight: true, done: false } })
  }) });
  const snapshot = await h.coordinator.getSnapshot();
  assert.equal(snapshot.phase, 'interrupted');
  assert.equal(snapshot.outputMode, 'aria2');
  assert.match(snapshot.details, /状态不明 1/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.browser.tabMessages.some(({ message }) => message.action === 'commitAutoBatchWindow'), false);
});

test('aria2 automatic handoff still requires a valid content compaction acknowledgement', async () => {
  const h = await harness({ browser: { sendMessage: async (tabId, message) => message.action === 'commitAutoBatchWindow'
    ? { success: true, baseOffset: -1, retainedCount: 0 } : { success: true } } });
  const start = await h.coordinator.start({ mode: 'auto', targetTabId: 19, settings: { batchDownloadMethod: 'aria2' } });
  await waitFor(() => h.browser.tabMessages.length);
  await h.coordinator.acceptAutoBatchWindow({ jobId: start.jobId, images: [image('a')], startOffset: 0, endOffset: 1 }, 19);
  const failed = await waitFor(async () => { const s = await h.coordinator.getSnapshot(); return s?.phase === 'failed' ? s : null; });
  assert.equal(failed.batchCursor, 0);
  assert.equal(failed.activeWindow.aria2Submission.submittedCount, 1);
  assert.equal(h.browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'), false);
});

test('graceful stop finishes the current aria2 handoff and commit without resuming or revoking downloads', async () => {
  let release;
  const h = await harness({ submit: async () => new Promise((resolve) => { release = resolve; }) });
  const start = await h.coordinator.start({ mode: 'auto', targetTabId: 19, settings: { batchDownloadMethod: 'aria2' } });
  await waitFor(() => h.browser.tabMessages.length);
  await h.coordinator.acceptAutoBatchWindow({ jobId: start.jobId, images: [image('a')], startOffset: 0, endOffset: 1 }, 19);
  await waitFor(() => h.calls.length);
  assert.equal(await h.coordinator.stopAutoBatchAfterCurrent(start.jobId, false), true);
  release('0123456789abcdef');
  const finished = await waitFor(() => completedBroadcast(h.messages)?.snapshot);
  assert.equal(finished.aria2SubmittedCount, 1);
  assert.equal(finished.batchCursor, 1);
  assert.match(finished.details, /文件下载由下载器负责/);
  assert.equal(h.browser.tabMessages.some(({ message }) => message.action === 'resumeAutoBatchSession'), false);
  assert.deepEqual(h.browser.cancelCalls, []);
});

test('recovery commits a fully persisted aria2 handoff window without sending images again', async () => {
  const h = await harness({ snapshot: persistedSnapshot({
    mode: 'auto', outputMode: 'aria2', phase: 'downloading',
    activeWindow: activeWindow({ expectedDownloadIds: [], downloadStates: {}, hostJobId: null,
      aria2Submission: { submittedCount: 1, rejectedCount: 0, uncertainCount: 0, remainingCount: 0, inFlight: false, done: true } })
  }) });
  await h.coordinator.getSnapshot();
  const finished = completedBroadcast(h.messages)?.snapshot;
  assert.equal(finished.aria2SubmittedCount, 1);
  assert.deepEqual(h.calls, []);
  assert.equal(h.browser.tabMessages.some(({ message }) => message.action === 'commitAutoBatchWindow'), true);
});

test('single-image aria2 submits the preferred URL and reports handoff without controlled browser registration', async () => {
  const { SingleImageDownloadService } = await loadTsModule('src/background/single-image-download.ts');
  const calls = [];
  const service = new SingleImageDownloadService({
    blobHost: { async start() { assert.fail('Blob path used'); } },
    async registerBrowserDownload() { assert.fail('browser registration used'); }, removeTrackedDownload() {},
    async download() { assert.fail('browser path used'); },
    async submitAria2(...args) { calls.push(args); return '0123456789abcdef'; }
  });
  const result = await service.start({ imageData: { id: 'a', url: 'https://i.pinimg.com/236x/a.jpg' }, settings: { singleImageDownloadMethod: 'aria2', highQuality: true } });
  assert.deepEqual(result, { success: true, method: 'aria2', state: 'submitted', gid: '0123456789abcdef' });
  assert.equal(calls[0][0], 'https://i.pinimg.com/originals/a.jpg');
  assert.equal(calls[0][1].includes('/'), false);
});

test('ambiguous single submission disables retry and retains the card', async () => {
  const { acceptSingleDownload, createSingleDownloadState, settleSingleDownload } = await loadTsModule('src/content/single-download-state.ts');
  const pending = acceptSingleDownload(createSingleDownloadState('a')).state;
  const unknown = settleSingleDownload(pending, { state: 'uncertain', error: 'check queue' });
  assert.equal(unknown.disabled, true);
  assert.equal(unknown.removeImageId, null);
  assert.equal(acceptSingleDownload(unknown).accepted, false);
});

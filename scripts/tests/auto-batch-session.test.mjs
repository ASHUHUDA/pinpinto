import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

test('content auto-batch session emits a full window, resumes, then emits the exhausted tail', async () => {
  const messages = [];
  const timers = [];
  const calls = [];
  let totalImages = 100;
  let exhausted = false;
  const images = Array.from({ length: 125 }, (_, index) => ({ id: `img-${index + 1}`, url: `https://example.com/${index + 1}.jpg` }));
  const { AutoBatchSessionController } = await loadTsModule('src/content/auto-batch-session.ts');
  const controller = new AutoBatchSessionController({
    scanForImages() { calls.push('scan'); },
    getTotalImages() { return totalImages; },
    getImagesInRange(start, end) { return images.slice(start, end); },
    getViewportAnchorIndex() { return 4; },
    discardImagesBeforeIndex(index) { calls.push(`discard:${index}`); },
    startAutoScroll() { calls.push('start-scroll'); },
    stopAutoScroll() { calls.push('stop-scroll'); },
    getAutoScrollStopReason() { return exhausted ? 'exhausted' : null; },
    async sendMessage(message) {
      messages.push(message);
      return message.action === 'finishAutoBatchSession' ? { success: true } : { accepted: true };
    },
    setInterval(callback) { timers.push(callback); return timers.length; },
    clearInterval() {}
  });

  await controller.start({ jobId: 'job-1', limit: 100, settings: { highQuality: true } });
  await timers[0]();

  assert.deepEqual(calls.slice(0, 3), ['discard:4', 'start-scroll', 'scan']);
  assert.deepEqual(messages[0], {
    action: 'autoBatchWindowReady',
    jobId: 'job-1',
    images: images.slice(0, 100),
    settings: { highQuality: true },
    startIndex: 0,
    endIndex: 100,
    finalWindow: false
  });

  totalImages = 125;
  exhausted = true;
  await controller.resume({ jobId: 'job-1', nextCursor: 100, limit: 100, settings: { highQuality: true } });
  await timers[1]();

  assert.deepEqual(messages[1], {
    action: 'autoBatchWindowReady',
    jobId: 'job-1',
    images: images.slice(100, 125),
    settings: { highQuality: true },
    startIndex: 100,
    endIndex: 125,
    finalWindow: true
  });
});

test('content auto-batch session finishes an exhausted empty session and ignores mismatched cancellation', async () => {
  const messages = [];
  const timers = [];
  let stopCalls = 0;
  const { AutoBatchSessionController } = await loadTsModule('src/content/auto-batch-session.ts');
  const controller = new AutoBatchSessionController({
    scanForImages() {},
    getTotalImages() { return 0; },
    getImagesInRange() { return []; },
    getViewportAnchorIndex() { return 0; },
    discardImagesBeforeIndex() {},
    startAutoScroll() {},
    stopAutoScroll() { stopCalls++; },
    getAutoScrollStopReason() { return 'exhausted'; },
    async sendMessage(message) { messages.push(message); return { success: true }; },
    setInterval(callback) { timers.push(callback); return timers.length; },
    clearInterval() {}
  });

  await controller.start({ jobId: 'job-2', limit: 100, settings: {} });
  controller.cancel('another-job');
  assert.equal(controller.getJobId(), 'job-2');
  await timers[0]();

  assert.deepEqual(messages, [{ action: 'finishAutoBatchSession', jobId: 'job-2' }]);
  assert.equal(controller.getJobId(), null);
  assert.equal(stopCalls, 1);
});

test('content resume helper restores only the matching active auto task', async () => {
  const { getAutoBatchResumeInput } = await loadTsModule('src/content/auto-batch-session.ts');
  const snapshot = {
    jobId: 'job-3',
    mode: 'auto',
    targetTabId: 7,
    phase: 'scrolling',
    batchCursor: 200,
    autoBatchLimit: 50,
    settings: { highQuality: true }
  };

  assert.deepEqual(getAutoBatchResumeInput(snapshot, true), {
    jobId: 'job-3',
    nextCursor: 200,
    limit: 50,
    settings: { highQuality: true }
  });
  assert.equal(getAutoBatchResumeInput(snapshot, false), null);
  assert.equal(getAutoBatchResumeInput({ ...snapshot, phase: 'completed' }, true), null);
});

test('exhausted content session retries finish handshake until background accepts it', async () => {
  const timers = [];
  let finishAttempts = 0;
  const { AutoBatchSessionController } = await loadTsModule('src/content/auto-batch-session.ts');
  const controller = new AutoBatchSessionController({
    scanForImages() {},
    getTotalImages() { return 0; },
    getImagesInRange() { return []; },
    getViewportAnchorIndex() { return 0; },
    discardImagesBeforeIndex() {},
    startAutoScroll() {},
    stopAutoScroll() {},
    getAutoScrollStopReason() { return 'exhausted'; },
    async sendMessage() {
      finishAttempts++;
      return { success: finishAttempts >= 2 };
    },
    setInterval(callback) { timers.push(callback); return 1; },
    clearInterval() {}
  });

  await controller.start({ jobId: 'job-retry', limit: 100, settings: {} });
  await timers[0]();
  assert.equal(controller.getJobId(), 'job-retry');
  await timers[0]();
  assert.equal(controller.getJobId(), null);
  assert.equal(finishAttempts, 2);
});

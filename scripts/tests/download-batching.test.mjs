import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

test('download batching helpers preserve auto batch limit and thresholds', async () => {
  const {
    AUTO_BATCH_DOWNLOAD_LIMIT,
    getNextBatchThreshold,
    shouldTriggerAutoBatch
  } = await loadTsModule('src/shared/download-batching.ts');

  assert.equal(AUTO_BATCH_DOWNLOAD_LIMIT, 100);
  assert.equal(getNextBatchThreshold(0), 100);
  assert.equal(getNextBatchThreshold(1), 200);
  assert.equal(shouldTriggerAutoBatch(99, 0, true), false);
  assert.equal(shouldTriggerAutoBatch(100, 0, true), true);
  assert.equal(shouldTriggerAutoBatch(200, 1, true), true);
  assert.equal(shouldTriggerAutoBatch(200, 1, false), false);
});

test('sliceBatchWindow preserves batch windows and overflow fallback', async () => {
  const { sliceBatchWindow } = await loadTsModule('src/shared/download-batching.ts');
  const images = Array.from({ length: 250 }, (_, index) => `image-${index + 1}`);

  assert.deepEqual(sliceBatchWindow(images, 0, 100), images.slice(0, 100));
  assert.deepEqual(sliceBatchWindow(images, 1, 100), images.slice(100, 200));
  assert.deepEqual(sliceBatchWindow(images, 99, 100), images.slice(-100));
});

test('cursor batch planning can finish an exhausted partial batch without repeating', async () => {
  const {
    getAutoBatchPlan,
    sliceBatchWindowFromIndex
  } = await loadTsModule('src/shared/download-batching.ts');
  const images = Array.from({ length: 180 }, (_, index) => `image-${index + 1}`);

  assert.deepEqual(
    getAutoBatchPlan(180, 100, true, { autoScrollExhausted: false, limit: 100 }),
    { shouldStart: false, startIndex: 100, endIndex: 100, partial: false }
  );
  assert.deepEqual(
    getAutoBatchPlan(180, 100, true, { autoScrollExhausted: true, limit: 100 }),
    { shouldStart: true, startIndex: 100, endIndex: 180, partial: true }
  );
  assert.deepEqual(sliceBatchWindowFromIndex(images, 100, 180), images.slice(100, 180));
  assert.deepEqual(sliceBatchWindowFromIndex(images, 180, 280), []);
});

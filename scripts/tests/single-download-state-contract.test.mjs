import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

test('single download suppresses duplicate pending clicks and completes with image-scoped cleanup', async () => {
  const {
    createSingleDownloadState,
    acceptSingleDownload,
    settleSingleDownload
  } = await loadTsModule('src/content/single-download-state.ts');

  const idle = createSingleDownloadState('image-1');
  assert.equal(idle.phase, 'idle');

  const accepted = acceptSingleDownload(idle);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.state.phase, 'pending');
  assert.equal(accepted.state.disabled, true);

  const duplicate = acceptSingleDownload(accepted.state);
  assert.equal(duplicate.accepted, false);
  assert.deepEqual(duplicate.state, accepted.state);

  const complete = settleSingleDownload(accepted.state, { state: 'complete' });
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.removeImageId, 'image-1');
  assert.equal(complete.error, null);
});

test('single start rejection and later interruption remain retryable with persistent error detail', async () => {
  const {
    createSingleDownloadState,
    acceptSingleDownload,
    settleSingleDownload
  } = await loadTsModule('src/content/single-download-state.ts');

  const firstPending = acceptSingleDownload(createSingleDownloadState('image-2')).state;
  const rejected = settleSingleDownload(firstPending, {
    state: 'rejected',
    error: 'browser rejected the request'
  });
  assert.equal(rejected.phase, 'retry');
  assert.equal(rejected.disabled, false);
  assert.equal(rejected.error, 'browser rejected the request');
  assert.equal(rejected.removeImageId, null);

  const retryPending = acceptSingleDownload(rejected);
  assert.equal(retryPending.accepted, true);
  assert.equal(retryPending.state.phase, 'pending');

  const interrupted = settleSingleDownload(retryPending.state, {
    state: 'interrupted',
    error: 'NETWORK_FAILED'
  });
  assert.equal(interrupted.phase, 'retry');
  assert.equal(interrupted.disabled, false);
  assert.equal(interrupted.error, 'NETWORK_FAILED');

  const completedRetry = settleSingleDownload(
    acceptSingleDownload(interrupted).state,
    { state: 'complete' }
  );
  assert.equal(completedRetry.phase, 'complete');
  assert.equal(completedRetry.removeImageId, 'image-2');
});

test('external submission is terminal for the button but never removes the page image', async () => {
  const {
    createSingleDownloadState,
    acceptSingleDownload,
    settleSingleDownload
  } = await loadTsModule('src/content/single-download-state.ts');

  const pending = acceptSingleDownload(createSingleDownloadState('image-external')).state;
  const submitted = settleSingleDownload(pending, { state: 'submitted' });

  assert.equal(submitted.phase, 'submitted');
  assert.equal(submitted.disabled, true);
  assert.equal(submitted.error, null);
  assert.equal(submitted.removeImageId, null);
  assert.equal(acceptSingleDownload(submitted).accepted, false);
});

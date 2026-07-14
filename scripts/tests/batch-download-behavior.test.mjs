import test from 'node:test';
import assert from 'node:assert/strict';

import JSZip from 'jszip';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function response(bytes, contentType = 'image/jpeg') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    }
  };
}

function createContext({ fetchImpl, fallbackImpl }) {
  const progress = [];
  return {
    maxConcurrentDownloads: 3,
    fetchImpl,
    requestFallbackDownload: fallbackImpl,
    throwIfBatchCancelled() {},
    isBatchCancellationError() { return false; },
    sendProgressUpdate(_job, percent, details) { progress.push({ percent, details }); },
    normalizeImageUrlForDeduplication(image) { return typeof image === 'string' ? image : image.url; },
    getDownloadCandidateUrls(rawUrl) {
      return rawUrl.includes('/236x/')
        ? [rawUrl.replace('/236x/', '/originals/'), rawUrl]
        : [rawUrl];
    },
    buildIndexedFilename(sequence, timestamp, url) {
      const extension = url.endsWith('.png') ? 'png' : 'jpg';
      return `${String(sequence).padStart(3, '0')}-${timestamp}.${extension}`;
    },
    extractFilenameFromUrl(url) { return url.split('/').pop(); },
    formatLocalTimestamp() { return '20260714_153045'; },
    progress
  };
}

function createJob(id) {
  return {
    id,
    cancelled: false,
    notified: false,
    activeDownloadIds: new Set(),
    controllers: new Set()
  };
}

test('batch download tries high quality once, falls back to the original once, and keeps source positions', async () => {
  const fetchCalls = [];
  const downloadCalls = [];
  globalThis.chrome = {
    downloads: {
      async download(options) {
        downloadCalls.push(options);
        return 91;
      }
    }
  };

  const context = createContext({
    async fetchImpl(url) {
      fetchCalls.push(url);
      if (url.includes('/originals/')) throw new Error('not found');
      return response([1, 2, 3]);
    },
    async fallbackImpl() {
      throw new Error('fallback should not run');
    }
  });
  const { runBatchDownload, IMAGE_FETCH_TIMEOUT_MS } = await loadTsModule('src/background/batch-download.ts');

  const result = await runBatchDownload(context, createJob('job-1'), [
    { id: 'a', url: 'https://i.pinimg.com/236x/a.jpg' },
    { id: 'b', url: 'https://example.com/b.png' }
  ], { highQuality: true });

  assert.equal(IMAGE_FETCH_TIMEOUT_MS, 8000);
  assert.deepEqual([...fetchCalls].sort(), [
    'https://example.com/b.png',
    'https://i.pinimg.com/236x/a.jpg',
    'https://i.pinimg.com/originals/a.jpg'
  ]);
  assert.ok(
    fetchCalls.indexOf('https://i.pinimg.com/originals/a.jpg')
      < fetchCalls.indexOf('https://i.pinimg.com/236x/a.jpg')
  );
  assert.equal(result.zippedCount, 2);
  assert.equal(result.fallbackRequestedCount, 0);
  assert.equal(result.unresolvedCount, 0);
  assert.equal(downloadCalls.length, 1);
  assert.deepEqual(downloadCalls[0], {
    url: downloadCalls[0].url,
    filename: 'PinPinto/PinPinto_20260714_153045.zip',
    conflictAction: 'uniquify',
    saveAs: false
  });

  const zipBase64 = downloadCalls[0].url.split(',')[1];
  const zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'));
  assert.deepEqual(Object.keys(zip.files).sort(), [
    '001-20260714_153045.jpg',
    '002-20260714_153045.png'
  ]);
});

test('failed fetches are handed to browser downloads and an all-fallback batch does not create an empty zip', async () => {
  const downloadCalls = [];
  const fallbackCalls = [];
  globalThis.chrome = {
    downloads: {
      async download(options) {
        downloadCalls.push(options);
        return 92;
      }
    }
  };
  const context = createContext({
    async fetchImpl() { throw new Error('blocked'); },
    async fallbackImpl(request) {
      fallbackCalls.push(request);
      return { accepted: true, downloadId: 501 };
    }
  });
  const { runBatchDownload } = await loadTsModule('src/background/batch-download.ts');

  const result = await runBatchDownload(context, createJob('job-2'), [
    { id: 'a', url: 'https://i.pinimg.com/236x/a.jpg' },
    { id: 'b', url: 'https://i.pinimg.com/236x/b.png' }
  ], { highQuality: true });

  assert.equal(result.zippedCount, 0);
  assert.equal(result.fallbackRequestedCount, 2);
  assert.equal(result.unresolvedCount, 0);
  assert.equal(downloadCalls.length, 0);
  assert.deepEqual(fallbackCalls.map((call) => call.filename), [
    '001-20260714_153045.jpg',
    '002-20260714_153045.png'
  ]);
  assert.match(context.progress.at(-1).details, /浏览器单独下载/);
});

test('fallback request rejection becomes an unresolved image without retrying', async () => {
  let fallbackAttempts = 0;
  globalThis.chrome = { downloads: { async download() { throw new Error('zip should not run'); } } };
  const context = createContext({
    async fetchImpl() { throw new Error('blocked'); },
    async fallbackImpl() {
      fallbackAttempts++;
      return { accepted: false, error: 'browser rejected' };
    }
  });
  const { runBatchDownload } = await loadTsModule('src/background/batch-download.ts');

  const result = await runBatchDownload(context, createJob('job-3'), [
    { id: 'a', url: 'https://example.com/a.jpg' }
  ], { highQuality: true });

  assert.equal(fallbackAttempts, 1);
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.results[0].status, 'unresolved');
});

test('batch sequence offset keeps automatic windows globally numbered', async () => {
  const downloadCalls = [];
  globalThis.chrome = {
    downloads: {
      async download(options) { downloadCalls.push(options); return 93; },
      async cancel() {}
    }
  };
  const context = createContext({
    async fetchImpl() { return response([1, 2, 3]); },
    async fallbackImpl() { throw new Error('fallback should not run'); }
  });
  const { runBatchDownload } = await loadTsModule('src/background/batch-download.ts');

  await runBatchDownload(context, createJob('job-4'), [
    { id: 'a', url: 'https://example.com/a.jpg' },
    { id: 'b', url: 'https://example.com/b.jpg' }
  ], { highQuality: true }, { sequenceOffset: 100 });

  const zip = await JSZip.loadAsync(Buffer.from(downloadCalls[0].url.split(',')[1], 'base64'));
  assert.deepEqual(Object.keys(zip.files).sort(), [
    '101-20260714_153045.jpg',
    '102-20260714_153045.jpg'
  ]);
});

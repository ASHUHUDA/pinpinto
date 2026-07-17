import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { loadTsModule } from './helpers/load-ts-module.mjs';

test('shared ZIP runner requests Blob output with streamFiles enabled', async () => {
  const calls = [];
  const files = [];
  const zip = {
    file(name, bytes) {
      files.push({ name, bytes: [...bytes] });
    },
    async generateAsync(options) {
      calls.push(options);
      return new Blob(['zip-bytes'], { type: 'application/zip' });
    }
  };
  const { buildZipBlob } = await loadTsModule('src/background/blob-runner.ts');

  const result = await buildZipBlob([
    { filename: '001.jpg', bytes: Uint8Array.from([1, 2, 3]) },
    { filename: '002.png', bytes: Uint8Array.from([4, 5]) }
  ], { createZip: () => zip });

  assert.ok(result instanceof Blob);
  assert.equal(result.type, 'application/zip');
  assert.deepEqual(files.map((entry) => entry.filename ?? entry.name), ['001.jpg', '002.png']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'blob');
  assert.equal(calls[0].streamFiles, true);
});

test('production batch code contains no ZIP Base64 or data URL fallback', async () => {
  const files = [
    'src/background/batch-download.ts',
    'src/background/blob-runner.ts'
  ];
  const source = (await Promise.all(files.map((file) => readFile(path.resolve(file), 'utf8')))).join('\n');

  assert.doesNotMatch(source, /generateAsync\s*\(\s*\{[^}]*type\s*:\s*['"]base64['"]/s);
  assert.doesNotMatch(source, /data:application\/zip[^'"`]*base64/i);
  assert.doesNotMatch(source, /zipBase64|base64Zip/i);
});

test('Blob job runner is idempotent and retains its object URL until release', async () => {
  const created = [];
  const revoked = [];
  let fetchCount = 0;
  const { BlobJobRunner } = await loadTsModule('src/background/blob-runner.ts');
  const runner = new BlobJobRunner({
    async fetchImpl() {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; }
      };
    },
    createObjectURL(blob) {
      created.push(blob);
      return 'blob:test/lease';
    },
    revokeObjectURL(url) { revoked.push(url); }
  });
  const request = {
    jobId: 'lease-job',
    maxConcurrency: 2,
    entries: [{
      imageId: 'a', sequence: 1, sourceUrl: 'https://example.com/a.jpg',
      candidateUrls: ['https://example.com/a.jpg'], filename: '001.jpg'
    }]
  };

  await Promise.all([runner.start(request), runner.start(request)]);
  const result = await runner.result('lease-job');
  assert.equal(fetchCount, 1);
  assert.equal(result.output, 'zip');
  assert.equal(result.contentType, 'application/zip');
  assert.equal(result.objectUrl, 'blob:test/lease');
  assert.ok(created[0] instanceof Blob);
  assert.deepEqual(await runner.listActiveJobs(), ['lease-job']);
  assert.equal(await runner.release('lease-job'), true);
  assert.deepEqual(revoked, ['blob:test/lease']);
  assert.deepEqual(await runner.listActiveJobs(), []);
  assert.equal(await runner.release('lease-job'), false);
});

test('file output preserves image MIME, falls back across candidates, and avoids JSZip', async () => {
  const fetchedUrls = [];
  const created = [];
  const revoked = [];
  let zipCreations = 0;
  const { BlobJobRunner } = await loadTsModule('src/background/blob-runner.ts');
  const runner = new BlobJobRunner({
    async fetchImpl(url) {
      fetchedUrls.push(url);
      if (url.endsWith('/high.jpg')) {
        return {
          ok: false,
          status: 503,
          headers: { get: () => 'text/plain' },
          async arrayBuffer() { return new ArrayBuffer(0); }
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png; charset=binary' },
        async arrayBuffer() { return Uint8Array.from([137, 80, 78, 71]).buffer; }
      };
    },
    createZip() {
      zipCreations++;
      throw new Error('file output must not create a ZIP');
    },
    createObjectURL(blob) {
      created.push(blob);
      return 'blob:test/file-lease';
    },
    revokeObjectURL(url) { revoked.push(url); }
  });

  await runner.start({
    jobId: 'file-job',
    output: 'file',
    maxConcurrency: 3,
    entries: [{
      imageId: 'a', sequence: 1, sourceUrl: 'https://example.com/source.jpg',
      candidateUrls: ['https://example.com/high.jpg', 'https://example.com/original.png'],
      filename: '001.png'
    }]
  });
  const result = await runner.result('file-job');

  assert.deepEqual(fetchedUrls, [
    'https://example.com/high.jpg',
    'https://example.com/original.png'
  ]);
  assert.equal(zipCreations, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'image/png');
  assert.deepEqual([...new Uint8Array(await created[0].arrayBuffer())], [137, 80, 78, 71]);
  assert.equal(result.output, 'file');
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.objectUrl, 'blob:test/file-lease');
  assert.deepEqual(result.zippedEntries, [{
    imageId: 'a', sequence: 1, sourceUrl: 'https://example.com/source.jpg',
    filename: '001.png', resolvedUrl: 'https://example.com/original.png'
  }]);
  assert.deepEqual(result.failedEntries, []);
  assert.deepEqual(await runner.listActiveJobs(), ['file-job']);
  assert.equal(await runner.release('file-job'), true);
  assert.deepEqual(revoked, ['blob:test/file-lease']);
  assert.equal(await runner.release('file-job'), false);
  assert.deepEqual(await runner.listActiveJobs(), []);
});

test('file output requires exactly one entry', async () => {
  const { BlobJobRunner } = await loadTsModule('src/background/blob-runner.ts');

  for (const [jobId, entries] of [
    ['empty-file-job', []],
    ['multi-file-job', [
      { imageId: 'a', sequence: 1, sourceUrl: 'a', candidateUrls: ['a'], filename: '001.jpg' },
      { imageId: 'b', sequence: 2, sourceUrl: 'b', candidateUrls: ['b'], filename: '002.jpg' }
    ]]
  ]) {
    const runner = new BlobJobRunner({
      fetchImpl: async () => { throw new Error('fetch must not run'); }
    });
    await runner.start({ jobId, output: 'file', maxConcurrency: 1, entries });
    await assert.rejects(runner.result(jobId), /exactly one entry/i);
    assert.equal((await runner.getStatus(jobId)).state, 'failed');
    assert.deepEqual(await runner.listActiveJobs(), []);
  }
});

test('Blob job runner binds the browser fetch receiver when no fetch dependency is injected', async () => {
  const originalFetch = globalThis.fetch;
  let receiver = null;
  globalThis.fetch = function () {
    receiver = this;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'image/svg+xml' },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
    });
  };

  try {
    const { BlobJobRunner } = await loadTsModule('src/background/blob-runner.ts');
    const runner = new BlobJobRunner({
      createObjectURL: () => 'blob:test/default-fetch',
      revokeObjectURL: () => {}
    });
    await runner.start({
      jobId: 'default-fetch-job',
      maxConcurrency: 1,
      entries: [{
        imageId: 'a', sequence: 1, sourceUrl: 'https://example.com/a.svg',
        candidateUrls: ['https://example.com/a.svg'], filename: '001.svg'
      }]
    });
    const result = await runner.result('default-fetch-job');
    assert.equal(receiver, globalThis);
    assert.equal(result.failedEntries.length, 0);
    assert.equal(result.zippedEntries.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cancelling a Blob job aborts fetch and excludes it from orphan enumeration', async () => {
  let aborted = false;
  const { BlobJobRunner } = await loadTsModule('src/background/blob-runner.ts');
  const runner = new BlobJobRunner({
    fetchImpl(_url, { signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
  });
  await runner.start({
    jobId: 'cancel-job', output: 'file', maxConcurrency: 1,
    entries: [{ imageId: 'a', sequence: 1, sourceUrl: 'a', candidateUrls: ['a'], filename: '001.jpg' }]
  });
  assert.equal(await runner.cancel('cancel-job'), true);
  assert.equal(await runner.cancel('cancel-job'), true);
  await assert.rejects(runner.result('cancel-job'), /cancelled/);
  assert.equal(aborted, true);
  assert.deepEqual(await runner.listActiveJobs(), []);
  assert.equal(await runner.release('cancel-job'), true);
  assert.equal(await runner.release('cancel-job'), false);
});

test('Chrome host selection uses offscreen when createDocument exists without hasDocument', async () => {
  globalThis.chrome = {
    offscreen: {
      Reason: { BLOBS: 'BLOBS' },
      async createDocument() {}
    },
    runtime: {
      sendMessage: async () => ({ ok: true, value: [] }),
      getURL: (path) => 'chrome-extension://test/' + path
    }
  };
  const { createBlobJobHost } = await loadTsModule('src/background/blob-host.ts');
  const host = createBlobJobHost();

  assert.equal(host.constructor.name, 'OffscreenBlobJobHost');
});

test('offscreen adapter creates one BLOBS document and forwards the full host contract', async () => {
  const createCalls = [];
  const messages = [];
  globalThis.chrome = {
    offscreen: { Reason: { BLOBS: 'BLOBS' } },
    runtime: { getURL: (path) => 'chrome-extension://test/' + path }
  };
  const { OffscreenBlobJobHost } = await loadTsModule('src/background/offscreen-blob-host.ts');
  const host = new OffscreenBlobJobHost({
    async hasDocument() { return false; },
    async createDocument(options) { createCalls.push(options); }
  }, async (message) => {
    messages.push(message);
    if (message.operation === 'getStatus') return { ok: true, value: null };
    if (message.operation === 'listActiveJobs') return { ok: true, value: ['orphan'] };
    if (message.operation === 'start') return {
      ok: true,
      value: { jobId: message.request.jobId, state: 'running', completedEntries: 0, totalEntries: 0, zipProgress: 0 }
    };
    return { ok: true, value: message.operation === 'result' ? { jobId: message.jobId, zippedEntries: [], failedEntries: [] } : true };
  });

  await host.start({ jobId: 'job', entries: [], maxConcurrency: 1 });
  await host.cancel('job');
  await host.release('job');
  await host.getStatus('job');
  await host.result('job');
  assert.deepEqual(await host.listActiveJobs(), ['orphan']);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].reasons, ['BLOBS']);
  assert.deepEqual(messages.map((message) => message.operation), [
    'start', 'cancel', 'release', 'getStatus', 'result', 'listActiveJobs'
  ]);
});

test('offscreen adapter reuses an existing document found through runtime.getContexts', async () => {
  const contextsCalls = [];
  const createCalls = [];
  const offscreenUrl = 'chrome-extension://test/offscreen.html';
  globalThis.chrome = {
    offscreen: { Reason: { BLOBS: 'BLOBS' } },
    runtime: { getURL: (path) => 'chrome-extension://test/' + path }
  };
  const { OffscreenBlobJobHost } = await loadTsModule('src/background/offscreen-blob-host.ts');
  const host = new OffscreenBlobJobHost({
    async createDocument(options) { createCalls.push(options); }
  }, async () => ({ ok: true, value: [] }), {
    getURL: (path) => 'chrome-extension://test/' + path,
    async getContexts(filter) {
      contextsCalls.push(filter);
      return [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl }];
    }
  }, {});

  assert.deepEqual(await host.listActiveJobs(), []);
  assert.equal(createCalls.length, 0);
  assert.deepEqual(contextsCalls, [{
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  }]);
});

test('offscreen adapter falls back to clients.matchAll before Chrome runtime.getContexts exists', async () => {
  const createCalls = [];
  const offscreenUrl = 'chrome-extension://test/offscreen.html';
  globalThis.chrome = {
    offscreen: { Reason: { BLOBS: 'BLOBS' } },
    runtime: { getURL: (path) => 'chrome-extension://test/' + path }
  };
  const { OffscreenBlobJobHost } = await loadTsModule('src/background/offscreen-blob-host.ts');
  const host = new OffscreenBlobJobHost({
    async createDocument(options) { createCalls.push(options); }
  }, async () => ({ ok: true, value: [] }), {
    getURL: (path) => 'chrome-extension://test/' + path
  }, {
    async matchAll() { return [{ url: offscreenUrl }]; }
  });

  assert.deepEqual(await host.listActiveJobs(), []);
  assert.equal(createCalls.length, 0);
});

test('shared Blob runner source is independent of the Chromium offscreen API', async () => {
  const source = await readFile(path.resolve('src/background/blob-runner.ts'), 'utf8');
  assert.doesNotMatch(source, /chrome\.offscreen|offscreen\.Reason/);
});

test('host selection fails explicitly when neither offscreen nor a DOM Blob host exists', async () => {
  globalThis.chrome = { offscreen: undefined };
  const { createBlobJobHost } = await loadTsModule('src/background/blob-host.ts');
  assert.throws(() => createBlobJobHost(), /No Blob ZIP host is available/);
});

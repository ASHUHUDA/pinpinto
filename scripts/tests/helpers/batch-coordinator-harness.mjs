import { createGlobalCleanup } from './global-cleanup.mjs';

export const restoreBatchCoordinatorGlobals = createGlobalCleanup(['chrome', 'fetch']);

export function createStorage(initialSnapshot = null) {
  let snapshot = initialSnapshot;
  return {
    async get() { return { pinpintoBatchTask: snapshot }; },
    async set(value) { snapshot = value.pinpintoBatchTask; },
    async remove() { snapshot = null; },
    current() { return snapshot; }
  };
}

export function imageResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'image/jpeg' },
    async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; }
  };
}

export function createHost(broadcasts, seedJobs = []) {
  const jobs = new Map();
  const releaseCalls = [];
  const cancelCalls = [];
  for (const seed of seedJobs) {
    jobs.set(seed.jobId, {
      status: seed.status,
      objectUrl: seed.result?.objectUrl ?? null,
      promise: Promise.resolve(seed.result)
    });
  }
  const blobHost = {
    async start(request) {
      if (jobs.has(request.jobId)) return jobs.get(request.jobId).status;
      const status = {
        jobId: request.jobId,
        state: 'running',
        completedEntries: 0,
        totalEntries: request.entries.length,
        zipProgress: 0
      };
      const record = { status, objectUrl: null, promise: null };
      record.promise = (async () => {
        const zippedEntries = [];
        const failedEntries = [];
        for (const entry of request.entries) {
          try {
            const response = await globalThis.fetch(entry.sourceUrl, { signal: new AbortController().signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await response.arrayBuffer();
            zippedEntries.push({ ...entry, resolvedUrl: entry.sourceUrl });
          } catch (error) {
            failedEntries.push({ ...entry, error: error instanceof Error ? error.message : String(error) });
          }
          status.completedEntries++;
        }
        const objectUrl = zippedEntries.length > 0 ? `blob:test/${request.jobId}` : undefined;
        record.objectUrl = objectUrl;
        status.state = 'completed';
        status.zipProgress = 100;
        return { jobId: request.jobId, objectUrl, zippedEntries, failedEntries };
      })();
      jobs.set(request.jobId, record);
      return status;
    },
    async getStatus(jobId) { return jobs.get(jobId)?.status ?? null; },
    async result(jobId) {
      const record = jobs.get(jobId);
      if (!record) throw new Error(`missing host job ${jobId}`);
      return record.promise;
    },
    async cancel(jobId) { cancelCalls.push(jobId); return jobs.has(jobId); },
    async release(jobId) { releaseCalls.push(jobId); return jobs.delete(jobId); },
    async listActiveJobs() { return [...jobs.keys()]; }
  };
  return {
    blobHost,
    activeDownloads: new Map(),
    maxConcurrentDownloads: 2,
    normalizeImageUrlForDeduplication(image) { return typeof image === 'string' ? image : image.url; },
    getDownloadCandidateUrls(url) { return [url]; },
    buildIndexedFilename(sequence, timestamp) { return `${String(sequence).padStart(3, '0')}-${timestamp}.jpg`; },
    extractFilenameFromUrl(url) { return url.split('/').pop(); },
    formatLocalTimestamp() { return '20260714_190000'; },
    broadcast(message) { broadcasts.push(message); },
    releaseCalls,
    cancelCalls
  };
}

export function installChrome(storage, options = {}) {
  const downloadCalls = [];
  const cancelCalls = [];
  const tabMessages = [];
  let nextDownloadId = options.firstDownloadId ?? 701;
  globalThis.chrome = {
    storage: { session: storage, local: storage },
    downloads: {
      async download(downloadOptions) {
        const downloadId = nextDownloadId++;
        downloadCalls.push({ downloadId, options: downloadOptions });
        await options.onDownload?.(downloadId, downloadOptions);
        return downloadId;
      },
      async cancel(downloadId) { cancelCalls.push(downloadId); },
      async search(query) { return options.search?.(query) ?? []; }
    },
    tabs: {
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
        if (options.sendMessage) return options.sendMessage(tabId, message);
        if (message.action === 'commitAutoBatchWindow') {
          return { success: true, baseOffset: message.endOffset, retainedCount: 0 };
        }
        return { success: true };
      }
    }
  };
  return { downloadCalls, cancelCalls, tabMessages };
}

export async function waitFor(check, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

export function completedBroadcast(broadcasts) {
  return broadcasts.findLast((message) => message.snapshot?.phase === 'completed');
}

export function activeWindow(overrides = {}) {
  return {
    windowId: 'restored-job:0:1',
    startOffset: 0,
    endOffset: 1,
    finalWindow: true,
    expectedDownloadIds: [44],
    downloadStates: {
      44: { downloadId: 44, kind: 'zip', state: 'pending', blobLeaseJobId: 'restored-job:zip:0:1' }
    },
    totalCount: 1,
    zippedCount: 1,
    fallbackCount: 0,
    unresolvedCount: 0,
    hostJobId: 'restored-job:zip:0:1',
    hostState: 'blob-ready',
    contentCommitState: {
      state: 'acknowledged', startOffset: 0, endOffset: 1, acknowledgedBaseOffset: 1, retainedCount: null
    },
    ...overrides
  };
}

export function persistedSnapshot(overrides = {}) {
  return {
    jobId: 'restored-job',
    mode: 'manual',
    targetTabId: 9,
    phase: 'downloading',
    batchCursor: 0,
    progress: 100,
    details: 'waiting',
    totalImages: 1,
    zippedCount: 0,
    fallbackCount: 0,
    unresolvedCount: 0,
    associatedDownloadIds: [44],
    pendingFallbackDownloadIds: [],
    activeWindow: activeWindow(),
    autoSessionFinished: true,
    autoBatchLimit: 100,
    settings: { highQuality: true },
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

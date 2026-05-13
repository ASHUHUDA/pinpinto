import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

test('background filename helpers preserve extension and indexed filename behavior', async () => {
  const {
    buildIndexedFilename,
    buildSingleFilename,
    ensureUniqueFilename,
    extractExtensionFromPath,
    resolveImageExtension
  } = await loadTsModule('src/background/filename.ts');

  assert.equal(extractExtensionFromPath('https://i.pinimg.com/img/photo.jpeg?x=1#hash'), 'jpg');
  assert.equal(extractExtensionFromPath('/path/file.jpe'), 'jpg');
  assert.equal(extractExtensionFromPath('/path/file.jfif'), 'jpg');
  assert.equal(extractExtensionFromPath('/path/file.tiff'), 'tif');
  assert.equal(extractExtensionFromPath('/path/file.'), '');
  assert.equal(extractExtensionFromPath('/path/file.invalid-extension'), '');

  assert.equal(resolveImageExtension('https://example.com/a.png', 'original.webp'), 'webp');
  assert.equal(resolveImageExtension('https://example.com/a.png', ''), 'png');
  assert.equal(resolveImageExtension('https://example.com/no-extension', ''), 'jpg');
  assert.equal(buildIndexedFilename(7, '20260505_101112', 'https://example.com/a.png'), '007-20260505_101112.png');
  assert.equal(buildIndexedFilename(1000, '20260505_101112', 'https://example.com/a.jpeg'), '1000-20260505_101112.jpg');
  assert.equal(buildSingleFilename('20260505_101112', 'https://example.com/a.tiff'), 'PinPinto-20260505_101112.tif');

  const usedFilenames = new Set(['001-test.jpg', '001-test_2.jpg']);
  assert.equal(ensureUniqueFilename('001-test.jpg', usedFilenames), '001-test_3.jpg');
  assert.equal(usedFilenames.has('001-test_3.jpg'), true);
});

test('background URL helpers preserve high-quality fallback and dedupe behavior', async () => {
  const {
    getDownloadCandidateUrls,
    getHighQualityUrl,
    normalizeImageUrlForDeduplication
  } = await loadTsModule('src/background/image-url.ts');

  const rawUrl = 'https://i.pinimg.com/236x/aa/bb/photo.jpg';
  const highQualityUrl = 'https://i.pinimg.com/originals/aa/bb/photo.jpg';

  assert.equal(getHighQualityUrl(rawUrl), highQualityUrl);
  assert.deepEqual(getDownloadCandidateUrls(rawUrl, true), [highQualityUrl, rawUrl]);
  assert.deepEqual(getDownloadCandidateUrls(rawUrl, false), [rawUrl]);
  assert.deepEqual(getDownloadCandidateUrls('', true), []);
  assert.equal(normalizeImageUrlForDeduplication({ url: rawUrl }, { highQuality: true }), highQualityUrl);
  assert.equal(normalizeImageUrlForDeduplication({ url: rawUrl }, { highQuality: false }), rawUrl);
  assert.equal(normalizeImageUrlForDeduplication('https://example.com/image.jpg', { highQuality: true }), 'https://example.com/image.jpg');
  assert.equal(normalizeImageUrlForDeduplication({ url: '' }, { highQuality: true }), '');
});

test('background folder helpers preserve organization branches without date flakiness', async () => {
  const { extractDomainFromUrl, generateFolderPath } = await loadTsModule('src/background/folder-path.ts');
  const date = new Date('2026-05-05T12:34:56.000Z');

  assert.equal(generateFolderPath({ folder: 'Manual Folder' }, { folderOrganization: 'date' }, date), 'PinPinto Downloads/Manual Folder');
  assert.equal(generateFolderPath({ board: 'My Board!' }, { folderOrganization: 'board' }, date), 'PinPinto Downloads/My_Board_');
  assert.equal(generateFolderPath({ board: 'My Board!' }, { folderOrganization: 'date' }, date), 'PinPinto Downloads/2026-05-05');
  assert.equal(generateFolderPath({ board: 'My Board!' }, { folderOrganization: 'month' }, date), 'PinPinto Downloads/2026-05');
  assert.equal(generateFolderPath({ board: 'My Board!' }, { folderOrganization: 'board_date' }, date), 'PinPinto Downloads/My_Board_/2026-05-05');
  assert.equal(generateFolderPath({ url: 'https://fi.pinterest.com/pin/123' }, { folderOrganization: 'domain' }, date), 'PinPinto Downloads/Pinterest_COM');
  assert.equal(generateFolderPath({}, { folderOrganization: 'custom', customFolder: 'Custom Folder!' }, date), 'PinPinto Downloads/Custom_Folder_');
  assert.equal(generateFolderPath({}, { folderOrganization: 'none' }, date), 'PinPinto Downloads');
  assert.equal(extractDomainFromUrl('not a url'), 'Unknown');
});

test('download path helpers keep single-image and zip downloads in the same root folder', async () => {
  const {
    PINPINTO_DOWNLOAD_ROOT,
    buildSingleDownloadPath,
    buildZipDownloadPath
  } = await loadTsModule('src/background/download-path.ts');

  assert.equal(PINPINTO_DOWNLOAD_ROOT, 'PinPinto');
  assert.equal(buildSingleDownloadPath('PinPinto-20260505_101112.jpg'), 'PinPinto/PinPinto-20260505_101112.jpg');
  assert.equal(buildZipDownloadPath('PinPinto_20260505_101112.zip'), 'PinPinto/PinPinto_20260505_101112.zip');
});

test('batch job helpers mark cancellation and suppress completion outcomes', async () => {
  const {
    PINPINTO_BATCH_CANCELLED,
    cancelBatchJobState,
    createBatchJobState,
    isBatchCancellationError,
    isBatchJobCancelled,
    markBatchJobNotified,
    shouldSkipBatchOutcome,
    throwIfBatchJobCancelled
  } = await loadTsModule('src/background/batch-job.ts');

  const batchJob = createBatchJobState(7);

  assert.equal(isBatchJobCancelled(batchJob), false);
  assert.equal(shouldSkipBatchOutcome(batchJob), false);
  assert.equal(batchJob.notified, false);

  cancelBatchJobState(batchJob);
  assert.equal(isBatchJobCancelled(batchJob), true);
  assert.equal(shouldSkipBatchOutcome(batchJob), true);

  assert.throws(() => throwIfBatchJobCancelled(batchJob), /PINPINTO_BATCH_CANCELLED/);
  assert.equal(isBatchCancellationError(new Error(PINPINTO_BATCH_CANCELLED)), true);

  markBatchJobNotified(batchJob);
  assert.equal(batchJob.notified, true);
});

test('single-image and batch download paths stay separated under the shared root', async () => {
  const { buildSingleFilename, buildIndexedFilename } = await loadTsModule('src/background/filename.ts');
  const { buildSingleDownloadPath, buildZipDownloadPath } = await loadTsModule('src/background/download-path.ts');

  const singlePath = buildSingleDownloadPath(buildSingleFilename('20260505_101112', 'https://example.com/a.png'));
  const zipPath = buildZipDownloadPath('PinPinto_20260505_101112.zip');
  const batchEntryName = buildIndexedFilename(1, '20260505_101112', 'https://example.com/a.png');

  assert.equal(singlePath, 'PinPinto/PinPinto-20260505_101112.png');
  assert.equal(zipPath, 'PinPinto/PinPinto_20260505_101112.zip');
  assert.equal(batchEntryName, '001-20260505_101112.png');
});

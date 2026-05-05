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

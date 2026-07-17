import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

test('shared download settings defaults include only common download settings', async () => {
  const { SHARED_DOWNLOAD_SETTINGS_DEFAULTS } = await loadTsModule('src/shared/download-settings.ts');

  assert.deepEqual(SHARED_DOWNLOAD_SETTINGS_DEFAULTS, {
    highQuality: true,
    autoScroll: false,
    autoBatchDownload: false,
    downloadAsZip: true,
    singleImageDownloadMethod: 'browser',
    autoBatchLimit: 100,
    autoBatchTotalBatches: 0,
    filenameFormat: 'title_date',
    folderOrganization: 'date',
    customFolder: ''
  });

  for (const popupOnlyKey of [
    'theme',
    'advancedFeaturesEnabled',
    'smartFeaturesEnabled',
    'autoDownloadScheduler',
    'batchProcessing',
    'imageSizeFilter',
    'duplicateDetection',
    'customWatermark'
  ]) {
    assert.equal(Object.hasOwn(SHARED_DOWNLOAD_SETTINGS_DEFAULTS, popupOnlyKey), false);
  }
});

test('shared download controls normalize storage values strictly', async () => {
  const {
    normalizeDownloadAsZip,
    normalizeSingleImageDownloadMethod
  } = await loadTsModule('src/shared/download-settings.ts');

  assert.equal(normalizeDownloadAsZip(true), true);
  assert.equal(normalizeDownloadAsZip(false), false);
  for (const unknownValue of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
    assert.equal(normalizeDownloadAsZip(unknownValue), true);
  }

  assert.equal(normalizeSingleImageDownloadMethod('browser'), 'browser');
  assert.equal(normalizeSingleImageDownloadMethod('external'), 'external');
  for (const unknownValue of [undefined, null, '', 'download-manager', true, 1, {}]) {
    assert.equal(normalizeSingleImageDownloadMethod(unknownValue), 'browser');
  }
});

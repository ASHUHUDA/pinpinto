import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

test('shared download settings defaults include only common download settings', async () => {
  const { SHARED_DOWNLOAD_SETTINGS_DEFAULTS } = await loadTsModule('src/shared/download-settings.ts');

  assert.deepEqual(SHARED_DOWNLOAD_SETTINGS_DEFAULTS, {
    highQuality: true,
    autoScroll: false,
    autoBatchDownload: false,
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

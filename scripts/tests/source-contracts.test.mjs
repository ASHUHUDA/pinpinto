import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

async function readWorkspaceFile(relativePath) {
  return readFile(path.resolve(relativePath), 'utf8');
}

test('popup side panel opener keeps direct window-level open path', async () => {
  const popupSource = await readWorkspaceFile('src/popup.ts');

  assert.match(
    popupSource,
    /await chrome\.sidePanel\.open\(\{ windowId: chrome\.windows\.WINDOW_ID_CURRENT \} as any\);/
  );
  assert.match(
    popupSource,
    /getActivePinterestTab\(\)\s*\n\s*\.then\(\(targetTab\) => this\.rememberSidebarTargetTab\(targetTab\?\.id \?\? null\)\)/
  );
  assert.match(
    popupSource,
    /else if \(this\.shouldOpenSidebarTabFallback\(\)\) \{[\s\S]*?this\.openSidebarFallbackTab\(\);[\s\S]*?\} else \{[\s\S]*?alert\(this\.getSidePanelUnavailableMessage\(\)\);/
  );
});

test('multi-browser build keeps dist reserved for Chrome while staging Firefox elsewhere', async () => {
  const buildBrowsersSource = await readWorkspaceFile('scripts/build-browsers.mjs');

  assert.match(buildBrowsersSource, /const CHROME_DIST_DIR = path\.join\(projectRoot, 'dist'\);/);
  assert.match(buildBrowsersSource, /const FIREFOX_STAGING_DIR = path\.join\(projectRoot, '\.build-firefox-dist'\);/);
  assert.match(buildBrowsersSource, /await buildTarget\('chrome', 'zip', CHROME_DIST_DIR\);/);
  assert.match(buildBrowsersSource, /await buildTarget\('firefox', 'xpi', FIREFOX_STAGING_DIR\);/);
  assert.match(buildBrowsersSource, /await fs\.rm\(FIREFOX_STAGING_DIR, \{ recursive: true, force: true \}\);/);
});

test('Firefox manifest uses a module background script and session-storage-compatible minimum version', async () => {
  const manifestSource = await readWorkspaceFile('manifest.config.ts');

  assert.match(manifestSource, /strict_min_version: '115\.0'/);
  assert.match(manifestSource, /background: isFirefoxTarget[\s\S]*?scripts: \['src\/background\.ts'\],[\s\S]*?type: 'module'/);
  assert.match(manifestSource, /service_worker: 'src\/background\.ts'/);
});

test('offscreen permission and Vite page entry are Chromium-only', async () => {
  const manifestSource = await readWorkspaceFile('manifest.config.ts');
  const viteSource = await readWorkspaceFile('vite.config.ts');

  assert.match(manifestSource, /isFirefoxTarget \? basePermissions : \[\.\.\.basePermissions, 'sidePanel', 'offscreen'\]/);
  assert.match(viteSource, /if \(!isFirefoxTarget\) pageInputs\.offscreen = 'offscreen\.html'/);
  assert.match(viteSource, /__PINPINTO_BROWSER_TARGET__/);
});

test('cancel flows target current batch instead of indiscriminately canceling all downloads', async () => {
  const clientSource = await readWorkspaceFile('src/shared/batch-task-client.ts');
  const backgroundSource = await readWorkspaceFile('src/background.ts');

  assert.match(clientSource, /action: 'cancelCurrentBatch',[\s\S]*?jobId: this\.currentJobId/);
  assert.match(
    backgroundSource,
    /case 'cancelDownload':[\s\S]*?if \(typeof request\.downloadId === 'number'\) \{[\s\S]*?await this\.cancelDownload\(request\.downloadId\);[\s\S]*?\} else \{[\s\S]*?await this\.batchCoordinator\.cancel\(request\.jobId\);/
  );
});

test('single-image downloads stay tagged outside batch cancellation flow', async () => {
  const backgroundSource = await readWorkspaceFile('src/background.ts');
  const serviceSource = await readWorkspaceFile('src/background/single-image-download.ts');

  assert.match(
    backgroundSource,
    /registerBrowserDownload:[\s\S]*?this\.activeDownloads\.set\(registration\.downloadId,[\s\S]*?isBatch: false,[\s\S]*?blobLeaseJobId: registration\.blobLeaseJobId/
  );
  assert.match(
    backgroundSource,
    /case 'downloadImage':[\s\S]*?await this\.downloadSingleImage\([\s\S]*?sender\.tab\?\.id,[\s\S]*?request\.imageData\?\.id/
  );
  assert.match(backgroundSource, /this\.singleDownloads\.register\(\{[\s\S]*?blobLeaseJobId: registration\.blobLeaseJobId/);
  assert.match(serviceSource, /const blobLeaseJobId = `single:\$\{requestId\}:file`;/);
  assert.match(serviceSource, /output: 'file'/);
  assert.match(serviceSource, /result\.failedEntries\[0\]\?\.error/);
  assert.doesNotMatch(serviceSource, /url: input\.sourceUrl/);
  assert.match(backgroundSource, /downloadAsZip: true,[\s\S]*?singleImageDownloadMethod: 'browser'/);
  assert.match(backgroundSource, /const batchHandled = this\.batchCoordinator\.handleDownloadChange\(downloadDelta, downloadInfo\);/);
  assert.match(backgroundSource, /if \(!batchHandled && !downloadInfo\?\.isBatch\) \{/);
  assert.doesNotMatch(backgroundSource, /setTimeout\([\s\S]*?activeDownloads\.delete\(downloadId\)[\s\S]*?30000/);
});

test('clear actions route through full page-session reset instead of deselect-only behavior', async () => {
  const popupSource = await readWorkspaceFile('src/popup/download-actions.ts');
  const sidebarSource = await readWorkspaceFile('src/sidebar/download-actions.ts');
  const contentSource = await readWorkspaceFile('src/content.ts');

  assert.match(popupSource, /await clearAllImagesOnPage\(controller, tab\.id\);/);
  assert.match(sidebarSource, /await clearAllImagesOnPage\(controller, tab\.id\);/);
  assert.match(contentSource, /this\.session\.clearAllImages\(\);/);
});

test('sidebar stats treats a missing content receiver as a fallback path', async () => {
  const sidebarSource = await readWorkspaceFile('src/sidebar.ts');

  assert.match(sidebarSource, /function isMissingTabReceiverError\(error: unknown\)/);
  assert.match(sidebarSource, /return message\.includes\('Receiving end does not exist'\);/);
  assert.match(sidebarSource, /const injected = await this\.ensureContentScriptInjected\(tab\.id\);\s*const response = injected \? await this\.requestImageCounts\(tab\.id\) : null;/);
  assert.match(sidebarSource, /if \(!isMissingTabReceiverError\(error\)\) \{\s*console\.error\('Error updating stats:', error\);\s*\}/);
  assert.match(sidebarSource, /async requestImageCounts\(tabId: number\): Promise<ImageCountsResponse \| null> \{[\s\S]*?if \(isMissingTabReceiverError\(error\)\) return null;[\s\S]*?throw error;[\s\S]*?\}/);
});

test('auto-batch limit stays in a separate manual-input area', async () => {
  const popupHtml = await readWorkspaceFile('popup.html');
  const sidebarHtml = await readWorkspaceFile('sidebar.html');

  for (const html of [popupHtml, sidebarHtml]) {
    assert.match(html, /data-i18n="panel\.autoBatchSettings"/);
    assert.match(html, /type="text" id="autoBatchLimit" inputmode="numeric"/);
    assert.match(html, /type="text" id="autoBatchTotalBatches" inputmode="numeric"/);
    assert.doesNotMatch(html, /type="number"[^>]*id="autoBatchLimit"|id="autoBatchLimit"[^>]*type="number"/);
    assert.doesNotMatch(html, /type="number"[^>]*id="autoBatchTotalBatches"|id="autoBatchTotalBatches"[^>]*type="number"/);
  }
});

test('popup and sidebar share persisted download controls, localized tooltip markup, and isolated styles', async () => {
  const [popupHtml, sidebarHtml, popupSource, sidebarSource, sharedCss, popupCss, translations] = await Promise.all([
    readWorkspaceFile('popup.html'),
    readWorkspaceFile('sidebar.html'),
    readWorkspaceFile('src/popup.ts'),
    readWorkspaceFile('src/sidebar.ts'),
    readWorkspaceFile('src/shared/download-settings-controls.css'),
    readWorkspaceFile('src/popup.css'),
    readWorkspaceFile('src/shared/ui-translations.ts')
  ]);

  for (const html of [popupHtml, sidebarHtml]) {
    assert.match(html, /href="\/src\/shared\/download-settings-controls\.css"/);
    assert.match(html, /type="checkbox" id="downloadAsZip"/);
    assert.match(html, /select[^>]+id="singleImageDownloadMethod"/);
    assert.match(html, /button[^>]+id="autoBatchInfoButton"[^>]+aria-describedby="autoBatchInfoTooltip"/);
    assert.match(html, /id="autoBatchInfoTooltip"[^>]+role="tooltip"/);
    assert.doesNotMatch(html, /Total batches \(0 = unlimited\)|总批下载数量（0为不限）|Cancel download/);
  }

  assert.match(popupHtml, /class="switch download-toggle"[\s\S]*?id="downloadAsZip"[\s\S]*?class="slider round"/);
  assert.match(sidebarHtml, /class="toggle-wrapper download-toggle"[\s\S]*?id="downloadAsZip"[^>]*class="toggle-input"[\s\S]*?class="toggle-track"/);

  for (const source of [popupSource, sidebarSource]) {
    assert.match(source, /normalizeDownloadAsZip\(settings\.downloadAsZip\)/);
    assert.match(source, /normalizeSingleImageDownloadMethod\(settings\.singleImageDownloadMethod\)/);
    assert.match(source, /getElementById\('downloadAsZip'\)[\s\S]*?saveSetting\('downloadAsZip'/);
    assert.match(source, /getElementById\('singleImageDownloadMethod'\)[\s\S]*?saveSetting\('singleImageDownloadMethod'/);
    assert.match(source, /stopBatchAfterCurrent\(continueAutoScroll: boolean\)/);
  }

  for (const selector of ['download-setting-row', 'download-toggle', 'download-method-select', 'settings-info-button', 'settings-tooltip']) {
    assert.match(sharedCss, new RegExp('\\.' + selector));
    assert.doesNotMatch(popupCss, new RegExp('\\.' + selector));
  }
  assert.match(sharedCss, /\.download-method-select[\s\S]*?background:\s*var\(--bg-base/);
  assert.match(sharedCss, /\.settings-tooltip[\s\S]*?background:\s*color-mix\([\s\S]*?var\(--bg-base/);
  assert.match(sharedCss, /\.batch-limit-panel\s*\{[\s\S]*?overflow:\s*visible/);
  assert.match(sharedCss, /\.batch-limit-panel \.settings-heading-with-info \.panel-title\s*\{[\s\S]*?margin:\s*0/);
  assert.doesNotMatch(sharedCss, /--background-color|--border-color|--primary-color/);
  assert.match(sharedCss, /:hover[\s\S]*?\.settings-tooltip/);
  assert.match(sharedCss, /:focus-within[\s\S]*?\.settings-tooltip/);
  assert.match(sharedCss, /position:\s*absolute/);
  for (const text of [
    'Download as ZIP',
    'Single-image download',
    'External downloader',
    'Total batches: leave blank or enter 0 for unlimited batches',
    'Cancel current task',
    '压缩包下载',
    '单图下载方式',
    '外部下载器',
    '总批下载数量：留空或输入 0 为不限批次',
    '取消当前任务'
  ]) {
    assert.ok(translations.includes(text), `missing translation: ${text}`);
  }
});

test('visible UI sources have current PinPinto branding and no stale batch copy', async () => {
  const [packageSource, popupHtml, sidebarHtml, popupCss, sidebarCss, translations] = await Promise.all([
    readWorkspaceFile('package.json'),
    readWorkspaceFile('popup.html'),
    readWorkspaceFile('sidebar.html'),
    readWorkspaceFile('src/popup.css'),
    readWorkspaceFile('src/sidebar.css'),
    readWorkspaceFile('src/shared/ui-translations.ts')
  ]);
  const packageJson = JSON.parse(packageSource);
  const visibleSources = [popupHtml, sidebarHtml, popupCss, sidebarCss, translations].join('\n');

  assert.ok(popupHtml.includes('<span class="badge-version">v' + packageJson.version + '</span>'));
  assert.ok(sidebarHtml.includes('<span class="badge-version">v' + packageJson.version + '</span>'));
  assert.doesNotMatch(visibleSources, /PinVault Pro/);
  assert.doesNotMatch(visibleSources, /v1\.5\.8/);
  assert.doesNotMatch(visibleSources, /3 rounds|3轮/);
});

test('root AGENTS.md captures project gates and automatic batch contract terms', async () => {
  const agents = await readWorkspaceFile('AGENTS.md');

  for (const expected of [
    'corepack.cmd pnpm run verify',
    'corepack.cmd pnpm run test:e2e',
    'git diff --check',
    'src/content/auto-batch-session.ts',
    'src/background/batch-coordinator.ts',
    'commitAutoBatchWindow',
    'resumeAutoBatchSession',
    '700 行'
  ]) {
    assert.ok(agents.includes(expected), 'AGENTS.md should include ' + expected);
  }
});
test('cancel helpers shut down and persist-disabled auto options in both popup and sidebar', async () => {
  const popupSource = await readWorkspaceFile('src/popup/download-actions.ts');
  const sidebarSource = await readWorkspaceFile('src/sidebar/download-actions.ts');

  for (const source of [popupSource, sidebarSource]) {
    assert.match(source, /clearInterval\(controller\.autoScrollStatsTimer\);[\s\S]*?controller\.autoScrollStatsTimer = null;/);
    assert.match(source, /controller\.saveSetting\('autoScroll', false\)/);
    assert.match(source, /controller\.saveSetting\('autoBatchDownload', false\)/);
    assert.match(source, /setAutoOptionsDisabled\(controller\);[\s\S]*?void saveAutoOptionsDisabled\(controller\);/);
  }
});

test('auto-batch startup anchors to the viewport before discarding historical images', async () => {
  const sessionSource = await readWorkspaceFile('src/content/auto-batch-session.ts');

  assert.match(
    sessionSource,
    /const anchorIndex = Math\.max\(0, this\.dependencies\.getViewportAnchorIndex\(\)\);[\s\S]*?this\.dependencies\.discardImagesBeforeIndex\(anchorIndex\);[\s\S]*?this\.dependencies\.startAutoScroll\(\);/
  );
});

test('content clear still emits a zero-count session update for UI refresh', async () => {
  const contentSource = await readWorkspaceFile('src/content.ts');

  assert.match(
    contentSource,
    /window\.dispatchEvent\(new CustomEvent\('pinvaultImagesUpdated', \{[\s\S]*?detail: \{ total: 0, new: 0 \}/
  );
});

test('content keeps the page image URL so background owns high-quality fallback selection', async () => {
  const contentSource = await readWorkspaceFile('src/content.ts');

  assert.match(contentSource, /url: this\.getOriginalImageUrl\(img\),/);
  assert.doesNotMatch(contentSource, /url: this\.getHighQualityUrl\(img\),/);
});

test('content entrypoint uses centralized discovery and exposes scoped settlement acknowledgements', async () => {
  const contentSource = await readWorkspaceFile('src/content.ts');

  assert.match(contentSource, /scanPinterestImages\(document,/);
  assert.match(contentSource, /classifyPinterestImage\(window\.location\.href, img\)/);
  assert.match(contentSource, /case 'commitAutoBatchWindow':[\s\S]*?this\.autoBatchSession\.commitWindow\(/);
  assert.match(contentSource, /case 'settleSingleDownload':[\s\S]*?this\.settleSingleDownload\(/);
  assert.match(contentSource, /settlement\.state === 'complete'[\s\S]*?this\.session\.removeDownloadedImage\(imageId\)/);
});

test('content auto-selection is scoped to future eligible records and survives only batch-internal pauses', async () => {
  const contentSource = await readWorkspaceFile('src/content.ts');

  assert.match(contentSource, /new AutoSelectionController\(\(imageId\) => this\.session\.selectImage\(imageId\)\)/);
  assert.match(contentSource, /const source = classifyPinterestImage\([\s\S]*?this\.session\.addImage\([\s\S]*?this\.autoSelection\.registerImage\(imageId, source !== 'recommendation'\);/);
  assert.match(contentSource, /startAutoScroll\(\) \{\s*this\.autoSelection\.enable\(\);/);
  assert.match(contentSource, /pauseAutoScroll: \(\) => this\.stopAutoScroll\('manual', true\)/);
  assert.match(contentSource, /if \(!preserveAutoSelection\) this\.autoSelection\.disable\(\);/);
  assert.match(contentSource, /this\.autoBatchSession\.finish\(request\.jobId, \{\s*continueAutoScroll: request\.continueAutoScroll === true/);
});

test('main code files remain below the 700-line AGENTS threshold', async () => {
  const lineBudgets = [
    ['src/background.ts', 700],
    ['src/background/batch-coordinator.ts', 700],
    ['src/content.ts', 700],
    ['src/popup.ts', 700],
    ['src/sidebar.ts', 700]
  ];

  for (const [relativePath, maxLines] of lineBudgets) {
    const source = await readWorkspaceFile(relativePath);
    const lineCount = source.split(/\r?\n/).length;
    assert.ok(
      lineCount <= maxLines,
      `${relativePath} expected <= ${maxLines} lines, received ${lineCount}`
    );
  }
});

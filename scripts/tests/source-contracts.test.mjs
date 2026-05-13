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
});

test('cancel flows target current batch instead of indiscriminately canceling all downloads', async () => {
  const popupSource = await readWorkspaceFile('src/popup/download-actions.ts');
  const sidebarSource = await readWorkspaceFile('src/sidebar/download-actions.ts');
  const backgroundSource = await readWorkspaceFile('src/background.ts');

  assert.match(popupSource, /chrome\.runtime\.sendMessage\(\{ action: 'cancelCurrentBatch' \}\);/);
  assert.match(sidebarSource, /chrome\.runtime\.sendMessage\(\{ action: 'cancelCurrentBatch' \}\);/);
  assert.match(
    backgroundSource,
    /case 'cancelDownload':[\s\S]*?if \(typeof request\.downloadId === 'number'\) \{[\s\S]*?await this\.cancelDownload\(request\.downloadId\);[\s\S]*?\} else \{[\s\S]*?await this\.cancelCurrentBatch\(\);/
  );
});

test('single-image downloads stay tagged outside batch cancellation flow', async () => {
  const backgroundSource = await readWorkspaceFile('src/background.ts');

  assert.match(
    backgroundSource,
    /this\.activeDownloads\.set\(downloadId,\s*\{[\s\S]*?isBatch: false,[\s\S]*?requestedFilename/
  );
  assert.match(
    backgroundSource,
    /case 'downloadImage':[\s\S]*?await this\.downloadSingleImage\(request\.imageData, request\.settings\);/
  );
});

test('clear actions route through full page-session reset instead of deselect-only behavior', async () => {
  const popupSource = await readWorkspaceFile('src/popup/download-actions.ts');
  const sidebarSource = await readWorkspaceFile('src/sidebar/download-actions.ts');
  const contentSource = await readWorkspaceFile('src/content.ts');

  assert.match(popupSource, /await clearAllImagesOnPage\(controller, tab\.id\);/);
  assert.match(sidebarSource, /await clearAllImagesOnPage\(controller, tab\.id\);/);
  assert.match(contentSource, /this\.session\.clearAllImages\(\);/);
});

test('cancel helpers shut down auto-scroll bookkeeping in both popup and sidebar', async () => {
  const popupSource = await readWorkspaceFile('src/popup/download-actions.ts');
  const sidebarSource = await readWorkspaceFile('src/sidebar/download-actions.ts');

  assert.match(
    popupSource,
    /if \(controller\.autoScrollStatsTimer\) \{[\s\S]*?clearInterval\(controller\.autoScrollStatsTimer\);[\s\S]*?controller\.autoScrollStatsTimer = null;[\s\S]*?\}[\s\S]*?void controller\.toggleAutoScroll\(false, \{ resetBatchState: false \}\);/
  );
  assert.match(
    sidebarSource,
    /if \(controller\.autoScrollStatsTimer\) \{[\s\S]*?clearInterval\(controller\.autoScrollStatsTimer\);[\s\S]*?controller\.autoScrollStatsTimer = null;[\s\S]*?\}[\s\S]*?void controller\.toggleAutoScroll\(false, \{ resetBatchState: false \}\);/
  );
});

test('auto-batch startup anchors to the viewport before discarding historical images', async () => {
  const popupSource = await readWorkspaceFile('src/popup/download-actions.ts');
  const sidebarSource = await readWorkspaceFile('src/sidebar/download-actions.ts');

  assert.match(
    popupSource,
    /if \(shouldResetBatchState && settings\.autoBatchDownload === true\) \{[\s\S]*?const viewportAnchorIndex = await getViewportAnchorIndex\(controller, tab\.id\);[\s\S]*?await discardImagesBeforeIndex\(controller, tab\.id, viewportAnchorIndex\);[\s\S]*?await controller\.updateImageCounts\(\);/
  );
  assert.match(
    sidebarSource,
    /if \(shouldResetBatchState && settings\.autoBatchDownload === true\) \{[\s\S]*?const viewportAnchorIndex = await getViewportAnchorIndex\(controller, tab\.id\);[\s\S]*?await discardImagesBeforeIndex\(controller, tab\.id, viewportAnchorIndex\);[\s\S]*?await controller\.updateStats\(\);/
  );
});

test('content clear still emits a zero-count session update for UI refresh', async () => {
  const contentSource = await readWorkspaceFile('src/content.ts');

  assert.match(
    contentSource,
    /window\.dispatchEvent\(new CustomEvent\('pinvaultImagesUpdated', \{[\s\S]*?detail: \{ total: 0, new: 0 \}/
  );
});

test('main code files remain below the 700-line AGENTS threshold', async () => {
  const lineBudgets = [
    ['src/background.ts', 700],
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

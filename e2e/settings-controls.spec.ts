import type { BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/extension';
import { createPinterestSearchFixture } from './fixtures/pinterest-search';

type BoundingBox = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;
type OpenExtensionPage = (pagePath: string) => Promise<Page>;

const surfaces = [
  { pagePath: 'popup.html', viewport: { width: 420, height: 760 } },
  { pagePath: 'sidebar.html', viewport: { width: 420, height: 900 } }
] as const;

test('download settings persist from popup to sidebar and back to popup', async ({
  context,
  openExtensionPage,
  assetServer
}) => {
  const pinterestPage = await openPinterestFixture(context, assetServer.baseUrl);
  const popup = await openConnectedExtensionPage(openExtensionPage, pinterestPage, 'popup.html');
  await seedSettings(popup, {
    language: 'en',
    downloadAsZip: true,
    singleImageDownloadMethod: 'browser'
  });
  await popup.reload({ waitUntil: 'domcontentloaded' });

  await expect(popup.locator('#downloadAsZip')).toBeVisible();
  await expect(popup.locator('#downloadAsZip')).toBeChecked();
  await expect(popup.locator('#singleImageDownloadMethod')).toHaveValue('browser');
  await popup.locator('#downloadAsZip').uncheck();
  await popup.locator('#singleImageDownloadMethod').selectOption('external');
  await expect.poll(() => readDownloadSettings(popup)).toEqual({
    downloadAsZip: false,
    singleImageDownloadMethod: 'external'
  });
  await popup.close();

  const sidebar = await openConnectedExtensionPage(openExtensionPage, pinterestPage, 'sidebar.html');
  await expect(sidebar.locator('#downloadAsZip')).not.toBeChecked();
  await expect(sidebar.locator('#singleImageDownloadMethod')).toHaveValue('external');
  await sidebar.locator('#downloadAsZip').check();
  await sidebar.locator('#singleImageDownloadMethod').selectOption('browser');
  await expect.poll(() => readDownloadSettings(sidebar)).toEqual({
    downloadAsZip: true,
    singleImageDownloadMethod: 'browser'
  });
  await sidebar.close();

  const reopenedPopup = await openConnectedExtensionPage(openExtensionPage, pinterestPage, 'popup.html');
  await expect(reopenedPopup.locator('#downloadAsZip')).toBeChecked();
  await expect(reopenedPopup.locator('#singleImageDownloadMethod')).toHaveValue('browser');
});

test('localized download controls render one language at a time', async ({ context, openExtensionPage, assetServer }) => {
  const pinterestPage = await openPinterestFixture(context, assetServer.baseUrl);
  for (const { pagePath } of surfaces) {
    const page = await openConnectedExtensionPage(openExtensionPage, pinterestPage, pagePath);
    await seedSettings(page, { language: 'en' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectLocalizedDownloadControls(page, 'en');

    await page.locator('#settingsBtn').click();
    await page.locator('#languageToggleBtn').click();
    await expectLocalizedDownloadControls(page, 'zh');
    await page.close();
  }
});

test('batch tooltip follows hover and focus without covering batch inputs', async ({
  context,
  openExtensionPage,
  assetServer
}) => {
  const pinterestPage = await openPinterestFixture(context, assetServer.baseUrl);
  for (const { pagePath, viewport } of surfaces) {
    const page = await openConnectedExtensionPage(openExtensionPage, pinterestPage, pagePath);
    await page.setViewportSize(viewport);
    const infoButton = page.locator('#autoBatchInfoButton');
    const tooltip = page.locator('#autoBatchInfoTooltip');
    const batchInputs = [page.locator('#autoBatchLimit'), page.locator('#autoBatchTotalBatches')];

    await expect(infoButton).toHaveAttribute('aria-describedby', 'autoBatchInfoTooltip');
    await expect(tooltip).toHaveAttribute('role', 'tooltip');
    await expect(tooltip).toBeHidden();
    await infoButton.hover();
    await expect(tooltip).toBeVisible();
    await expectNoOverlap(tooltip, batchInputs);

    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();

    await infoButton.focus();
    await expect(infoButton).toBeFocused();
    await expect(tooltip).toBeVisible();
    await expectNoOverlap(tooltip, batchInputs);

    await infoButton.evaluate((element) => element.blur());
    await expect(tooltip).toBeHidden();
    await page.close();
  }
});

test('aria2 help uses a localized icon tooltip without covering connection controls', async ({ context, openExtensionPage, assetServer }, testInfo) => {
  const pinterestPage = await openPinterestFixture(context, assetServer.baseUrl);
  for (const { pagePath } of surfaces) {
    const page = await openConnectedExtensionPage(openExtensionPage, pinterestPage, pagePath);
    for (const language of ['en', 'zh'] as const) {
      await seedSettings(page, { language });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.setViewportSize({ width: 360, height: 900 });
      await page.locator('.aria2-config summary').click();
      const info = page.getByRole('button', { name: language === 'en' ? 'aria2 information' : 'aria2 说明', exact: true });
      const tooltip = page.locator('#aria2Help');
      const controls = ['#aria2Endpoint', '#aria2Secret', '#aria2ClearSecret', '#aria2TestBtn'].map((selector) => page.locator(selector));
      await expect(info).toHaveAttribute('aria-describedby', 'aria2Help');
      await expect(tooltip).toHaveAttribute('role', 'tooltip');
      await expect(tooltip).toContainText(language === 'en' ? 'unencrypted and unsynced' : '不加密、不云同步');
      await expect(tooltip).toBeHidden();
      await info.hover();
      await expect(tooltip).toBeVisible();
      await expectNoOverlap(tooltip, controls);
      const box = await tooltip.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      await expectTooltipInView(tooltip);
      await page.mouse.move(1, 1);
      await expect(tooltip).toBeHidden();
      await info.focus();
      await expect(tooltip).toBeVisible();
      await expectNoOverlap(tooltip, controls);
      await expectTooltipInView(tooltip);
      await page.screenshot({ path: testInfo.outputPath(`aria2-help-${pagePath}-${language}.png`), fullPage: true });
      await info.evaluate((element) => element.blur());
      await expect(tooltip).toBeHidden();
    }
    await page.close();
  }
});

async function openPinterestFixture(context: BrowserContext, imageBaseUrl: string): Promise<Page> {
  await context.route('https://www.pinterest.com/search/pins/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: createPinterestSearchFixture(1, 0, imageBaseUrl)
  }));
  const page = await context.newPage();
  await page.goto('https://www.pinterest.com/search/pins/?q=settings-controls', {
    waitUntil: 'domcontentloaded'
  });
  return page;
}

async function openConnectedExtensionPage(
  openExtensionPage: OpenExtensionPage,
  pinterestPage: Page,
  pagePath: string
): Promise<Page> {
  const page = await openExtensionPage(pagePath);
  await pinterestPage.bringToFront();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#downloadAsZip')).toBeVisible();
  return page;
}

async function seedSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (values) => chrome.storage.sync.set(values), settings);
}

async function readDownloadSettings(page: Page) {
  return page.evaluate(async () => chrome.storage.sync.get([
    'downloadAsZip',
    'singleImageDownloadMethod'
  ]));
}

async function expectLocalizedDownloadControls(page: Page, language: 'en' | 'zh'): Promise<void> {
  const expected = language === 'en'
    ? {
        htmlLanguage: 'en',
        zip: 'Download as ZIP',
        method: 'Single-image download',
        tooltip: 'Images per batch: 1–500. Total batches: leave blank or enter 0 for unlimited batches',
        cancel: 'Cancel current task'
      }
    : {
        htmlLanguage: 'zh-CN',
        zip: '压缩包下载',
        method: '单图下载方式',
        tooltip: '每批下载数量：1–500。总批下载数量：留空或输入 0 为不限批次',
        cancel: '取消当前任务'
      };
  const otherZip = language === 'en' ? '压缩包下载' : 'Download as ZIP';
  const otherMethod = language === 'en' ? '单图下载方式' : 'Single-image download';
  const otherTooltip = language === 'en'
    ? '每批下载数量：1–500。总批下载数量：留空或输入 0 为不限批次'
    : 'Images per batch: 1–500. Total batches: leave blank or enter 0 for unlimited batches';
  const otherCancel = language === 'en' ? '取消当前任务' : 'Cancel current task';

  await expect(page.locator('html')).toHaveAttribute('lang', expected.htmlLanguage);
  await expect(page.locator('[data-i18n="setting.downloadAsZip"]')).toHaveText(expected.zip);
  await expect(page.locator('[data-i18n="setting.singleImageDownload"]')).toHaveText(expected.method);
  await expect(page.locator('#autoBatchInfoTooltip')).toHaveText(expected.tooltip);
  await expect(page.locator('[data-i18n="action.cancelDownload"]')).toHaveText(expected.cancel);
  await expect(page.getByText(otherZip, { exact: true })).toHaveCount(0);
  await expect(page.getByText(otherMethod, { exact: true })).toHaveCount(0);
  await expect(page.getByText(otherTooltip, { exact: true })).toHaveCount(0);
  await expect(page.getByText(otherCancel, { exact: true })).toHaveCount(0);
}

async function expectNoOverlap(tooltip: Locator, controls: Locator[]): Promise<void> {
  const tooltipBox = await tooltip.boundingBox();
  expect(tooltipBox).not.toBeNull();
  for (const control of controls) {
    const controlBox = await control.boundingBox();
    expect(controlBox).not.toBeNull();
    expect(rectanglesOverlap(tooltipBox!, controlBox!)).toBe(false);
  }
}

async function expectTooltipInView(tooltip: Locator): Promise<void> {
  await expect.poll(() => tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const clippedBy: string[] = [];
    if (rect.top < 0 || rect.bottom > window.innerHeight) clippedBy.push('viewport');
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)
        && (rect.top < box.top || rect.bottom > box.bottom)) clippedBy.push(parent.id || parent.className);
    }
    return clippedBy;
  })).toEqual([]);
}

function rectanglesOverlap(left: BoundingBox, right: BoundingBox): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fixtureImageSvg } from './pinterest-search';

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  downloadsDir: string;
  openExtensionPage: (pagePath: string) => Promise<Page>;
  assetServer: {
    baseUrl: string;
    rejectRequests: (reject: boolean) => void;
  };
};

export const test = base.extend<ExtensionFixtures>({
  downloadsDir: async ({}, use, testInfo) => {
    const runRoot = path.join(os.tmpdir(), `pinpinto-e2e-${testInfo.workerIndex}-${Date.now()}`);
    const downloadsDir = path.join(runRoot, 'downloads');
    await mkdir(downloadsDir, { recursive: true });
    await use(downloadsDir);
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
  },

  context: async ({ downloadsDir }, use) => {
    const extensionPath = path.resolve('.e2e-dist');
    const runRoot = path.dirname(downloadsDir);
    const userDataDir = path.join(runRoot, 'profile');

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      acceptDownloads: true,
      downloadsPath: downloadsDir,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    const serviceWorker = context.serviceWorkers()[0]
      ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(serviceWorker.url()).host;
    await use(extensionId);
  },

  openExtensionPage: async ({ context, extensionId }, use) => {
    await use(async (pagePath: string) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
      return page;
    });
  },

  assetServer: async ({}, use) => {
    let reject = false;
    const server = createServer((request, response) => {
      if (reject) {
        request.socket.destroy();
        return;
      }
      if (!request.url?.includes('/pinimg.com/')) {
        response.writeHead(404).end();
        return;
      }
      const body = fixtureImageSvg(`http://127.0.0.1${request.url}`);
      response.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unable to start the E2E asset server.');
    await use({
      baseUrl: `http://127.0.0.1:${address.port}`,
      rejectRequests: (value) => {
        reject = value;
      }
    });
    server.closeAllConnections();
    await new Promise<void>((resolve, rejectClose) => server.close((error) => {
      if (error) rejectClose(error);
      else resolve();
    }));
  }
});

export { expect } from '@playwright/test';

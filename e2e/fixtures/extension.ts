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
    rejectOriginals: (reject: boolean) => void;
    delayResponses: (milliseconds: number) => void;
    pauseResponses: () => void;
    waitForHeldRequests: (
      count: number,
      timeoutMs?: number,
      matches?: (url: string) => boolean
    ) => Promise<string[]>;
    resumeResponses: () => void;
  };
};

type ResponseGate = {
  promise: Promise<void>;
  resolve: () => void;
};

type RequestObserver = {
  count: number;
  matches: (url: string) => boolean;
  resolve: (urls: string[]) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export const test = base.extend<ExtensionFixtures>({
  downloadsDir: async ({}, use, testInfo) => {
    const runRoot = path.join(os.tmpdir(), `pinpinto-e2e-${testInfo.workerIndex}-${Date.now()}`);
    const downloadsDir = path.join(runRoot, 'downloads');
    await mkdir(downloadsDir, { recursive: true });
    await use(downloadsDir);
    await rm(runRoot, { recursive: true, force: true });
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

    const browser = context.browser();
    if (!browser) throw new Error('Persistent Chromium context did not expose its browser instance.');
    // Playwright otherwise stores accepted downloads under GUID filenames.
    const browserSession = await browser.newBrowserCDPSession();
    await browserSession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadsDir,
      eventsEnabled: true
    });
    await browserSession.detach();

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
    let rejectOriginals = false;
    let delayMs = 0;
    let responseGate: ResponseGate | null = null;
    let heldRequestUrls: string[] = [];
    const requestObservers = new Set<RequestObserver>();

    const notifyRequestObservers = () => {
      for (const observer of requestObservers) {
        const matchingUrls = heldRequestUrls.filter(observer.matches);
        if (matchingUrls.length < observer.count) continue;
        clearTimeout(observer.timeoutId);
        requestObservers.delete(observer);
        observer.resolve(matchingUrls.slice(0, observer.count));
      }
    };

    const resumeResponses = () => {
      const gate = responseGate;
      responseGate = null;
      gate?.resolve();
    };

    const server = createServer(async (request, response) => {
      const gate = responseGate;
      if (gate) {
        heldRequestUrls.push(request.url ?? '');
        notifyRequestObservers();
        await gate.promise;
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (reject) {
        request.socket.destroy();
        return;
      }
      if (!request.url?.includes('/pinimg.com/')) {
        response.writeHead(404).end();
        return;
      }
      if (rejectOriginals && request.url.includes('/originals/')) {
        response.writeHead(503, { 'Cache-Control': 'no-store' }).end('original candidate unavailable');
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
      },
      rejectOriginals: (value) => {
        rejectOriginals = value;
      },
      delayResponses: (milliseconds) => {
        delayMs = Math.max(0, milliseconds);
      },
      pauseResponses: () => {
        resumeResponses();
        heldRequestUrls = [];
        let resolveGate = () => {};
        const promise = new Promise<void>((resolve) => {
          resolveGate = resolve;
        });
        responseGate = { promise, resolve: resolveGate };
      },
      waitForHeldRequests: (count, timeoutMs = 10_000, matches = () => true) => {
        const matchingUrls = heldRequestUrls.filter(matches);
        if (matchingUrls.length >= count) {
          return Promise.resolve(matchingUrls.slice(0, count));
        }
        return new Promise<string[]>((resolve, rejectWait) => {
          let observer: RequestObserver;
          const timeoutId = setTimeout(() => {
            requestObservers.delete(observer);
            rejectWait(new Error(`Timed out waiting for ${count} held asset requests. Observed: ${JSON.stringify(heldRequestUrls)}`));
          }, timeoutMs);
          observer = {
            count,
            matches,
            resolve,
            reject: rejectWait,
            timeoutId
          };
          requestObservers.add(observer);
        });
      },
      resumeResponses
    });
    resumeResponses();
    for (const observer of requestObservers) {
      clearTimeout(observer.timeoutId);
      observer.reject(new Error('Asset server fixture closed before its request barrier completed.'));
    }
    requestObservers.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve, rejectClose) => server.close((error) => {
      if (error) rejectClose(error);
      else resolve();
    }));
  }
});

export { expect } from '@playwright/test';

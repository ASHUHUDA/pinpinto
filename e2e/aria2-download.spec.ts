import { createServer } from 'node:http';
import type { BrowserContext, Page } from '@playwright/test';
import { test as base, expect } from './fixtures/extension';
import { createPinterestSearchFixture, fixtureImageSvg } from './fixtures/pinterest-search';
import { captureDownloadCheckpoint, listDownloadsSince } from './fixtures/extension-downloads';

type RpcFixture = {
    endpoint: string;
    tasks: Array<{ id: string; url: string; options: Record<string, string> }>;
    rejectAt: number;
    dropAt: number;
    resetAt: number;
    accepted: Map<string, string>;
};
const test = base.extend<{ rpc: RpcFixture }>({
    rpc: async ({}, use) => {
        const rpc: RpcFixture = { endpoint: '', tasks: [], rejectAt: 0, dropAt: 0, resetAt: 0, accepted: new Map() };
        const server = createServer((request, response) => {
            let raw = '';
            request.on('data', (chunk) => { raw += chunk.toString(); });
            request.on('end', () => {
                const body = JSON.parse(raw);
                if (body.params[0] !== 'token:fixture-only-secret') {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 1, message: 'unauthorized fixture' } }));
                    return;
                }
                let result: unknown = { version: '1.37.0' };
                let error: unknown;
                if (body.method === 'aria2.addUri') {
                    rpc.tasks.push({ id: body.id, url: body.params[1][0], options: body.params[2] });
                    const gid = body.params[2].gid;
                    if (rpc.accepted.has(gid)) error = { code: 1, message: 'GID is not unique' };
                    else if (rpc.tasks.length === rpc.rejectAt) error = { code: 1, message: 'explicit fixture rejection' };
                    else rpc.accepted.set(gid, body.params[1][0]);
                    if (rpc.tasks.length === rpc.dropAt) {
                        response.writeHead(200, { 'Content-Type': 'application/json' });
                        response.write('{"jsonrpc":');
                        setImmediate(() => response.destroy());
                        return;
                    }
                    if (rpc.tasks.length === rpc.resetAt) { request.socket.destroy(); return; }
                    result = gid;
                } else if (body.method === 'aria2.tellStatus') {
                    const gid = body.params[1];
                    if (!rpc.accepted.has(gid)) error = { code: 1, message: 'GID not found' };
                    result = { gid, files: [{ uris: [{ uri: rpc.accepted.get(gid) }] }] };
                }
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(error ? { error } : { result }) }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing RPC fixture address');
        rpc.endpoint = `http://127.0.0.1:${address.port}/jsonrpc`;
        try { await use(rpc); }
        finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
});

async function openSearch(context: BrowserContext): Promise<Page> {
    await context.route('https://www.pinterest.com/search/pins/**', (route) => route.fulfill({
        status: 200, contentType: 'text/html', body: createPinterestSearchFixture(3, 0, 'https://i.pinimg.com')
    }));
    await context.route('https://i.pinimg.com/**', (route) => route.fulfill({
        status: 200, contentType: 'image/svg+xml', body: fixtureImageSvg(route.request().url())
    }));
    const page = await context.newPage();
    await page.goto('https://www.pinterest.com/search/pins/?q=aria2-fixture', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.pinvault-overlay-controls')).toHaveCount(3);
    return page;
}

async function configure(control: Page, rpc: RpcFixture) {
    await control.locator('.aria2-config summary').click();
    await control.locator('#aria2Endpoint').fill(rpc.endpoint);
    await control.locator('#aria2Secret').fill('fixture-only-secret');
    await control.locator('#aria2TestBtn').click();
    await expect(control.locator('#aria2Status')).toContainText('1.37.0');
    await expect(control.locator('#aria2Secret')).toHaveValue('');
    await control.locator('#batchDownloadMethod').selectOption('aria2');
    await expect(control.locator('#downloadAsZip')).toBeDisabled();
    await expect.poll(() => control.evaluate(async () => (await chrome.storage.sync.get('batchDownloadMethod')).batchDownloadMethod)).toBe('aria2');
}

test('aria2 settings, real card clicks and manual download button hand off without browser downloads', async ({ context, openExtensionPage, rpc }) => {
    const pinterest = await openSearch(context);
    const control = await openExtensionPage('popup.html');
    await pinterest.bringToFront();
    await control.reload({ waitUntil: 'domcontentloaded' });
    await expect(control.locator('#batchDownloadMethod')).toBeVisible();
    await configure(control, rpc);
    const checkpoint = await captureDownloadCheckpoint(control);
    await control.locator('#singleImageDownloadMethod').selectOption('aria2');
    await expect.poll(() => control.evaluate(async () => (await chrome.storage.sync.get('singleImageDownloadMethod')).singleImageDownloadMethod)).toBe('aria2');
    await pinterest.locator('.pinvault-single-download-btn').first().click();
    await expect(pinterest.locator('.pinvault-single-download-btn').first()).toHaveText('Sent to external downloader');
    await expect.poll(() => rpc.tasks.length).toBe(1);
    await expect(pinterest.locator('.pinvault-overlay-controls')).toHaveCount(3);

    await control.locator('#selectAllBtn').click();
    await expect(control.locator('#downloadBtn')).toBeEnabled();
    await control.locator('#downloadBtn').click();
    await expect.poll(() => rpc.tasks.length).toBe(4);
    await expect(control.locator('#progressDetails')).toContainText('并非下载完成');
    await expect(pinterest.locator('.pinvault-overlay-controls')).toHaveCount(3);
    expect(await listDownloadsSince(control, checkpoint)).toEqual([]);
    for (const task of rpc.tasks) {
        expect(task.url).toContain('/originals/');
        expect(task.options.dir).toBeUndefined();
        expect(task.options.out).not.toContain('/');
    }
    const config = await control.evaluate(async () => chrome.storage.sync.get(null));
    expect(JSON.stringify(config)).not.toContain('fixture-only-secret');
    const sidebar = await openExtensionPage('sidebar.html');
    await expect(sidebar.locator('#batchDownloadMethod')).toHaveValue('aria2');
    await expect(sidebar.locator('#singleImageDownloadMethod')).toHaveValue('aria2');
    await expect(sidebar.locator('#aria2Endpoint')).toHaveValue(rpc.endpoint);
});

test('lost background reply keeps an aria2 card uncertain and disables accidental resubmission', async ({ context, openExtensionPage, rpc }) => {
    const pinterest = await openSearch(context);
    const control = await openExtensionPage('popup.html');
    await control.evaluate(async () => {
        await chrome.storage.sync.set({ singleImageDownloadMethod: 'aria2' });
        const tabs = await chrome.tabs.query({ url: 'https://www.pinterest.com/*' });
        await chrome.scripting.executeScript({ target: { tabId: tabs[0].id! }, func: () => {
            const original = chrome.runtime.sendMessage;
            Object.defineProperty(chrome.runtime, 'sendMessage', { value: (message: { action?: string }, ...args: unknown[]) => {
                if (message?.action === 'downloadImage') return Promise.reject(new Error('fixture lost background reply'));
                return Reflect.apply(original, chrome.runtime, [message, ...args]);
            } });
        } });
    });
    const button = pinterest.locator('.pinvault-single-download-btn').first();
    await button.click();
    await expect(button).toHaveText('Submission uncertain — check downloader');
    await expect(button).toBeDisabled();
    await expect(pinterest.locator('.pinvault-overlay-controls')).toHaveCount(3);
    expect(rpc.tasks).toHaveLength(0);
});

test('aria2 automatic batches skip explicit rejection, compact acknowledged windows and respect the batch cap', async ({ context, openExtensionPage, rpc }) => {
    rpc.rejectAt = 1;
    const pinterest = await openSearch(context);
    const control = await openExtensionPage('popup.html');
    await pinterest.bringToFront();
    await control.reload({ waitUntil: 'domcontentloaded' });
    await configure(control, rpc);
    const checkpoint = await captureDownloadCheckpoint(control);
    await control.locator('#autoBatchLimit').fill('1');
    await control.locator('#autoBatchTotalBatches').fill('2');
    await control.locator('label.switch').filter({ has: control.locator('#autoBatchToggle') }).click();
    await expect.poll(() => rpc.tasks.length).toBe(2);
    await expect(control.locator('#progressDetails')).toContainText('拒绝并跳过 1');
    await expect(control.locator('#autoBatchToggle')).not.toBeChecked();
    await expect(pinterest.locator('.pinvault-overlay-controls')).toHaveCount(1);
    expect(await listDownloadsSince(control, checkpoint)).toEqual([]);
});

test('Chromium transport replay uses the same GID and reconciles acceptance without creating duplicate downloads', async ({ context, openExtensionPage, rpc }) => {
    rpc.resetAt = 2;
    const pinterest = await openSearch(context);
    const control = await openExtensionPage('popup.html');
    await pinterest.bringToFront();
    await control.reload({ waitUntil: 'domcontentloaded' });
    await configure(control, rpc);
    await control.locator('#selectAllBtn').click();
    await control.locator('#downloadBtn').click();
    await expect(control.locator('#progressDetails')).toContainText('已接收 3');
    expect(rpc.accepted.size).toBe(3);
    expect(rpc.tasks).toHaveLength(4);
    expect(rpc.tasks[1].id).toBe(rpc.tasks[2].id);
    expect(rpc.tasks[1].options.gid).toBe(rpc.tasks[2].options.gid);
});

test('aria2 automatic transport ambiguity stops with the page window retained and no later submissions', async ({ context, openExtensionPage, rpc }) => {
    rpc.dropAt = 2;
    const pinterest = await openSearch(context);
    const control = await openExtensionPage('popup.html');
    await pinterest.bringToFront();
    await control.reload({ waitUntil: 'domcontentloaded' });
    await configure(control, rpc);
    await control.locator('#autoBatchLimit').fill('3');
    await control.locator('label.switch').filter({ has: control.locator('#autoBatchToggle') }).click();
    await expect(control.locator('#progressDetails')).toContainText('状态不明 1');
    expect(rpc.tasks).toHaveLength(2);
    await expect(pinterest.locator('.pinvault-overlay-controls')).toHaveCount(3);
    const snapshot = await control.evaluate(async () => (await chrome.runtime.sendMessage({ action: 'getBatchTaskState' })).snapshot);
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.batchCursor).toBe(0);
    expect(snapshot.activeWindow.aria2Submission).toMatchObject({ submittedCount: 1, uncertainCount: 1, remainingCount: 1, done: false });
});

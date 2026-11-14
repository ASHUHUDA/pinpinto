import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/load-ts-module.mjs';
import { createGlobalCleanup } from './helpers/global-cleanup.mjs';

const cleanup = createGlobalCleanup(['chrome']);
afterEach(cleanup);

function installStorage(initial = {}) {
    const state = { ...initial };
    globalThis.chrome = {
        storage: {
            session: {
                async get(key) {
                    return { [key]: state[key] };
                },
                async set(value) {
                    Object.assign(state, value);
                }
            }
        }
    };
    return state;
}

test('background runtime metadata survives a service worker restart', async () => {
    const state = installStorage();
    const { BackgroundRuntimeState, BACKGROUND_RUNTIME_STATE_KEY } = await loadTsModule('src/background/runtime-state.ts');

    const firstWorker = new BackgroundRuntimeState();
    await firstWorker.waitUntilReady();
    await firstWorker.rememberExternalDownload(42);
    await firstWorker.rememberRequestedFilename('blob:zip', 'PinPinto/archive.zip');

    const secondWorker = new BackgroundRuntimeState();
    await secondWorker.waitUntilReady();
    assert.equal(await secondWorker.consumeExternalDownload(42), true);
    assert.equal(await secondWorker.takeRequestedFilename('blob:zip'), 'PinPinto/archive.zip');
    assert.deepEqual(state[BACKGROUND_RUNTIME_STATE_KEY], {
        externalDownloadIds: [],
        requestedFilenames: []
    });
});

test('runtime metadata keeps the newest bounded entries', async () => {
    const state = installStorage();
    const { BackgroundRuntimeState, BACKGROUND_RUNTIME_STATE_KEY } = await loadTsModule('src/background/runtime-state.ts');
    const runtimeState = new BackgroundRuntimeState();
    await runtimeState.waitUntilReady();

    for (let downloadId = 1; downloadId <= 130; downloadId++) {
        await runtimeState.rememberExternalDownload(downloadId);
    }
    for (let index = 1; index <= 130; index++) {
        await runtimeState.rememberRequestedFilename(`blob:${index}`, `file-${index}.zip`);
    }

    assert.equal(state[BACKGROUND_RUNTIME_STATE_KEY].externalDownloadIds.length, 128);
    assert.equal(state[BACKGROUND_RUNTIME_STATE_KEY].externalDownloadIds[0], 3);
    assert.equal(state[BACKGROUND_RUNTIME_STATE_KEY].requestedFilenames.length, 128);
    assert.deepEqual(state[BACKGROUND_RUNTIME_STATE_KEY].requestedFilenames[0], ['blob:3', 'file-3.zip']);
});

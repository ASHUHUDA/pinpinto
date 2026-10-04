import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/load-ts-module.mjs';
import { createGlobalCleanup } from './helpers/global-cleanup.mjs';
import { installIndexedDb } from './helpers/indexeddb.mjs';
const cleanup = createGlobalCleanup(['chrome', 'fetch', 'indexedDB']);
afterEach(cleanup);

function install() {
  const db = installIndexedDb();
  const local = {}, session = {}, requests = [];
  const area = (values) => ({ async get(key) { return { [key]: values[key] }; }, async set(update) { Object.assign(values, update); }, async remove(key) { delete values[key]; } });
  globalThis.chrome = {
    runtime: { id: 'test', getURL: (page) => `chrome-extension://test/${page}` },
    storage: { local: area(local), session: area(session) },
    permissions: { async contains() { return true; } }
  };
  globalThis.fetch = async (_, request) => {
    requests.push(JSON.parse(request.body));
    return { ok: true, async json() { return { jsonrpc: '2.0', id: JSON.parse(request.body).id, result: { version: '1.37.0' } }; } };
  };
  return { db, local, session, requests };
}
const trusted = { id: 'test', url: 'chrome-extension://test/popup.html', tab: { id: 1 } };

test('only trusted extension controls configure RPC; persistent secret is not returned or exposed in chrome.storage', async () => {
  const data = install();
  const { handleAria2SettingsMessage } = await loadTsModule('src/background/aria2-config.ts');
  const request = { action: 'saveAndTestAria2', endpoint: 'http://localhost:16800/jsonrpc', secret: 'fixture-only-secret' };
  assert.equal((await handleAria2SettingsMessage(request, { id: 'test', url: 'https://www.pinterest.com/' })).success, false);
  assert.equal(data.requests.length, 0);
  assert.deepEqual(await handleAria2SettingsMessage(request, trusted), { success: true, version: '1.37.0' });
  assert.deepEqual(data.local, { pinpintoAria2Endpoint: request.endpoint });
  assert.deepEqual(data.session, {});
  assert.equal(data.db.records.get('rpcSecret'), request.secret);
  const publicConfig = await handleAria2SettingsMessage({ action: 'getAria2Config' }, trusted);
  assert.deepEqual(publicConfig, { success: true, endpoint: request.endpoint, hasSecret: true });
  assert.equal(JSON.stringify(publicConfig).includes(request.secret), false);
  assert.equal(JSON.stringify(data.local).includes(request.secret), false);
});

test('blank secret preserves persistent value, explicit clear removes it, missing permission cannot save or fetch', async () => {
  const data = install();
  const { handleAria2SettingsMessage } = await loadTsModule('src/background/aria2-config.ts');
  const base = { action: 'saveAndTestAria2', endpoint: 'http://localhost:6800/jsonrpc' };
  await handleAria2SettingsMessage({ ...base, secret: 'fixture-only-secret' }, trusted);
  await handleAria2SettingsMessage({ ...base, secret: '' }, trusted);
  assert.deepEqual(data.requests.at(-1).params, ['token:fixture-only-secret']);
  await handleAria2SettingsMessage({ ...base, clearSecret: true }, trusted);
  assert.deepEqual(data.session, {});
  assert.equal(data.db.records.get('rpcSecret'), '');
  assert.deepEqual(data.requests.at(-1).params, []);
  globalThis.chrome.permissions.contains = async () => false;
  const count = data.requests.length;
  assert.equal((await handleAria2SettingsMessage({ ...base, secret: 'not-saved' }, trusted)).success, false);
  assert.deepEqual(data.session, {});
  assert.equal(data.requests.length, count);
  assert.equal(data.db.records.get('rpcSecret'), '');
});

test('changed endpoints reuse the saved secret and a failed connection still saves settings', async () => {
  const data = install();
  const { handleAria2SettingsMessage } = await loadTsModule('src/background/aria2-config.ts');
  await handleAria2SettingsMessage({ action: 'saveAndTestAria2', endpoint: 'http://localhost:6800/jsonrpc', secret: 'fixture-only-secret' }, trusted);
  globalThis.fetch = async (_, request) => {
    data.requests.push(JSON.parse(request.body));
    throw new Error('fixture offline');
  };
  const changed = 'http://127.0.0.1:16800/jsonrpc';
  const failed = await handleAria2SettingsMessage({ action: 'saveAndTestAria2', endpoint: changed, secret: '' }, trusted);
  assert.equal(failed.success, false);
  assert.equal(failed.configSaved, true);
  assert.equal(data.local.pinpintoAria2Endpoint, changed);
  assert.deepEqual(data.requests.at(-1).params, ['token:fixture-only-secret']);
  assert.equal(data.db.records.get('rpcSecret'), 'fixture-only-secret');
});

test('failed secret persistence reports unconfirmed save without making an RPC request or leaking input', async () => {
  const data = install();
  const { handleAria2SettingsMessage } = await loadTsModule('src/background/aria2-config.ts');
  data.db.failures.write = true;
  const failed = await handleAria2SettingsMessage({ action: 'saveAndTestAria2', endpoint: 'http://localhost:6800/jsonrpc', secret: 'fixture-only-secret' }, trusted);
  assert.equal(failed.success, false);
  assert.equal(failed.configSaved, false);
  assert.equal(data.requests.length, 0);
  assert.equal(JSON.stringify(failed).includes('fixture-only-secret'), false);
});

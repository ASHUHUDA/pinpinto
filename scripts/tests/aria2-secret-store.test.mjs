import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/load-ts-module.mjs';
import { createGlobalCleanup } from './helpers/global-cleanup.mjs';
import { installIndexedDb } from './helpers/indexeddb.mjs';

const cleanup = createGlobalCleanup(['chrome', 'indexedDB']);
afterEach(cleanup);
const legacyKey = 'pinpintoAria2SessionSecret';

function install(session = {}) {
  const db = installIndexedDb();
  globalThis.chrome = { storage: { session: {
    async get(key) { return { [key]: session[key] }; },
    async remove(key) { delete session[key]; }
  } } };
  return db;
}

test('secret survives a fresh module and empty browser session without chrome.storage persistence', async () => {
  const db = install();
  const store = await loadTsModule('src/background/aria2-secret-store.ts');
  await store.saveAria2Secret('fixture-only-secret');
  const restarted = await loadTsModule('src/background/aria2-secret-store.ts');
  assert.equal(await restarted.readAria2Secret(), 'fixture-only-secret');
  assert.equal(db.opens, db.closes);
});

test('legacy session secret migrates only after the persistent transaction commits', async () => {
  const session = { [legacyKey]: 'legacy-fixture' };
  const db = install(session);
  const store = await loadTsModule('src/background/aria2-secret-store.ts');
  db.failures.write = true;
  await assert.rejects(store.readAria2Secret());
  assert.deepEqual(session, { [legacyKey]: 'legacy-fixture' });
  assert.equal(db.records.size, 0);
  assert.equal(await store.readAria2Secret(), 'legacy-fixture');
  assert.deepEqual(session, {});
});

test('explicit clear takes precedence over a legacy secret even if session cleanup fails', async () => {
  const session = { [legacyKey]: 'legacy-fixture' };
  const db = install(session);
  const store = await loadTsModule('src/background/aria2-secret-store.ts');
  globalThis.chrome.storage.session.remove = async () => { throw new Error('fixture cleanup failure'); };
  await assert.rejects(store.saveAria2Secret(''));
  assert.equal(await store.readAria2Secret(), '');
  assert.equal(db.records.get('rpcSecret'), '');
  const restarted = await loadTsModule('src/background/aria2-secret-store.ts');
  assert.equal(await restarted.readAria2Secret(), '');
});

test('concurrent migration and clear serialize so an old secret cannot be resurrected', async () => {
  const session = { [legacyKey]: 'legacy-fixture' };
  install(session);
  const store = await loadTsModule('src/background/aria2-secret-store.ts');
  const migrated = store.readAria2Secret();
  const cleared = store.saveAria2Secret('');
  assert.equal(await migrated, 'legacy-fixture');
  await cleared;
  assert.equal(await store.readAria2Secret(), '');
  assert.deepEqual(session, {});
});

test('failed writes keep the previous secret and do not poison later operations', async () => {
  const db = install();
  const store = await loadTsModule('src/background/aria2-secret-store.ts');
  await store.saveAria2Secret('old-fixture');
  db.failures.write = true;
  await assert.rejects(store.saveAria2Secret('new-fixture'));
  assert.equal(await store.readAria2Secret(), 'old-fixture');
  await store.saveAria2Secret('new-fixture');
  assert.equal(await store.readAria2Secret(), 'new-fixture');
});

test('unavailable or invalid storage fails closed instead of silently dropping authentication', async () => {
  const db = install();
  const store = await loadTsModule('src/background/aria2-secret-store.ts');
  db.failures.open = true;
  await assert.rejects(store.readAria2Secret());
  db.records.set('rpcSecret', { invalid: true });
  await assert.rejects(store.readAria2Secret());
  await assert.rejects(store.saveAria2Secret('x'.repeat(4097)));
});

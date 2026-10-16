import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/load-ts-module.mjs';
import { createGlobalCleanup } from './helpers/global-cleanup.mjs';

afterEach(createGlobalCleanup(['chrome', 'document']));
const mask = '••••••••';

async function harness(options = {}) {
  const elements = new Map();
  const requests = [];
  let saved = options.saved ?? true;
  let response = options.response;
  for (const id of ['batchDownloadMethod', 'autoBatchLabel', 'downloadAsZip', 'aria2Endpoint', 'aria2Secret', 'aria2ClearSecret', 'aria2TestBtn', 'aria2Status', 'aria2MotrixBtn']) {
    const listeners = new Map();
    const element = {
      value: '', checked: false, disabled: false, textContent: '', selected: false,
      addEventListener(event, listener) { listeners.set(event, listener); },
      select() { this.selected = true; },
      async fire(event) { await listeners.get(event)?.(); },
      async fill(value) { this.value = value; await this.fire('input'); }
    };
    elements.set(id, element);
  }
  globalThis.document = { getElementById: (id) => elements.get(id) ?? null };
  globalThis.chrome = {
    storage: { sync: { async get(defaults) { return { ...defaults, batchDownloadMethod: 'aria2' }; }, async set() {} } },
    permissions: { async request() { return options.allowed !== false; } },
    runtime: { async sendMessage(request) {
      if (request.action === 'getAria2Config') return { success: true, endpoint: 'http://localhost:6800/jsonrpc', hasSecret: saved };
      requests.push(request);
      if (response) return response;
      if (request.clearSecret) saved = false;
      else if (request.secret) saved = true;
      return { success: true, version: '1.37.0', hasSecret: saved };
    } }
  };
  const { bindAria2Controls, updateAria2ModeLabels } = await loadTsModule('src/shared/aria2-controls.ts');
  await bindAria2Controls(() => 'en');
  return { elements, requests, updateAria2ModeLabels, setResponse(value) { response = value; } };
}

test('saved secret stays masked on open and repeated saves never submit the mask as a credential', async () => {
  const h = await harness();
  const secret = h.elements.get('aria2Secret');
  assert.equal(secret.value, mask);
  await secret.fire('focus');
  assert.equal(secret.selected, true, 'typing replaces the entire saved-secret mask');
  for (let attempt = 0; attempt < 2; attempt++) {
    await h.elements.get('aria2TestBtn').fire('click');
    assert.equal(secret.value, mask);
    assert.equal(Object.hasOwn(h.requests.at(-1), 'secret'), false);
  }
});

test('new secret is sent once, masked after saving, and only explicit clear removes the saved indicator', async () => {
  const h = await harness({ saved: false });
  const secret = h.elements.get('aria2Secret');
  assert.equal(secret.value, '');
  await secret.fill('fixture-new-secret');
  await h.elements.get('aria2TestBtn').fire('click');
  assert.equal(h.requests[0].secret, 'fixture-new-secret');
  assert.equal(secret.value, mask);
  await secret.fill('');
  await h.elements.get('aria2TestBtn').fire('click');
  assert.equal(secret.value, mask, 'blank preserves the saved secret');
  h.elements.get('aria2ClearSecret').checked = true;
  await h.elements.get('aria2TestBtn').fire('click');
  assert.equal(secret.value, '');
  assert.equal(h.elements.get('aria2ClearSecret').checked, false);
});

test('a saved configuration with failed connection remains masked, while failed persistence keeps the edited input', async () => {
  const h = await harness();
  const secret = h.elements.get('aria2Secret');
  await secret.fill('fixture-replacement');
  h.setResponse({ success: false, configSaved: false, error: 'storage failed' });
  await h.elements.get('aria2TestBtn').fire('click');
  assert.equal(secret.value, 'fixture-replacement');
  h.setResponse({ success: false, configSaved: true, hasSecret: true, error: 'offline' });
  await h.elements.get('aria2TestBtn').fire('click');
  assert.equal(secret.value, mask);
  assert.match(h.elements.get('aria2Status').textContent, /Settings saved\. Connection failed/);
});

test('saving does not overwrite a newer edit made while waiting for the RPC result', async () => {
  const h = await harness();
  const secret = h.elements.get('aria2Secret');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.setResponse(gate);
  await secret.fill('fixture-first-secret');
  const saving = h.elements.get('aria2TestBtn').fire('click');
  await Promise.resolve();
  await secret.fill('fixture-next-secret');
  release({ success: true, version: '1.37.0', hasSecret: true });
  await saving;
  assert.equal(secret.value, 'fixture-next-secret');
});

test('editing a saved mask replaces it instead of appending mask characters to the credential', async () => {
  const h = await harness();
  const secret = h.elements.get('aria2Secret');
  await secret.fire('beforeinput');
  assert.equal(secret.value, '');
  await secret.fill('fixture-replacement');
  await h.elements.get('aria2TestBtn').fire('click');
  assert.equal(h.requests[0].secret, 'fixture-replacement');
  assert.equal(secret.value, mask);
});

test('denied permission keeps the saved mask without sending a settings request', async () => {
  const h = await harness({ allowed: false });
  await h.elements.get('aria2TestBtn').fire('click');
  assert.equal(h.elements.get('aria2Secret').value, mask);
  assert.equal(h.requests.length, 0);
  assert.equal(h.elements.get('aria2TestBtn').disabled, false);
});

test('automatic label describes browser ZIP even when manual batch preference is aria2', async () => {
  const h = await harness();
  assert.equal(h.elements.get('autoBatchLabel').textContent, 'Auto download (ZIP)');
  h.updateAria2ModeLabels('zh');
  assert.equal(h.elements.get('autoBatchLabel').textContent, '自动下载（ZIP）');
});

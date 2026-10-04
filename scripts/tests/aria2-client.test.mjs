import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/load-ts-module.mjs';

const endpoint = 'http://127.0.0.1:6800/jsonrpc';
const imageUrl = 'https://i.pinimg.com/originals/a/b/c/image.jpg';
const reply = (request, result, extra = {}) => ({ ok: true, async json() {
  const body = JSON.parse(request.body);
  const value = typeof result === 'string' && /^[a-f0-9]{16}$/.test(result) ? body.params.at(-1)?.gid ?? result : result;
  return { jsonrpc: '2.0', id: body.id, result: value, ...extra };
} });

test('aria2 endpoints and image URLs enforce separate local/Pinterest allowlists', async () => {
  const { normalizeAria2Endpoint, aria2PermissionOrigin, isAria2ImageUrl } = await loadTsModule('src/shared/aria2-settings.ts');
  assert.equal(normalizeAria2Endpoint(' http://localhost:16800 '), 'http://localhost:16800/jsonrpc');
  assert.equal(aria2PermissionOrigin(endpoint), 'http://127.0.0.1/*');
  for (const value of ['http://192.168.1.2:6800/jsonrpc', 'https://example.com/jsonrpc', 'http://localhost.evil.test/jsonrpc', 'http://token:secret@localhost/jsonrpc', 'file:///tmp/x', 'ws://localhost/jsonrpc', 'http://localhost/jsonrpc?token=x', 'http://localhost/jsonrpc#x', null, 'http://localhost:99999']) assert.throws(() => normalizeAria2Endpoint(value));
  assert.equal(isAria2ImageUrl(imageUrl), true);
  for (const value of ['https://pinimg.com.evil.test/x', 'https://evilpinimg.com/x', 'http://localhost/x', 'blob:abc', 'https://secret@i.pinimg.com/x', 'ftp://i.pinimg.com/x', null]) assert.equal(isAria2ImageUrl(value), false);
});

test('addUri sends exactly one image, token authentication, safe filename and no directory or cookies', async () => {
  const { Aria2Client } = await loadTsModule('src/background/aria2-client.ts');
  const calls = [];
  const client = new Aria2Client({ endpoint, secret: 'fixture-only-secret', fetch: async (url, request) => {
    calls.push({ url, request }); return reply(request, '0123456789abcdef');
  } });
  assert.match(await client.addUri(imageUrl, '../name.jpg'), /^[a-f0-9]{16}$/);
  assert.equal(calls.length, 1);
  const { request } = calls[0];
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  const body = JSON.parse(request.body);
  assert.equal(body.method, 'aria2.addUri');
  assert.match(body.params[2].gid, /^[a-f0-9]{16}$/);
  assert.notEqual(body.params[2].gid, '0000000000000000');
  assert.deepEqual(body.params, ['token:fixture-only-secret', [imageUrl], { gid: body.params[2].gid, out: '.._name.jpg', 'auto-file-renaming': 'true', 'allow-overwrite': 'false' }]);
  assert.equal(Object.hasOwn(body.params[2], 'dir'), false);
});

test('connection test uses getVersion and no empty token parameter', async () => {
  const { Aria2Client } = await loadTsModule('src/background/aria2-client.ts');
  const client = new Aria2Client({ endpoint, fetch: async (_, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.method, 'aria2.getVersion');
    assert.deepEqual(body.params, []);
    return reply(request, { version: '1.37.0' });
  } });
  assert.equal(await client.getVersion(), '1.37.0');
});

test('valid explicit RPC errors are rejected without echoing server text or credentials', async () => {
  const { Aria2Client } = await loadTsModule('src/background/aria2-client.ts');
  const client = new Aria2Client({ endpoint, fetch: async (_, request) => ({ ok: true, async json() {
    return { jsonrpc: '2.0', id: JSON.parse(request.body).id, error: { code: 1, message: 'fixture-only-secret <script>' } };
  } }) });
  await assert.rejects(client.addUri(imageUrl, 'image.jpg'), (error) => error.kind === 'rejected' && !error.message.includes('secret') && !error.message.includes('<script>'));
});

test('malformed responses and network errors are uncertain, never automatically retried', async () => {
  const { Aria2Client } = await loadTsModule('src/background/aria2-client.ts');
  const cases = [
    async () => { throw new Error('network includes fixture-only-secret'); },
    async (_, request) => reply(request, 'not-a-gid'),
    async (_, request) => reply(request, '0123456789abcdef', { id: 'wrong-id' }),
    async () => ({ ok: false, async json() { throw new Error('invalid JSON'); } }),
    async (_, request) => reply(request, '0123456789abcdef', { error: { code: 1 } })
  ];
  for (const response of cases) {
    let calls = 0;
    const client = new Aria2Client({ endpoint, fetch: async (...args) => { calls++; return response(...args); } });
    await assert.rejects(client.addUri(imageUrl, 'image.jpg'), (error) => error.kind === 'uncertain' && !error.message.includes('fixture-only-secret'));
    assert.equal(calls, 1);
  }
});

test('duplicate-GID rejection reconciles a previously accepted task read-only without resubmitting', async () => {
  const { Aria2Client } = await loadTsModule('src/background/aria2-client.ts');
  const calls = [];
  let expectedGid;
  const client = new Aria2Client({ endpoint, fetch: async (_, request) => {
    const body = JSON.parse(request.body); calls.push(body);
    if (body.method === 'aria2.addUri') {
      expectedGid = body.params[1].gid;
      return { ok: true, async json() { return { jsonrpc: '2.0', id: body.id, error: { code: 1, message: 'GID is not unique' } }; } };
    }
    assert.equal(body.method, 'aria2.tellStatus');
    return reply(request, { gid: expectedGid, files: [{ uris: [{ uri: imageUrl }] }] });
  } });
  assert.equal(await client.addUri(imageUrl, 'image.jpg'), expectedGid);
  assert.deepEqual(calls.map((call) => call.method), ['aria2.addUri', 'aria2.tellStatus']);
});

test('timeout bounds RPC and aborts once; cancelled-before-send and invalid image never fetch', async () => {
  const { Aria2Client } = await loadTsModule('src/background/aria2-client.ts');
  let calls = 0;
  const client = new Aria2Client({ endpoint, timeoutMs: 5, fetch: async (_, { signal }) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await assert.rejects(client.addUri(imageUrl, 'image.jpg'), (error) => error.kind === 'uncertain');
  assert.equal(calls, 1);
  await assert.rejects(client.addUri('https://evil.test/x', 'image.jpg'), (error) => error.kind === 'rejected');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.addUri(imageUrl, 'image.jpg', abort.signal), (error) => error.kind === 'configuration');
  assert.equal(calls, 1);
});

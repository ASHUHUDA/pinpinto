import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, unlink } from 'node:fs/promises';

import ts from 'typescript';

async function loadPinterestModule() {
  const sourcePath = path.resolve('src/shared/pinterest.ts');
  const sourceCode = await readFile(sourcePath, 'utf8');

  const transpiled = ts.transpileModule(sourceCode, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  });

  const tempPath = path.join(
    os.tmpdir(),
    `pinpinto-pinterest-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  );

  await writeFile(tempPath, transpiled.outputText, 'utf8');

  try {
    return await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}`);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

test('isPinterestUrl only matches trusted Pinterest hostnames', async () => {
  const { isPinterestUrl } = await loadPinterestModule();

  assert.equal(isPinterestUrl('https://www.pinterest.com/pin/123'), true);
  assert.equal(isPinterestUrl('https://fi.pinterest.com/ideas'), true);
  assert.equal(isPinterestUrl('https://www.pinterest.com.mx/search/pins'), true);

  // Query-string mentions should not be treated as real Pinterest pages.
  assert.equal(isPinterestUrl('https://example.com/?next=https://pinterest.com/pin/1'), false);

  // Hostname suffix spoofing must be rejected.
  assert.equal(isPinterestUrl('https://pinterest.com.evil.example/path'), false);

  // Invalid URLs should fail closed.
  assert.equal(isPinterestUrl('not-a-valid-url'), false);
});


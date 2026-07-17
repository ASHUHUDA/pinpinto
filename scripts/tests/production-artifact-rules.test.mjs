import test from 'node:test';
import assert from 'node:assert/strict';

import { containsForbiddenBinaryDataUri } from '../production-artifact-rules.mjs';

for (const [mediaKind, source] of [
  ['image', 'const value = "data:image/png;base64,iVBORw0KGgo=";'],
  ['ZIP', 'data:application/zip;base64,UEsDBBQAAAAI'],
  ['octet-stream', 'data:application/octet-stream;charset=binary;base64,AAECAwQ=']
]) {
  test(`production data-URI matcher rejects embedded ${mediaKind} payloads`, () => {
    assert.equal(containsForbiddenBinaryDataUri(source), true);
  });
}

test('production data-URI matcher permits non-binary and non-Base64 data URIs', () => {
  assert.equal(containsForbiddenBinaryDataUri('data:text/plain;base64,SGVsbG8='), false);
  assert.equal(containsForbiddenBinaryDataUri('data:image/svg+xml,<svg></svg>'), false);
});

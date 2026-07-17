import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

import { containsForbiddenBinaryDataUri } from './production-artifact-rules.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const artifacts = [
  { browser: 'chrome', path: path.join(projectRoot, 'artifacts', `pinpinto-chrome-v${version}.zip`) },
  { browser: 'firefox', path: path.join(projectRoot, 'artifacts', `pinpinto-firefox-v${version}.xpi`) }
];
const forbiddenProductionPatterns = [
  /__PINPINTO_E2E__/i,
  /pinpintoTestProbe/i,
  /pinpintoE2EBlobProbe/i,
  /testOnlyProbe/i,
  /e2eOnly/i,
  /PINPINTO_E2E/i
];

for (const artifact of artifacts) {
  const archive = await JSZip.loadAsync(await readFile(artifact.path));
  const manifestEntry = archive.file('manifest.json');
  assert.ok(manifestEntry, `${artifact.browser} artifact must contain manifest.json`);
  const manifest = JSON.parse(await manifestEntry.async('string'));
  assert.equal(manifest.version, version, `${artifact.browser} version must match package.json`);
  assert.ok(!manifest.host_permissions.includes('http://127.0.0.1/*'), `${artifact.browser} must not contain E2E host access`);

  if (artifact.browser === 'chrome') {
    assert.ok(manifest.permissions.includes('offscreen'), 'Chrome must include offscreen permission');
  } else {
    assert.ok(!manifest.permissions.includes('offscreen'), 'Firefox must not include offscreen permission');
    assert.equal(manifest.background.type, 'module');
  }

  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !/\.(?:html|js|json|css)$/i.test(entry.name)) continue;
    const source = await entry.async('string');
    for (const pattern of forbiddenProductionPatterns) {
      assert.doesNotMatch(source, pattern, `${artifact.browser}:${entry.name} contains ${pattern}`);
    }
    assert.equal(
      containsForbiddenBinaryDataUri(source),
      false,
      `${artifact.browser}:${entry.name} contains an embedded binary data URI`
    );
    if (entry.name === 'welcome.html') {
      assert.doesNotMatch(source, /<script\b/i, `${artifact.browser} welcome page contains inline script`);
      assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `${artifact.browser} welcome page contains inline handler`);
    }
  }

  console.log(`[production-audit] ${artifact.browser} ${version}: ${Object.keys(archive.files).length} entries checked`);
}

console.log('[production-audit] passed');

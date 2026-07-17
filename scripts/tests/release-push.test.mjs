import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  classifyTagState,
  compareVersions,
  getReleaseCommands,
  nextPatchVersion,
  parseArgs,
  updateHtmlVersion,
  updateManifestVersion
} from '../release-push.mjs';

test('release push arguments and patch versions are strict', () => {
  assert.deepEqual(parseArgs(['--', '--version=1.5.12', '--skip-e2e']), { version: '1.5.12', skipE2E: true });
  assert.equal(nextPatchVersion('1.5.12'), '1.5.13');
  assert.equal(compareVersions('1.6.0', '1.5.99'), 1);
  assert.throws(() => parseArgs(['--force']), /Unsupported argument/);
  assert.throws(() => nextPatchVersion('2.0.0'), /Unsupported version format/);
});

test('version synchronization updates exactly one manifest and HTML badge', () => {
  assert.match(updateManifestVersion("  version: '1.5.11',", '1.5.12'), /version: '1\.5\.12'/);
  assert.match(updateHtmlVersion('<span class="badge-version">v1.5.11</span>', '1.5.12'), /v1\.5\.12/);
  assert.throws(() => updateHtmlVersion('<main></main>', '1.5.12'), /Expected one version badge/);
});

test('release gates include E2E by default and allow the explicit manual-test handoff', () => {
  assert.equal(getReleaseCommands(false).some((args) => args.includes('test:e2e')), true);
  assert.equal(getReleaseCommands(true).some((args) => args.includes('test:e2e')), false);
});

test('tag state distinguishes new, retryable, published, and conflicting releases', () => {
  assert.equal(classifyTagState({ headSha: 'a', localTagSha: '', remoteTagSha: '' }), 'new');
  assert.equal(classifyTagState({ headSha: 'a', localTagSha: 'a', remoteTagSha: '' }), 'retry');
  assert.equal(classifyTagState({ headSha: 'a', localTagSha: 'a', remoteTagSha: 'a' }), 'published');
  assert.equal(classifyTagState({ headSha: 'a', localTagSha: 'b', remoteTagSha: '' }), 'conflict');
});

test('package script and tag workflow keep release publication wired together', async () => {
  const [packageSource, workflow] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('.github/workflows/release.yml', 'utf8')
  ]);
  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.scripts['release:push'], 'node scripts/release-push.mjs');
  assert.match(workflow, /tags:\s*\['v\*\.\*\.\*'\]/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /run verify/);
  assert.match(workflow, /run test:e2e/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /pinpinto-chrome-v/);
  assert.match(workflow, /pinpinto-firefox-v/);
});

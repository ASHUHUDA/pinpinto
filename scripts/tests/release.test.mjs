import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  parseVersion,
  shouldCreateRelease,
  buildReleaseNotesContent,
  formatDateText
} from '../release.mjs';

test('parseVersion and parseArgs work for expected inputs', () => {
  assert.deepStrictEqual(parseArgs(['--force']), { force: true });
  assert.deepStrictEqual(parseArgs([]), { force: false });

  assert.deepStrictEqual(parseVersion('1.4.5'), {
    major: 1,
    minor: 4,
    patch: 5
  });

  assert.throws(() => parseVersion('2.0.0'), /Unsupported version format/);
});

test('shouldCreateRelease follows 1.(5n).0 rule unless forced', () => {
  assert.equal(shouldCreateRelease({ major: 1, minor: 5, patch: 0 }, false), true);
  assert.equal(shouldCreateRelease({ major: 1, minor: 4, patch: 9 }, false), false);
  assert.equal(shouldCreateRelease({ major: 1, minor: 10, patch: 1 }, false), false);
  assert.equal(shouldCreateRelease({ major: 1, minor: 3, patch: 7 }, true), true);
});

test('buildReleaseNotesContent keeps UTF-8 Chinese headings and artifact names', () => {
  const dateText = formatDateText(new Date('2026-03-05T00:00:00.000Z'));
  const markdown = buildReleaseNotesContent({
    versionText: '1.4.5',
    dateText,
    chromeArtifact: 'pinpinto-chrome-v1.4.5.zip',
    firefoxArtifact: 'pinpinto-firefox-v1.4.5.xpi'
  });

  assert.match(markdown, /## English/);
  assert.match(markdown, /## 中文/);
  assert.match(markdown, /### 新增/);
  assert.match(markdown, /### 修复/);
  assert.match(markdown, /pinpinto-chrome-v1.4.5\.zip/);
  assert.match(markdown, /pinpinto-firefox-v1.4.5\.xpi/);
});

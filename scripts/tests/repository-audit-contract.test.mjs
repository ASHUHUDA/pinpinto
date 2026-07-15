import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

async function readWorkspaceFile(relativePath) {
  return readFile(path.resolve(relativePath), 'utf8');
}

function tagWithId(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<[^>]+\\bid=["']${escapedId}["'][^>]*>`, 'i'));
  assert.ok(match, `expected an element with id=${id}`);
  return match[0];
}

test('package metadata, LICENSE, and both READMEs consistently expose standard MIT', async () => {
  const [packageSource, license, chineseReadme, englishReadme] = await Promise.all([
    readWorkspaceFile('package.json'),
    readWorkspaceFile('LICENSE'),
    readWorkspaceFile('README.md'),
    readWorkspaceFile('README_en.md')
  ]);
  const packageJson = JSON.parse(packageSource);
  const expectedLicense = `MIT License

Copyright (c) 2025 Yogeshwar Kumar - PinVault Pro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

  assert.equal(packageJson.license, 'MIT');
  assert.equal(license.replace(/\r\n/g, '\n').trim(), expectedLicense);
  assert.match(chineseReadme, /## 许可证[\s\S]*?MIT/);
  assert.match(englishReadme, /## License[\s\S]*?MIT/);
  assert.match(chineseReadme, /Pinterest[\s\S]*(不隶属|无关联|非关联)/i);
  assert.match(chineseReadme, /(合法|有权)[\s\S]*(知识产权|版权)/);
  assert.match(englishReadme, /not affiliated[\s\S]*Pinterest/i);
  assert.match(englishReadme, /(lawful|right to download)[\s\S]*(intellectual property|copyright)/i);
  assert.doesNotMatch(license, /ADDITIONAL TERMS|personal use only|Pinterest/i);
});

test('hidden no-effect settings and named dead background members are absent', async () => {
  const sources = await Promise.all([
    'popup.html',
    'sidebar.html',
    'src/popup.ts',
    'src/sidebar.ts',
    'src/background.ts',
    'src/shared/download-settings.ts'
  ].map(readWorkspaceFile));
  const source = sources.join('\n');
  const removedIdentifiers = [
    'advancedFeaturesEnabled',
    'smartFeaturesEnabled',
    'advancedFeaturesToggle',
    'smartFeaturesToggle',
    'autoDownloadScheduler',
    'batchProcessing',
    'imageSizeFilter',
    'duplicateDetection',
    'customWatermark',
    'downloadQueue',
    'cancelAllDownloads',
    'sendMessageToSidebar'
  ];

  for (const identifier of removedIdentifiers) {
    assert.doesNotMatch(source, new RegExp(`\\b${identifier}\\b`), `${identifier} must be deleted`);
  }
});

test('welcome page has real help links and no inline executable content or event handlers', async () => {
  const html = await readWorkspaceFile('welcome.html');
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);

  for (const label of ['Help', 'Feedback']) {
    const link = html.match(new RegExp(`<a\\b[^>]*href=["']([^"']+)["'][^>]*>\\s*${label}\\s*</a>`, 'i'));
    assert.ok(link, `expected a real ${label} link`);
    assert.notEqual(link[1], '#');
    assert.match(link[1], /^https:\/\//);
  }
});

test('popup and sidebar expose live status/progress semantics and synchronize aria-valuenow', async () => {
  for (const [htmlPath, sourcePath] of [
    ['popup.html', 'src/popup/download-actions.ts'],
    ['sidebar.html', 'src/sidebar/download-actions.ts']
  ]) {
    const [html, source] = await Promise.all([
      readWorkspaceFile(htmlPath),
      readWorkspaceFile(sourcePath)
    ]);
    for (const id of ['connectionStatus', 'progressDetails']) {
      const tag = tagWithId(html, id);
      assert.match(tag, /\brole=["']status["']/i, `${htmlPath}#${id} role`);
      assert.match(tag, /\baria-live=["']polite["']/i, `${htmlPath}#${id} aria-live`);
      assert.match(tag, /\baria-atomic=["']true["']/i, `${htmlPath}#${id} aria-atomic`);
    }

    const progressTag = tagWithId(html, 'progressFill');
    assert.match(progressTag, /\brole=["']progressbar["']/i);
    assert.match(progressTag, /\baria-valuemin=["']0["']/i);
    assert.match(progressTag, /\baria-valuemax=["']100["']/i);
    assert.match(progressTag, /\baria-valuenow=["']0["']/i);
    assert.match(
      source,
      /progressFill\.setAttribute\(['"]aria-valuenow['"],\s*String\(progress\)\)/,
      `${sourcePath} must synchronize aria-valuenow with visible progress`
    );
  }
});

async function productionTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await productionTypeScriptFiles(absolutePath));
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolutePath);
  }
  return files;
}

test('every production TypeScript file remains at or below the 700-line split threshold', async () => {
  const sourceRoot = path.resolve('src');
  const files = await productionTypeScriptFiles(sourceRoot);
  files.push(path.resolve('manifest.config.ts'));

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const relativePath = path.relative(process.cwd(), file);
    const lineCount = source.split(/\r?\n/).length;
    assert.ok(lineCount <= 700, `${relativePath} expected <= 700 lines, received ${lineCount}`);
  }
});

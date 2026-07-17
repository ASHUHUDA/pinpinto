import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(file, 'utf8');

test('Playwright extension suite, production audits, documentation, and Windows CI remain wired together', async () => {
  const [packageSource, config, fixture, spec, settingsSpec, productionAudit, productionRules, dependencyAudit, workflow, testingGuide] = await Promise.all([
    read('package.json'),
    read('playwright.config.ts'),
    read('e2e/fixtures/extension.ts'),
    read('e2e/download-correctness.spec.ts'),
    read('e2e/settings-controls.spec.ts'),
    read('scripts/production-audit.mjs'),
    read('scripts/production-artifact-rules.mjs'),
    read('scripts/dependency-audit.mjs'),
    read('.github/workflows/ci.yml'),
    read('docs/testing.md')
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts['test:e2e'], 'node scripts/build-e2e.mjs && playwright test');
  assert.equal(packageJson.scripts['audit:production'], 'node scripts/production-audit.mjs');
  assert.equal(packageJson.scripts['audit:dependencies'], 'node scripts/dependency-audit.mjs');
  assert.equal(packageJson.devDependencies['@playwright/test'], '1.61.1');
  assert.match(config, /workers:\s*1/);
  assert.match(config, /trace:\s*'retain-on-failure'/);
  assert.match(fixture, /launchPersistentContext/);
  assert.match(fixture, /--load-extension=/);
  assert.match(fixture, /newBrowserCDPSession/);
  assert.match(fixture, /Browser\.setDownloadBehavior[\s\S]*?behavior:\s*'allow'/);
  assert.match(fixture, /createServer/);
  assert.match(fixture, /rejectOriginals/);
  assert.match(fixture, /delayResponses/);
  assert.match(spec, /createPinterestSearchFixture\(80, 5, assetServer\.baseUrl\)/);
  assert.match(spec, /pinpintoE2EBlobProbe/);
  assert.match(spec, /manual ZIP and individual modes/);
  assert.match(spec, /automatic graceful stop/);
  assert.match(spec, /toHaveText\('Retry'/);
  assert.match(spec, /targetTabId:\s*tabId/);
  assert.match(spec, /\/zip\/i\.test\(download\.mime\)/);
  assert.match(spec, /pinpintoBatchTask/);
  assert.match(spec, /cspErrors/);
  assert.match(spec, /pinpintoProgressValues/);
  assert.match(settingsSpec, /createPinterestSearchFixture\(1, 0, imageBaseUrl\)/);
  assert.match(settingsSpec, /openConnectedExtensionPage/);
  assert.match(productionAudit, /pinpinto-firefox-v/);
  assert.match(productionAudit, /forbiddenProductionPatterns/);
  assert.match(productionAudit, /containsForbiddenBinaryDataUri/);
  assert.match(productionRules, /BINARY_DATA_URI_PATTERN/);
  assert.match(productionRules, /base64/);
  assert.match(dependencyAudit, /security\/advisories\/bulk/);
  assert.match(dependencyAudit, /api\.osv\.dev\/v1\/querybatch/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /node-version:\s*24/);
  for (const command of ['run verify', 'run audit:dependencies', 'run build:browsers', 'run audit:production', 'run test:e2e']) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(workflow, /playwright install chromium/);
  assert.match(workflow, /actions\/cache@v4/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(testingGuide, /PLAYWRIGHT_BROWSERS_PATH/);
  assert.match(testingGuide, /playwright-report/);
  assert.match(testingGuide, /test-results/);
  assert.match(testingGuide, /live Pinterest/i);
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build as viteBuild } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

function runPack(browser, format) {
  const packScript = path.join(projectRoot, 'scripts', 'package-artifact.mjs');
  const result = spawnSync(process.execPath, [packScript, `--browser=${browser}`, '--source=dist', `--format=${format}`], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.status !== 0) {
    throw new Error(`pack failed for ${browser}`);
  }
}

async function buildTarget(browser, format) {
  console.log(`[build:browsers] building ${browser} target...`);
  process.env.BROWSER_TARGET = browser;
  await viteBuild();
  runPack(browser, format);
}

async function main() {
  await buildTarget('chrome', 'zip');
  await buildTarget('firefox', 'xpi');
  delete process.env.BROWSER_TARGET;
  console.log('[build:browsers] done');
}

main().catch((error) => {
  console.error('[build:browsers] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});


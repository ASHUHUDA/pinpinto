import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build as viteBuild } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const CHROME_DIST_DIR = path.join(projectRoot, 'dist');
const FIREFOX_STAGING_DIR = path.join(projectRoot, '.build-firefox-dist');

function runPack(browser, format, sourceDir) {
  const packScript = path.join(projectRoot, 'scripts', 'package-artifact.mjs');
  const result = spawnSync(
    process.execPath,
    [packScript, `--browser=${browser}`, `--source=${sourceDir}`, `--format=${format}`],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env
    }
  );

  if (result.status !== 0) {
    throw new Error(`pack failed for ${browser}`);
  }
}

async function buildTarget(browser, format, outDir) {
  console.log(`[build:browsers] building ${browser} target...`);
  process.env.BROWSER_TARGET = browser;
  await viteBuild({
    build: {
      outDir,
      emptyOutDir: true
    }
  });
  runPack(browser, format, outDir);
}

async function cleanupFirefoxStaging() {
  await fs.rm(FIREFOX_STAGING_DIR, { recursive: true, force: true });
}

async function main() {
  try {
    await cleanupFirefoxStaging();
    await buildTarget('chrome', 'zip', CHROME_DIST_DIR);
    await buildTarget('firefox', 'xpi', FIREFOX_STAGING_DIR);
    console.log('[build:browsers] done');
  } finally {
    delete process.env.BROWSER_TARGET;
    await cleanupFirefoxStaging();
  }
}

main().catch((error) => {
  console.error('[build:browsers] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

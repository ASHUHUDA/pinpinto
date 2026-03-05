import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    force: args.has('--force')
  };
}

function parseVersion(version) {
  const match = /^1\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  return {
    major: 1,
    minor: Number(match[1]),
    patch: Number(match[2])
  };
}

function shouldCreateRelease(version, force) {
  if (force) return true;
  return version.minor > 0 && version.minor % 5 === 0 && version.patch === 0;
}

function runBuildBrowsers() {
  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'build-browsers.mjs')], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.status !== 0) {
    throw new Error('build:browsers failed');
  }
}

async function writeReleaseNotes(versionText) {
  const today = new Date();
  const dateText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const notesPath = path.resolve(projectRoot, 'artifacts', `release-notes-v${versionText}.md`);
  const chromeArtifact = `pinpinto-chrome-v${versionText}.zip`;
  const firefoxArtifact = `pinpinto-firefox-v${versionText}.xpi`;

  const content = `# PinPinto v${versionText} Release Notes

Date: ${dateText}

Artifacts:
- ${chromeArtifact}
- ${firefoxArtifact}

## English
### Added
- TODO: Fill in added features for this release.

### Fixed
- TODO: Fill in bug fixes for this release.

## 中文
### 新增
- TODO: 补充本版本新增功能。

### 修复
- TODO: 补充本版本修复内容。
`;

  await fs.mkdir(path.dirname(notesPath), { recursive: true });
  await fs.writeFile(notesPath, content, 'utf8');
  console.log(`[release] notes=${notesPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJsonPath = path.resolve(projectRoot, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const versionText = packageJson.version;
  const version = parseVersion(versionText);

  if (!shouldCreateRelease(version, args.force)) {
    console.log(
      `[release] skipped for v${versionText}. Rule: release at 1.(5n).0 or run with --force.`
    );
    return;
  }

  console.log(`[release] building release artifacts for v${versionText}...`);
  runBuildBrowsers();
  await writeReleaseNotes(versionText);
  console.log('[release] done');
}

main().catch((error) => {
  console.error('[release] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});


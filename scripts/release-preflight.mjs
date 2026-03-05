import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

function runGit(args) {
  return spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function readVersion() {
  const packageJsonPath = path.resolve(projectRoot, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  return packageJson.version;
}

function assertVersionFormat(version) {
  if (!/^1\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid version format in package.json: ${version}`);
  }
}

function expectedReleaseFiles(version) {
  const artifactsDir = path.resolve(projectRoot, 'artifacts');
  return {
    chromeZip: path.resolve(artifactsDir, `pinpinto-chrome-v${version}.zip`),
    firefoxXpi: path.resolve(artifactsDir, `pinpinto-firefox-v${version}.xpi`),
    releaseNotes: path.resolve(artifactsDir, `release-notes-v${version}.md`)
  };
}

async function checkFileExists(filePath, label, errors) {
  try {
    await fs.access(filePath);
    console.log(`[ok] ${label}: ${filePath}`);
  } catch {
    errors.push(`[missing] ${label}: ${filePath}`);
  }
}

function checkTag(version) {
  const tagName = `v${version}`;
  const local = runGit(['tag', '-l', tagName]);
  const remote = runGit(['ls-remote', '--tags', 'origin', `refs/tags/${tagName}`]);

  const localExists = local.status === 0 && local.stdout.trim() === tagName;
  const remoteExists = remote.status === 0 && remote.stdout.trim().length > 0;

  return { tagName, localExists, remoteExists, remoteStatus: remote.status };
}

async function checkReleaseNotes(releaseNotesPath, warnings, errors) {
  try {
    const content = await fs.readFile(releaseNotesPath, 'utf8');
    if (!content.includes('## English')) {
      errors.push('[invalid] release notes missing "## English" section');
    }
    if (!content.includes('## 中文')) {
      errors.push('[invalid] release notes missing "## 中文" section');
    }
    if (!content.includes('### 新增') || !content.includes('### 修复')) {
      errors.push('[invalid] release notes missing Chinese sub-sections');
    }

    if (content.includes('TODO:')) {
      warnings.push('[warn] release notes still contain TODO placeholders');
    }
  } catch {
    errors.push(`[invalid] failed to read release notes: ${releaseNotesPath}`);
  }
}

async function main() {
  const errors = [];
  const warnings = [];

  const version = await readVersion();
  assertVersionFormat(version);
  console.log(`[info] version=${version}`);

  const files = expectedReleaseFiles(version);
  await checkFileExists(files.chromeZip, 'chrome zip', errors);
  await checkFileExists(files.firefoxXpi, 'firefox xpi', errors);
  await checkFileExists(files.releaseNotes, 'release notes', errors);

  await checkReleaseNotes(files.releaseNotes, warnings, errors);

  const tag = checkTag(version);
  if (tag.localExists) {
    console.log(`[ok] local tag exists: ${tag.tagName}`);
  } else {
    warnings.push(`[warn] local tag not found: ${tag.tagName}`);
  }

  if (tag.remoteStatus === 0) {
    if (tag.remoteExists) {
      console.log(`[ok] remote tag exists: ${tag.tagName}`);
    } else {
      warnings.push(`[warn] remote tag not found: ${tag.tagName}`);
    }
  } else {
    warnings.push('[warn] unable to verify remote tag status (git ls-remote failed)');
  }

  for (const warning of warnings) {
    console.log(warning);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    throw new Error(`release preflight failed with ${errors.length} error(s)`);
  }

  console.log('[preflight] release checks passed');
}

main().catch((error) => {
  console.error('[preflight] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

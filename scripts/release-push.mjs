import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

export function parseArgs(argv) {
  const options = { version: null, skipE2E: false };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--skip-e2e') options.skipE2E = true;
    else if (argument.startsWith('--version=')) options.version = argument.slice('--version='.length);
    else throw new Error(`Unsupported argument: ${argument}`);
  }
  if (options.version) parseVersion(options.version);
  return options;
}

export function parseVersion(version) {
  const match = /^1\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported version format: ${version}`);
  return { major: 1, minor: Number(match[1]), patch: Number(match[2]) };
}

export function nextPatchVersion(version) {
  const parsed = parseVersion(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  return leftParts.minor - rightParts.minor || leftParts.patch - rightParts.patch;
}

function replaceOne(source, pattern, replacement, label) {
  const matches = source.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
  if (matches.length !== 1) throw new Error(`Expected one ${label}, found ${matches.length}`);
  return source.replace(pattern, replacement);
}

export function updateManifestVersion(source, version) {
  parseVersion(version);
  return replaceOne(source, /^  version: '1\.\d+\.\d+',$/m, `  version: '${version}',`, 'manifest version');
}

export function updateHtmlVersion(source, version) {
  parseVersion(version);
  return replaceOne(source, /class="badge-version">v1\.\d+\.\d+</, `class="badge-version">v${version}<`, 'version badge');
}

export function getReleaseCommands(skipE2E = false) {
  const commands = [
    ['pnpm', 'run', 'verify'],
    ['pnpm', 'run', 'audit:dependencies'],
    ['pnpm', 'run', 'build:browsers'],
    ['pnpm', 'run', 'audit:production']
  ];
  if (!skipE2E) commands.push(['pnpm', 'run', 'test:e2e']);
  return commands;
}

export function classifyTagState({ headSha, localTagSha, remoteTagSha }) {
  if (remoteTagSha) return remoteTagSha === headSha ? 'published' : 'conflict';
  if (!localTagSha) return 'new';
  return localTagSha === headSha ? 'retry' : 'conflict';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function git(args, options = {}) {
  return run('git', args, options);
}

function gitOutput(args, allowFailure = false) {
  const result = git(args, { capture: true, allowFailure });
  return { status: result.status, output: (result.stdout || '').trim() };
}

function corepackCommand() {
  return process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
}

async function readPackageJson() {
  const filePath = path.join(projectRoot, 'package.json');
  return { filePath, value: JSON.parse(await fs.readFile(filePath, 'utf8')) };
}

async function writeIfChanged(filePath, content) {
  const current = await fs.readFile(filePath, 'utf8');
  if (current === content) return false;
  await fs.writeFile(filePath, content, 'utf8');
  return true;
}

async function synchronizeVersion(version) {
  const packageJson = await readPackageJson();
  packageJson.value.version = version;
  await writeIfChanged(packageJson.filePath, `${JSON.stringify(packageJson.value, null, 2)}\n`);

  const manifestPath = path.join(projectRoot, 'manifest.config.ts');
  const popupPath = path.join(projectRoot, 'popup.html');
  const sidebarPath = path.join(projectRoot, 'sidebar.html');
  await writeIfChanged(manifestPath, updateManifestVersion(await fs.readFile(manifestPath, 'utf8'), version));
  await writeIfChanged(popupPath, updateHtmlVersion(await fs.readFile(popupPath, 'utf8'), version));
  await writeIfChanged(sidebarPath, updateHtmlVersion(await fs.readFile(sidebarPath, 'utf8'), version));
}

function localTagSha(tagName) {
  const result = gitOutput(['rev-list', '-n', '1', tagName], true);
  return result.status === 0 ? result.output : '';
}

function remoteTagSha(tagName) {
  const result = gitOutput(['ls-remote', '--tags', 'origin', `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]);
  const lines = result.output.split(/\r?\n/).filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tagName}^{}`));
  return (peeled ?? lines[0] ?? '').split(/\s+/)[0] || '';
}

function pushRelease(tagName) {
  git(['push', '--atomic', 'origin', 'main', tagName]);
}

async function runReleaseGates(skipE2E) {
  for (const args of getReleaseCommands(skipE2E)) run(corepackCommand(), args);
  git(['diff', '--check']);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (gitOutput(['branch', '--show-current']).output !== 'main') throw new Error('release:push must run on main');
  git(['remote', 'get-url', 'origin'], { capture: true });
  git(['fetch', 'origin', 'main', '--tags']);
  if (git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { allowFailure: true }).status !== 0) {
    throw new Error('Local main is behind or diverged from origin/main');
  }

  const headSha = gitOutput(['rev-parse', 'HEAD']).output;
  const currentVersion = (await readPackageJson()).value.version;
  parseVersion(currentVersion);
  const currentTag = `v${currentVersion}`;
  const currentTagState = classifyTagState({
    headSha,
    localTagSha: localTagSha(currentTag),
    remoteTagSha: remoteTagSha(currentTag)
  });
  if (currentTagState === 'retry') {
    console.log(`[release:push] retrying atomic push for ${currentTag}`);
    pushRelease(currentTag);
    return currentTag;
  }

  const version = options.version ?? nextPatchVersion(currentVersion);
  if (compareVersions(version, currentVersion) < 0) throw new Error(`Target version ${version} is older than ${currentVersion}`);
  const tagName = `v${version}`;
  const tagState = classifyTagState({ headSha, localTagSha: localTagSha(tagName), remoteTagSha: remoteTagSha(tagName) });
  if (tagState !== 'new') throw new Error(`Tag ${tagName} is already ${tagState}`);

  await synchronizeVersion(version);
  await runReleaseGates(options.skipE2E);
  git(['add', '-A']);
  const stagedDiff = git(['diff', '--cached', '--quiet'], { allowFailure: true });
  if (stagedDiff.status === 1) git(['commit', '-m', `chore(release): ${tagName}`]);
  else if (stagedDiff.status !== 0) throw new Error('Unable to inspect staged release changes');
  git(['tag', '-a', tagName, '-m', `PinPinto ${tagName}`]);
  pushRelease(tagName);
  console.log(`[release:push] pushed main and ${tagName}`);
  return tagName;
}

function isDirectExecution() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error('[release:push] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

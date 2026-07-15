import { execFileSync } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run dependency audit through pnpm so npm_execpath is available.');

const tree = JSON.parse(execFileSync(process.execPath, [
  pnpmCli,
  'list',
  '--prod',
  '--depth',
  'Infinity',
  '--json'
], { encoding: 'utf8' }))[0];
const packages = collectPackages(tree?.dependencies ?? {});
if (packages.length === 0) {
  console.log('[dependency-audit] no production dependencies');
  process.exit(0);
}

const [npmResult, osvResult] = await Promise.allSettled([
  queryNpm(packages),
  queryOsv(packages)
]);
if (npmResult.status === 'rejected') {
  console.warn(`[dependency-audit] npm bulk advisory unavailable: ${errorMessage(npmResult.reason)}`);
}
if (osvResult.status === 'rejected') {
  console.warn(`[dependency-audit] OSV unavailable: ${errorMessage(osvResult.reason)}`);
}
if (npmResult.status === 'rejected' && osvResult.status === 'rejected') {
  throw new Error('Both dependency advisory services were unavailable.');
}

const npmFindings = npmResult.status === 'fulfilled' ? npmResult.value : [];
const osvFindings = osvResult.status === 'fulfilled' ? osvResult.value : [];
const blockingNpm = npmFindings.filter((finding) => ['high', 'critical'].includes(finding.severity));
if (blockingNpm.length > 0 || osvFindings.length > 0) {
  const findings = [
    ...blockingNpm.map((finding) => `npm:${finding.name}:${finding.id}:${finding.severity}`),
    ...osvFindings.map((finding) => `osv:${finding.name}:${finding.id}`)
  ];
  throw new Error(`Production dependency advisories found: ${findings.join(', ')}`);
}

console.log(`[dependency-audit] checked ${packages.length} production package versions`);
console.log(`[dependency-audit] npm advisories=${npmFindings.length}, OSV advisories=${osvFindings.length}`);
console.log('[dependency-audit] passed');

function collectPackages(dependencies) {
  const found = new Map();
  const visit = (nodes) => {
    for (const [name, node] of Object.entries(nodes ?? {})) {
      if (!node?.version) continue;
      found.set(`${name}@${node.version}`, { name, version: node.version });
      visit(node.dependencies);
    }
  };
  visit(dependencies);
  return [...found.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ));
}

async function queryNpm(installed) {
  const versionsByName = {};
  for (const { name, version } of installed) {
    versionsByName[name] ??= [];
    if (!versionsByName[name].includes(version)) versionsByName[name].push(version);
  }
  const response = await postJson(
    'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    versionsByName
  );
  return Object.entries(response).flatMap(([name, advisories]) => (
    (Array.isArray(advisories) ? advisories : []).map((advisory) => ({
      name,
      id: advisory.id,
      severity: String(advisory.severity ?? 'unknown').toLowerCase()
    }))
  ));
}

async function queryOsv(installed) {
  const response = await postJson('https://api.osv.dev/v1/querybatch', {
    queries: installed.map(({ name, version }) => ({
      package: { ecosystem: 'npm', name },
      version
    }))
  });
  return installed.flatMap(({ name }, index) => (
    (response.results?.[index]?.vulns ?? []).map((vulnerability) => ({
      name,
      id: vulnerability.id
    }))
  ));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

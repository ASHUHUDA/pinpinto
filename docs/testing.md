# PinPinto Testing Guide

This guide is for a first local verification run on Windows. It separates deterministic release gates from the optional live Pinterest selector smoke.

## Prerequisites

- Node 24
- Corepack with the repository-pinned pnpm version
- Network access for the first Chromium install and dependency advisory queries

Install dependencies from the repository root:

```powershell
corepack.cmd pnpm install --frozen-lockfile
```

## First Playwright Setup

Use a shared browser directory if the default Playwright cache is not appropriate:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='D:\Apps\DevEnv\Browser_Data\agent-browser'
corepack.cmd pnpm exec playwright install chromium
```

Keep `PLAYWRIGHT_BROWSERS_PATH` set in the same PowerShell session when running E2E. Omitting it is also valid; Playwright then uses its default cache.

## Deterministic Gates

Run these commands in order:

```powershell
corepack.cmd pnpm run verify
corepack.cmd pnpm run audit:dependencies
corepack.cmd pnpm run build:browsers
corepack.cmd pnpm run audit:production
corepack.cmd pnpm run test:e2e
git diff --check
```

What each gate proves:

- `verify`: TypeScript, Node behavior/contracts, and the Chrome development build.
- `audit:dependencies`: installed production versions against npm bulk advisories and OSV.
- `build:browsers`: Chrome ZIP and Firefox XPI generation.
- `audit:production`: manifest/version/browser permissions and absence of E2E-only code in both production packages.
- `test:e2e`: deterministic search classification, 80-image ZIP contents, manual ZIP, manual individual-file output, automatic ZIP, graceful stop, immediate cancel, Blob-backed single-image bytes, browser-settled cleanup, retry, keyboard flow, CSP, and dynamic ARIA progress in Chromium.

## Release Publication

Use the repository release command from `main`:

```powershell
corepack.cmd pnpm run release:push
```

The command fetches `origin/main` and tags, refuses a behind or diverged branch, increments the patch version, synchronizes all version locations, runs the release gates, stages the complete non-ignored worktree, creates an annotated tag, and atomically pushes `main` with the tag.

To publish a version that has already been synchronized in the source files:

```powershell
corepack.cmd pnpm run release:push -- --version=1.5.12
```

`--skip-e2e` is reserved for an explicit manual-test handoff. It skips only the local Playwright run; the tag-triggered GitHub Release workflow still runs deterministic E2E and will not create the Release until that gate passes.

If an atomic push fails, rerun the same command. The script recognizes a local tag pointing at `HEAD` with no matching remote tag and retries the same version instead of incrementing again.

## Failure Evidence

Playwright keeps failure evidence in:

- `playwright-report/`: HTML report.
- `test-results/`: traces, screenshots, video, and attachments for failed tests.

Open the report with:

```powershell
corepack.cmd pnpm exec playwright show-report
```

Production packages are written to `artifacts/`. The E2E extension build is written to `.e2e-dist/`. These directories are generated and ignored by Git.

If `audit:dependencies` reports that both advisory services are unavailable, retry after network or registry access is restored. A single service failure is reported as a warning while the independent service remains authoritative for that run.

## Live Pinterest Smoke

The live smoke is supplementary selector-drift evidence, not a CI gate:

1. Open a real `https://www.pinterest.com/search/pins/` URL in an available browser session.
2. Inspect classification counts only: primary search results and recommendation containers.
3. Do not start downloads, click Pins, or mutate account data.
4. Record login, consent, network, or browser availability limitations separately.

Deterministic fixtures own correctness and CI. A blocked live Pinterest smoke never replaces or weakens the deterministic E2E suite.

## Optional External Downloader Smoke

External downloaders such as IDM are outside PinPinto's controlled task state and are not CI gates:

1. In Chrome with the downloader integration enabled, set **Single-image download** to **External downloader** and click one card-level download button.
2. Confirm the request is submitted to the browser/downloader integration; do not treat the external client's eventual completion or cancellation as a PinPinto success condition.
3. Disable or block the external integration and confirm PinPinto shows the immediate rejection guidance to switch back to Browser mode.
4. Re-test Browser mode for the same card and confirm it uses the controlled Blob-backed browser path.

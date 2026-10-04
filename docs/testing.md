# PinPinto Testing Guide

This guide covers local verification and release gates on Windows. Daily development uses the smallest effective checks; a version release requires full browser review.

## Browser Review Scope

Project policy confirmed on 2026-10-05:

| Situation | Required scope |
| --- | --- |
| Before a version release | Review all features and core interactions; run the complete release gates below. Reuse full deterministic E2E evidence, adding real-browser checks only for behavior the suite cannot prove. |
| A specific bug | If browser evidence is necessary, review only that feature: reproduction, the fix, and regression cases within the feature. Do not review unrelated features or run the full E2E suite. |
| Daily development | No browser review by default. Use type checks, Node behavior/contract tests, and builds where sufficient; run focused browser checks only when browser-specific evidence is necessary. |

Before starting a browser review, state the trigger, target feature, and case scope. Changes to selectors, overlays, downloads, or Pinterest classification do not automatically justify a full review. Optional live Pinterest, aria2, and external-downloader smokes below follow the same scope rules; they are not routine development gates.

## Focused Bug Verification

Start with the relevant Node behavior/contract tests. Use browser checks only when those checks cannot establish the required DOM, browser API, downloaded-byte, or visual-interaction evidence.

Select a specific spec and, if it includes other features, narrow it with `--grep`. For example, a batch-count tooltip bug should run only its tooltip case:

```powershell
# List matching cases without launching a browser; confirm the scope first.
corepack.cmd pnpm exec playwright test e2e/settings-controls.spec.ts --grep "batch tooltip" --list

# Build the test extension, then run only the selected case.
corepack.cmd pnpm exec node scripts/build-e2e.mjs
corepack.cmd pnpm exec playwright test e2e/settings-controls.spec.ts --grep "batch tooltip"
```

Replace the spec and title filter with the affected feature's cases. If no case matches, correct the filter or add a focused regression case; do not fall back to an unfiltered full-suite run. Follow the setup below only if dependencies or Chromium are missing. Record the selected cases and result; failures have evidence in the locations below.

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

## Complete Deterministic Release Gates

Before a version release, run these commands in order. This is not the default checklist for an individual bug fix:

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
- `test:e2e`: deterministic search classification, 80-image ZIP contents, manual ZIP, manual individual-file output, automatic ZIP, graceful stop, immediate cancel, Blob-backed single-image bytes, browser-settled cleanup, retry, keyboard flow, CSP, dynamic ARIA progress, and local aria2 RPC handoff (single/manual/auto, rejection, ambiguity, and transport replay), secret persistence across a real browser restart, content-script isolation, clear behavior, and localized icon tooltips in Chromium.

## Release Publication

Choose the version during functional delivery, before publishing from `main`:

Every functional change must update the version as part of its delivery: use a patch for small compatible adjustments/fixes, a minor for new capabilities, and a major for incompatible changes. Major upgrades also require updating the release scripts, which currently validate `1.x` only. Keep `package.json`, the manifest, and both HTML badges synchronized; the Node suite checks these source versions.

The command fetches `origin/main` and tags, refuses a behind or diverged branch, increments the patch version **when no explicit version is supplied**, synchronizes all version locations, runs the release gates, stages the complete non-ignored worktree, creates an annotated tag, and atomically pushes `main` with the tag. Pushing and publishing still require explicit authorization.

To publish the version already updated during feature delivery without incrementing it again:

```powershell
corepack.cmd pnpm run release:push -- --version=1.7.0
```

`--skip-e2e` is reserved for an explicit manual-test handoff. It skips only the local Playwright run, not the requirement for full browser review before release; the tag-triggered GitHub Release workflow still runs the complete deterministic E2E suite and will not create the Release until that gate passes. Do not use this release option as a shortcut for focused bug verification.

If an atomic push fails, rerun the same command. The script recognizes a local tag pointing at `HEAD` with no matching remote tag and retries the same version instead of incrementing again.

## Failure Evidence

Playwright keeps failure evidence in:

- `playwright-report/`: HTML report.
- `test-results/`: traces, screenshots, video, and attachments for failed tests.

Open the report with:

```powershell
corepack.cmd pnpm exec playwright show-report
```

Production packages are written to `artifacts/`. The E2E extension build is written to `.e2e-dist/`. These directories are generated and ignored by Git. `.agents/` contains local collaboration memory and must remain untracked; removing it from Git does not delete local files or erase earlier commits.

If `audit:dependencies` reports that both advisory services are unavailable, retry after network or registry access is restored. A single service failure is reported as a warning while the independent service remains authoritative for that run.

## Live Pinterest Smoke

The live smoke is supplementary selector-drift evidence, not a CI gate:

1. Open a real `https://www.pinterest.com/search/pins/` URL in an available browser session.
2. Inspect classification counts only: primary search results and recommendation containers.
3. Do not start downloads, click Pins, or mutate account data.
4. Record login, consent, network, or browser availability limitations separately.

Deterministic fixtures own correctness and CI. A blocked live Pinterest smoke never replaces or weakens the deterministic E2E suite.

## Optional aria2 Downloader Smoke

Follow the [aria2 setup guide](aria2.md) with an already running local Motrix or aria2c instance. Verify connection testing, card and context-menu submission, manual batches, and automatic handoff in your target browser. Check actual task creation and the downloader's default directory there. A successful RPC response does not prove image bytes reached disk. Mock RPC E2E and Firefox package builds do not replace this runtime smoke.

## Optional External Downloader Smoke

External downloaders such as IDM are outside PinPinto's controlled task state and are not CI gates:

1. In Chrome with the downloader integration enabled, set **Single-image download** to **External downloader** and click one card-level download button.
2. Confirm the request is submitted to the browser/downloader integration; do not treat the external client's eventual completion or cancellation as a PinPinto success condition.
3. Disable or block the external integration and confirm PinPinto shows the immediate rejection guidance to switch back to Browser mode.
4. Re-test Browser mode for the same card and confirm it uses the controlled Blob-backed browser path.

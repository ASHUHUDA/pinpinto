# PinPinto Release Push Workflow Design

Date: 2026-07-16
Audience: PinPinto maintainers
Status: Implemented

## Goal

Provide one local command that turns the current `main` worktree into the next patch release, pushes the branch and tag atomically, and lets GitHub Actions publish verified Chrome and Firefox packages.

The first execution will release the current worktree as `v1.5.12`.

## User Command

```powershell
corepack.cmd pnpm run release:push
```

This command is the supported replacement for a raw release-time `git push`. A normal `git push` remains available for non-release Git operations, but it does not create a GitHub Release.

## Local Release Flow

The release script will:

1. Require the `main` branch and an `origin` remote.
2. Fetch `origin/main` and tags, then stop if the local branch is behind or diverged.
3. Read the current `package.json` version and increment its patch component.
4. Synchronize the new version across `package.json`, `manifest.config.ts`, `popup.html`, and `sidebar.html`.
5. Run the repository release gates before any remote change:
   - `corepack.cmd pnpm run verify`
   - `corepack.cmd pnpm run audit:dependencies`
   - `corepack.cmd pnpm run build:browsers`
   - `corepack.cmd pnpm run audit:production`
   - `corepack.cmd pnpm run test:e2e`
   - `git diff --check`
6. Stage all tracked and untracked non-ignored worktree changes with `git add -A`.
7. Create one release commit and an annotated `v<version>` tag.
8. Atomically push `main` and the tag to `origin`.

The first release commit will therefore include all current functional changes and the release automation, while generated output under `dist/`, `artifacts/`, `.e2e-dist/`, `playwright-report/`, and `test-results/` remains ignored.

When the user explicitly retains real interaction testing, `--skip-e2e` may omit the local Playwright run. The tag workflow still runs deterministic E2E and cannot publish the GitHub Release until it passes.

## Retry And Failure Behavior

- A validation failure makes no remote change and leaves local files available for diagnosis.
- A commit or tag failure makes no remote change.
- An atomic push failure leaves the local release commit and tag intact.
- Re-running after an atomic push failure detects that the current version tag already points at `HEAD` and retries that same push instead of incrementing the version again.
- The script stops if the target tag already exists remotely, preventing accidental replacement of a published version.

The script never runs destructive Git operations and never rewrites history.

## GitHub Actions Release Flow

A dedicated workflow will run for tags matching `v*`.

The workflow will:

1. Check out the tagged commit.
2. Install the repository-pinned pnpm dependencies on Node 24.
3. Confirm the tag version matches `package.json`.
4. Run the same deterministic verification, dependency audit, browser build, production audit, and Playwright E2E gates.
5. Create a GitHub Release only after all gates pass.
6. Attach `pinpinto-chrome-v<version>.zip` and `pinpinto-firefox-v<version>.xpi`.
7. Use GitHub-generated release notes and publish the release as the latest release.
8. Upload Playwright evidence when the workflow fails or is cancelled.

The workflow receives only `contents: write`, which is required to create the Release and upload assets. It does not commit back to `main`, so it cannot create a recursive push loop.

## Existing Release Scripts

The old rule that releases only versions matching `1.(5n).0` conflicts with the new requirement. Release helpers and their tests will be adjusted so every explicit `release:push` execution is eligible for publication.

`package.json` remains the version source of truth. Build and production-audit scripts continue to enforce that packaged manifests match it.

## Validation And Success Criteria

The implementation is complete when:

- Version helper tests cover patch increments, synchronized file updates, invalid versions, existing tags, and retry detection.
- Existing release tests reflect the new every-release rule.
- The repository verification and release gates pass locally.
- `git diff --check` passes.
- `main` and `v1.5.12` are pushed atomically.
- The GitHub Actions release run succeeds.
- GitHub Release `v1.5.12` contains both browser artifacts.

## Rollback

If the remote publication must be withdrawn:

1. Delete GitHub Release `v1.5.12` and its remote tag.
2. Create a normal `git revert` commit for the release commit if the source changes must also be undone.
3. Push the revert as a new history-preserving commit.

No force push, tag replacement, or history rewrite is part of the rollback procedure.

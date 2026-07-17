# PinPinto

[中文 README](README.md)

A Pinterest image collection and batch-download extension for Chrome, Edge, and Firefox.

## Features
- Detect and select images on the page
- Auto-scroll to collect more images
- Customize the image count for each auto-download batch
- Choose ZIP or controlled individual-file output for manual selected downloads
- Use browser Blob downloads for card-level single images by default, with a best-effort external-downloader option
- Stop auto-download after the current batch; the cancel button remains the immediate abort path
- Auto-scroll selects only newly discovered eligible images after it is enabled
- Background-owned batch state that reconnects after the popup or side panel is reopened
- Browser fallback downloads for images that cannot be fetched into the ZIP
- Batch ZIP download
- Popup and side-panel entry points
- Target-tab locking (side panel actions stay on the intended Pinterest tab)

## Quick Start
1. Install dependencies
```bash
corepack.cmd pnpm install
```
2. Build the extension
```bash
corepack.cmd pnpm build
```
   - This produces the desktop **Chrome / Edge** build in `dist`
   - The sidebar entry uses the real `side_panel` container instead of a tab fallback
3. Load unpacked extension
- Open `chrome://extensions` or `edge://extensions`
- Enable Developer Mode
- Click “Load unpacked”
- Select the `dist` folder

## Development Commands
```bash
# dev server
corepack.cmd pnpm dev

# automated verification (typecheck + behavior tests + Chrome build)
corepack.cmd pnpm run verify

# build only
corepack.cmd pnpm build

# build Chrome + Firefox release artifacts
corepack.cmd pnpm run build:browsers

# audit the production Chrome and Firefox packages
corepack.cmd pnpm run audit:production

# audit production dependency advisories
corepack.cmd pnpm run audit:dependencies

# install Chromium before the first end-to-end run
corepack.cmd pnpm exec playwright install chromium

# run deterministic extension end-to-end tests
corepack.cmd pnpm run test:e2e

# verify, bump the patch version, commit all changes, tag, and push atomically
corepack.cmd pnpm run release:push
```

`build:browsers` will:
- output the Chrome package to `artifacts/pinpinto-chrome-v*.zip`
- output the Firefox package to `artifacts/pinpinto-firefox-v*.xpi`
- target Firefox 115 or newer for module background scripts and `storage.session`
- and **keep `dist` as the Chrome build**, so Chrome / Edge do not accidentally load a Firefox manifest

The end-to-end suite uses an isolated Chromium profile and an intercepted Pinterest search page. It requires no login and never mutates a real Pinterest account. It verifies recommendation filtering, an 80-image tail, manual ZIP, manual individual-file output, automatic ZIP, graceful stop, immediate cancel, Blob-backed single-image bytes, retry behavior, successful cleanup, CSP, and accessibility state. Reports, screenshots, and traces are retained on failure.

See the [testing guide](docs/testing.md) for first-time Playwright setup, the complete gate order, failure evidence locations, and the read-only live-smoke boundary.

Use `release:push` for production releases instead of pushing the branch and tag separately. The command increments the patch version and runs the complete local gate by default; after the tag is pushed, GitHub Actions verifies again, builds the Chrome ZIP and Firefox XPI, and creates the GitHub Release. To publish an already synchronized version, use `corepack.cmd pnpm run release:push -- --version=1.5.12`.

## Project Structure
- `src/background.ts`: browser events and message entry point
- `src/background/batch-coordinator.ts`: batch lifecycle, cancellation, and download settlement
- `src/background/individual-download-queue.ts`: manual individual-file queue, three-slot concurrency, and recovery
- `src/background/single-image-download.ts`: card-level Blob/external single-image routing
- `src/background/batch-download.ts`: image fetching, ZIP creation, and browser fallback downloads
- `src/content.ts`: page scanning and selection-overlay entry point
- `src/content/auto-batch-session.ts`: auto-scroll windows and background re-handshake
- `src/content/auto-selection.ts`: new-image auto-selection while auto-scroll is active
- `src/shared/batch-task.ts`: shared batch-task contracts
- `src/popup.ts` / `src/sidebar.ts`: disposable, reconnectable control surfaces
- `src/shared/pinterest.ts`: Pinterest domain constants
- `manifest.config.ts`: CRX manifest source

## License
MIT (see [LICENSE](LICENSE))

PinPinto is not affiliated with, endorsed by, or officially connected to Pinterest, Inc. Download only content you have a lawful right to download, and comply with applicable law, Pinterest's terms, copyright, and other intellectual property requirements.

---
Upstream tribute: [inyogeshwar/pinvault-pro-extension](https://github.com/inyogeshwar/pinvault-pro-extension)



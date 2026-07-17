# PinPinto

[中文 README](README.md)

A Pinterest image collection and batch-download extension for Chrome, Edge, and Firefox.

## Core Features
- Detect and select images on the page
- Auto-scroll to collect more images
- Customize the image count for each auto-download batch
- Download manually selected images as a ZIP or individual files
- Use browser Blob downloads for card-level images, with a best-effort external-downloader option
- Stop auto-download after the current batch or cancel it immediately
- Control a locked target tab from either the popup or side panel

## Quick Start
1. Install dependencies
```bash
corepack.cmd pnpm install
```
2. Build the extension
```bash
corepack.cmd pnpm build
```
3. Load unpacked extension
- Open `chrome://extensions` or `edge://extensions`
- Enable Developer Mode
- Click “Load unpacked”
- Select the `dist` folder

## Development Commands
```bash
# dev server
corepack.cmd pnpm dev

# regenerate extension icons
corepack.cmd pnpm run icon:build

# typecheck
corepack.cmd pnpm run typecheck

# Node behavior and contract tests
corepack.cmd pnpm run test:release

# automated verification: typecheck, behavior tests, and Chrome build
corepack.cmd pnpm run verify

# build and package the Chrome / Edge extension
corepack.cmd pnpm build

# build Chrome + Firefox release artifacts
corepack.cmd pnpm run build:browsers

# production-package audit
corepack.cmd pnpm run audit:production

# production-dependency audit
corepack.cmd pnpm run audit:dependencies

# install Chromium before the first end-to-end run
corepack.cmd pnpm exec playwright install chromium

# run deterministic extension end-to-end tests
corepack.cmd pnpm run test:e2e

# release preflight and local release commands
corepack.cmd pnpm run release:preflight
corepack.cmd pnpm run release
corepack.cmd pnpm run release:force
corepack.cmd pnpm run release:push
```

See the [testing guide](docs/testing.md) for Playwright setup, complete quality gates, failure evidence, release workflow, and the read-only live-smoke boundary.

## License
MIT (see [LICENSE](LICENSE))

PinPinto is not affiliated with, endorsed by, or officially connected to Pinterest, Inc. Download only content you have a lawful right to download, and comply with applicable law, Pinterest's terms, copyright, and other intellectual property requirements.

---
Upstream tribute: [inyogeshwar/pinvault-pro-extension](https://github.com/inyogeshwar/pinvault-pro-extension)



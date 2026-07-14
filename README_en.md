# PinPinto

[中文 README](README.md)

A Pinterest image collection and batch-download extension for Chrome, Edge, and Firefox.

## Features
- Detect and select images on the page
- Auto-scroll to collect more images
- Customize the image count for each auto-download batch
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
```

`build:browsers` will:
- output the Chrome package to `artifacts/pinpinto-chrome-v*.zip`
- output the Firefox package to `artifacts/pinpinto-firefox-v*.xpi`
- target Firefox 115 or newer for module background scripts and `storage.session`
- and **keep `dist` as the Chrome build**, so Chrome / Edge do not accidentally load a Firefox manifest

## Project Structure
- `src/background.ts`: browser events and message entry point
- `src/background/batch-coordinator.ts`: batch lifecycle, cancellation, and download settlement
- `src/background/batch-download.ts`: image fetching, ZIP creation, and browser fallback downloads
- `src/content.ts`: page scanning and selection-overlay entry point
- `src/content/auto-batch-session.ts`: auto-scroll windows and background re-handshake
- `src/shared/batch-task.ts`: shared batch-task contracts
- `src/popup.ts` / `src/sidebar.ts`: disposable, reconnectable control surfaces
- `src/shared/pinterest.ts`: Pinterest domain constants
- `manifest.config.ts`: CRX manifest source

## License
MIT (see [LICENSE](LICENSE))

---
Upstream tribute: [inyogeshwar/pinvault-pro-extension](https://github.com/inyogeshwar/pinvault-pro-extension)



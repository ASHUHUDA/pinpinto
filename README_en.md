# PinPinto

[中文 README](README.md)

A Chrome/Edge Manifest V3 extension for collecting and batch-downloading Pinterest images.

## Features
- Detect and select images on the page
- Auto-scroll to collect more images
- Customize the image count for each auto-download batch
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

# automated verification (typecheck + build)
corepack.cmd pnpm run verify

# build only
corepack.cmd pnpm build

# build Chrome + Firefox release artifacts
corepack.cmd pnpm run build:browsers
```

`build:browsers` will:
- output the Chrome package to `artifacts/pinpinto-chrome-v*.zip`
- output the Firefox package to `artifacts/pinpinto-firefox-v*.xpi`
- and **keep `dist` as the Chrome build**, so Chrome / Edge do not accidentally load a Firefox manifest

## Project Structure
- `src/background.ts`: download orchestration
- `src/content.ts`: page scan and selection overlays
- `src/popup.ts`: popup controller
- `src/sidebar.ts`: side-panel controller
- `src/shared/pinterest.ts`: Pinterest domain constants
- `manifest.config.ts`: CRX manifest source

## License
MIT (see [LICENSE](LICENSE))

---
Upstream tribute: [inyogeshwar/pinvault-pro-extension](https://github.com/inyogeshwar/pinvault-pro-extension)



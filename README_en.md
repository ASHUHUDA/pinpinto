# PinPinto

[中文 README](README.md)

A Chrome/Edge Manifest V3 extension for collecting and batch-downloading Pinterest images.

## Features
- Detect and select images on the page
- Auto-scroll to collect more images
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
```

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



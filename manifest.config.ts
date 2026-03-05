import { defineManifest } from '@crxjs/vite-plugin'
import { PINIMG_MATCH_PATTERNS, PINTEREST_MATCH_PATTERNS } from './src/shared/pinterest'

export default defineManifest({
  manifest_version: 3,
  name: 'PinPinto - Pinterest Downloader',
  version: '1.3.5',
  description: 'Batch download Pinterest images with auto-scroll and ZIP packaging.',
  permissions: ['downloads', 'storage', 'contextMenus', 'activeTab', 'scripting', 'sidePanel', 'windows'],
  host_permissions: [...PINTEREST_MATCH_PATTERNS, ...PINIMG_MATCH_PATTERNS],
  background: {
    service_worker: 'src/background.ts',
    type: 'module'
  },
  content_scripts: [
    {
      matches: PINTEREST_MATCH_PATTERNS,
      js: ['src/content.ts']
    }
  ],
  action: {
    default_popup: 'popup.html',
    default_title: 'PinPinto Downloader',
    default_icon: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png'
    }
  },
  side_panel: {
    default_path: 'sidebar.html'
  },
  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png'
  },
  web_accessible_resources: [
    {
      resources: ['icons/*.png'],
      matches: PINTEREST_MATCH_PATTERNS
    }
  ]
})

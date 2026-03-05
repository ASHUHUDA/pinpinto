import { defineManifest } from '@crxjs/vite-plugin'
import { PINIMG_MATCH_PATTERNS, PINTEREST_MATCH_PATTERNS } from './src/shared/pinterest'

const runtimeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const browserTarget = (runtimeEnv.BROWSER_TARGET || 'chrome').toLowerCase()
const isFirefoxTarget = browserTarget === 'firefox'

const basePermissions = ['downloads', 'storage', 'contextMenus', 'activeTab', 'scripting', 'windows']
const permissions = isFirefoxTarget ? basePermissions : [...basePermissions, 'sidePanel']

const browserUiSection = isFirefoxTarget
  ? {
      sidebar_action: {
        default_title: 'PinPinto Downloader',
        default_panel: 'sidebar.html',
        default_icon: {
          '16': 'icons/icon16.png',
          '32': 'icons/icon32.png',
          '48': 'icons/icon48.png',
          '128': 'icons/icon128.png'
        }
      },
      browser_specific_settings: {
        gecko: {
          id: 'pinpinto@ashuhuda.dev',
          strict_min_version: '109.0'
        }
      }
    }
  : {
      side_panel: {
        default_path: 'sidebar.html'
      }
    }

export default defineManifest({
  manifest_version: 3,
  name: 'PinPinto - Pinterest Downloader',
  version: '1.4.3',
  description: 'Batch download Pinterest images with auto-scroll and ZIP packaging.',
  permissions,
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
  ...browserUiSection,
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





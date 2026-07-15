import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

const runtimeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const isFirefoxTarget = (runtimeEnv.BROWSER_TARGET || 'chrome').toLowerCase() === 'firefox'
const isE2EBuild = runtimeEnv.PINPINTO_E2E === 'true'

const pageInputs: Record<string, string> = {
  popup: 'popup.html',
  sidebar: 'sidebar.html',
  welcome: 'welcome.html'
}

if (!isFirefoxTarget) pageInputs.offscreen = 'offscreen.html'

export default defineConfig({
  define: {
    __PINPINTO_BROWSER_TARGET__: JSON.stringify(isFirefoxTarget ? 'firefox' : 'chrome'),
    __PINPINTO_E2E__: JSON.stringify(isE2EBuild)
  },
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        ...pageInputs
      }
    }
  }
})


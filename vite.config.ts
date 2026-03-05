import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        popup: 'popup.html',
        sidebar: 'sidebar.html',
        welcome: 'welcome.html'
      }
    }
  }
})


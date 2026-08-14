import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri drives the dev server, so the port is fixed and failures must be loud
// rather than silently hopping to 1421 — a moved port shows up as a white window.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],

  // foliate-js ships as unbundled ESM source whose modules import each other by
  // relative path. Pre-bundling it rewrites those specifiers and breaks the
  // dynamic imports it does for zip and CFI handling, so it stays raw.
  optimizeDeps: { exclude: ['foliate-js'] },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // The webview is known at build time: WebKit on macOS/Linux, WebView2 on
    // Windows. Targeting them directly avoids shipping transpiled fallbacks.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})

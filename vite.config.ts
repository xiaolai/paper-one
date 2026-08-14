import { cp } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Serve pdf.js's runtime data at `/pdfjs/`, from OUTSIDE `public/`.
 *
 * It cannot live in `public/`, which is the obvious home for it. pdf.js loads
 * its JPEG 2000 and JBIG2 decoders as WebAssembly and falls back to a sibling
 * `*_nowasm_fallback.js` when that fails — and it always fails on macOS,
 * because pdf.js 6 compiles those decoders with WebAssembly relaxed SIMD, which
 * WebKit does not implement ("doesn't parse at byte 3093: relaxed simd
 * instructions not supported"). The fallback is therefore the load-bearing
 * path here, not a contingency.
 *
 * Vite refuses to serve it from `public/`: a dynamic import that resolves into
 * publicDir is an error, because files there are copied verbatim and never
 * transformed. The result was a dev-server overlay and, worse, every page of a
 * SCANNED book failing to decode — those books are nothing but JBIG2 images.
 *
 * So the files are staged outside publicDir and served by this plugin in dev,
 * then copied into `dist/pdfjs` for the build. Vite's module pipeline never
 * sees them, which is the entire point.
 */
function pdfjsAssets(): Plugin {
  const source = join(process.cwd(), 'vendor', 'pdfjs')
  const types: Record<string, string> = {
    '.wasm': 'application/wasm',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.bcmap': 'application/octet-stream',
  }

  return {
    name: 'paper:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/pdfjs/')) return next()
        /* The query string is stripped FIRST. Vite appends `?import` to a
         * dynamically imported module, and pdf.js reaches its decoder fallback
         * that way — so without this the path became a file named
         * `openjpeg_nowasm_fallback.js?import`, which does not exist. The read
         * failed, the request fell through to Vite, and Vite rejected it. The
         * visible symptom was every image in a scanned book failing to decode. */
        const path = req.url.slice('/pdfjs/'.length).split(/[?#]/)[0] ?? ''
        // Normalised and re-joined so a `..` cannot climb out of the directory.
        const rel = normalize(decodeURIComponent(path))
        if (rel.startsWith('..')) return next()
        const file = join(source, rel)
        if (process.env['PAPER_LOG_PDFJS']) console.log('[pdfjs] ' + rel)
        res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
        createReadStream(file)
          .on('error', () => next())
          .pipe(res)
      })
    },
    async closeBundle() {
      await cp(source, join(process.cwd(), 'dist', 'pdfjs'), { recursive: true })
    },
  }
}

// Tauri drives the dev server, so the port is fixed and failures must be loud
// rather than silently hopping to 1421 — a moved port shows up as a white window.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), pdfjsAssets()],

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

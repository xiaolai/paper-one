import { cp } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { type Plugin } from 'vite'
// `defineConfig` from vitest rather than from vite, so the `test` block below
// is typed. It is the same function; vitest re-exports it with its own field.
import { defaultExclude, defineConfig } from 'vitest/config'
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

  /** Set from `configResolved` — see `closeBundle`. */
  let building = false
  /** The build's own output directory, absolute. Taken from the resolved
   *  config rather than assumed to be `./dist`, which is wrong the moment
   *  anything passes `--outDir`. */
  let outDir = join(process.cwd(), 'dist')

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
        const stream = createReadStream(file)
        /* A missing asset is a 404 from THIS handler, not a fall-through.
         *
         * `next()` after the pdf.js content type was already set handed the
         * request to Vite, which answered with the SPA's index.html — so
         * pdf.js received an HTML page labelled `application/wasm` and failed
         * somewhere deep in its decoder, with nothing anywhere naming the file
         * that was missing. This is how a `vendor/pdfjs` that had not been
         * staged presented itself: scanned pages rendering blank. */
        stream.on('error', (cause: NodeJS.ErrnoException) => {
          console.error(`[pdfjs] ${rel}: ${cause.code ?? cause.message}`)
          res.statusCode = cause.code === 'ENOENT' ? 404 : 500
          res.setHeader('Content-Type', 'text/plain')
          res.end(`pdf.js asset unavailable: ${rel}. Run scripts/sync-pdfjs-assets.mjs.`)
        })
        stream.once('open', () => {
          // Set on open, so the error path above can still choose its own.
          res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
          stream.pipe(res)
        })
      })
    },
    configResolved(config) {
      building = config.command === 'build'
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      /* Only when this run was a BUILD.
       *
       * Vite calls `closeBundle` when the dev server shuts down as well, so
       * stopping `pnpm dev` — with Ctrl-C, or by Tauri exiting — copied the
       * vendored assets into `dist/pdfjs`. That directory belongs to the last
       * production build, so quitting the dev server left a build tree
       * carrying assets from a different moment than the code beside them.
       *
       * Guarded here rather than with `apply: 'build'`, which would be the
       * obvious move and is wrong: it would take `configureServer` with it and
       * leave the dev server unable to serve `/pdfjs/` at all. */
      if (!building) return
      await cp(source, join(outDir, 'pdfjs'), { recursive: true })
    },
  }
}

/**
 * Cut foliate's own PDF loader out of the module graph.
 *
 * `view.js` does `await import('./pdf.js')` when it sniffs a PDF, and that
 * module statically imports `./vendor/pdfjs/pdf.mjs` — a directory upstream
 * deliberately does NOT ship, because it expects each consumer to vendor
 * pdf.js there itself. Rollup follows the dynamic import while bundling and
 * fails on the missing file, and Vite reads the templated `new URL()` on the
 * line above it as a glob (`vendor/pdfjs/*`) and rejects that too.
 *
 * Paper never reaches it. `prepare` in `FoliateView` turns a PDF into a Book
 * with `makePdf` before `View.open` is ever called, so foliate is never handed
 * a PDF to sniff. Stubbed rather than aliased to an empty module so that if
 * that ever stops being true it throws with a name in it, instead of opening
 * a book with no pages.
 *
 * This could not have shown up before Paper moved to the fork: the npm build
 * of foliate-js had `pdf.js` stripped out of the package altogether. It is
 * also invisible to `pnpm dev` — only a real build walks the import.
 */
function foliatePdfStub(): Plugin {
  const stub = '\0paper:foliate-pdf-stub'
  return {
    name: 'paper:foliate-pdf-stub',
    // Without `pre` this never runs: a plugin with no `enforce` is consulted
    // AFTER `vite:resolve`, which has already claimed `./pdf.js` and ended the
    // chain. The stub silently does nothing and the build fails as if it were
    // not there at all.
    enforce: 'pre',
    resolveId(source, importer) {
      return source === './pdf.js' && importer?.includes('foliate-js') ? stub : null
    },
    load(id) {
      if (id !== stub) return null
      return 'export const makePDF = () => {\n'
        + "  throw new Error('foliate-js/pdf.js is stubbed — Paper converts PDFs "
        + "with makePdf() before View.open, so this path should be unreachable')\n"
        + '}\n'
    },
  }
}

// Tauri drives the dev server, so the port is fixed and failures must be loud
// rather than silently hopping to 14202 — a moved port shows up as a white window.
//
// 14201 rather than Vite's usual 1420: that default is what every other Tauri
// project on this machine also picks, so two of them running at once meant
// whichever bound first won and the second silently attached to the wrong app.
// `devUrl` in `src-tauri/tauri.conf.json` must move with it or the window loads
// nothing, with no error to say why — the same pairing the MCP bridge port has.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), pdfjsAssets(), foliatePdfStub()],

  // foliate-js ships as unbundled ESM source whose modules import each other by
  // relative path. Pre-bundling it rewrites those specifiers and breaks the
  // dynamic imports it does for zip and CFI handling, so it stays raw.
  optimizeDeps: { exclude: ['foliate-js'] },

  clearScreen: false,
  server: {
    port: 14201,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 14202 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },

  /* TEST DISCOVERY STOPS AT THIS CHECKOUT.
   *
   * Agent worktrees live under `.claude/worktrees/`, and each one is a separate
   * checkout with its own `node_modules` — usually none at all. Vitest's default
   * `include` walks the whole tree, so one leftover worktree turned `pnpm test`
   * red on a missing dependency in a checkout nobody was working in: a failing
   * gate that says nothing about this one, on a file this branch does not have.
   *
   * Extended from `defaultExclude` rather than written out, so excluding this
   * does not quietly stop excluding `node_modules` and `dist`.
   */
  test: {
    exclude: [...defaultExclude, '.claude/worktrees/**'],
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

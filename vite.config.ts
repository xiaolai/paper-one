import { cp } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { type Plugin } from 'vite'
// `defineConfig` from vitest rather than from vite, so the `test` block below
// is typed. It is the same function; vitest re-exports it with its own field.
import { defaultExclude, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { paperComposition } from './scripts/vite/assert-bundle.mjs'

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

/**
 * Put the app's launch timings in THIS terminal.
 *
 * `console.info` in the webview goes to devtools and to the automation bridge,
 * and neither is where someone running `pnpm app` is looking. The webview has
 * no other channel to the terminal: `tauri-plugin-log` prints what RUST logs,
 * and forwarding the JS console into it needs `@tauri-apps/plugin-log` and a
 * capability grant — a dependency and a permission for a dev-only diagnostic.
 *
 * The dev server is already connected to the page over the HMR socket, so the
 * message rides that. Nothing here exists in a build: `import.meta.hot` is
 * undefined outside dev, and this plugin only ever installs a server handler.
 *
 * See `src/kernel/ui/devTiming.ts` for what is sent.
 */
function timingLog(): Plugin {
  return {
    name: 'paper:timing-log',
    apply: 'serve',
    configureServer(server) {
      server.ws.on('paper:timing', (data: unknown) => {
        const row = (data ?? {}) as {
          name?: string
          took?: number | null
          at?: number | null
          hidden?: boolean
          detail?: object
        }
        const when =
          (typeof row.took === 'number' ? ` took=${row.took.toFixed(0)}ms` : '') +
          (typeof row.at === 'number' ? ` at=${row.at.toFixed(0)}ms` : '')
        const rest = Object.entries(row.detail ?? {})
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')
        /* HIDDEN IS SHOUTED, because a timing taken behind another window
           measures the window server rather than the app. */
        const seen = row.hidden ? ' HIDDEN' : ''
        console.log(`[timing] ${row.name ?? '?'}${when}${rest ? ' ' + rest : ''}${seen}`)
      })
    },
  }
}

/**
 * SERVE THE PHONE'S ENTRY AT THE ROOT, in dev.
 *
 * A build selects its entry through `rollupOptions.input`, but the dev server
 * has no such list: it serves whatever the request asks for, and the Tauri
 * webview asks for `/`. That resolves to `index.html` — the DESKTOP entry — so
 * without this, `tauri ios dev` builds an iOS app with the right capabilities
 * and shows the desktop shell inside it. Exactly the bug the separate entry
 * exists to fix, reappearing in dev only, which is the worse half: the built
 * app would be right and the one being worked on would be wrong.
 *
 * A REWRITE RATHER THAN A REDIRECT. The URL stays `/`, so Vite's HTML
 * transform, the HMR client and every relative asset resolve as they do for
 * any other entry; a 302 to `/index.mobile.html` would work and would put the
 * filename in the address the app runs under, which is what a reload then
 * carries around.
 *
 * ## And the BUILD has the mirror image of the same problem
 *
 * Vite names an HTML output after its input, so `index.mobile.html` builds to
 * `dist-mobile/index.mobile.html`. Tauri serves `frontendDist` as a static
 * directory and loads `index.html` from its root — there is no server in
 * between to map one to the other. The browser client gets away with the same
 * shape only because `paper-webhost` has an explicit `ENTRY` constant pointing
 * at `/index.web.html`; a phone has nothing to point.
 *
 * So the emitted file is renamed here. ⚠️ **The failure it prevents is silent
 * and reads as unrelated**: the app builds, installs and launches to a blank
 * white webview, because `tauri://localhost/` 404s and nothing logs it.
 *
 * Guarded by MOBILE on both hooks rather than by `apply`, since one is a serve
 * hook and the other a build hook — on any other platform this plugin is
 * inert.
 */
function mobileEntry(): Plugin {
  return {
    name: 'paper:mobile-entry',
    /* AFTER VITE'S OWN HTML PLUGIN. `vite:build-html` emits the document in
       its `generateBundle`, so a hook at normal order runs BEFORE the file it
       means to rename exists — the assertion below caught exactly that, with
       an input list containing every font and no HTML at all. */
    enforce: 'post',
    generateBundle(_options, bundle) {
      if (!MOBILE) return
      const built = bundle[MOBILE_HTML]
      /* NOT A WARNING. A missing entry here means the input moved and the
         bundle has no `index.html` at all, which is exactly the blank window
         this hook exists to prevent — and a warning scrolls past. */
      if (!built) {
        throw new Error(
          `paper:mobile-entry: ${MOBILE_HTML} is not in the bundle, so nothing can be renamed to index.html — ` +
            `the mobile app would launch to a blank webview. Inputs: ${Object.keys(bundle).join(', ')}`,
        )
      }
      built.fileName = 'index.html'
      delete bundle[MOBILE_HTML]
      bundle['index.html'] = built
    },
    configureServer(server) {
      if (!MOBILE) return
      server.middlewares.use((req, _res, next) => {
        /* THE BARE ROOT ONLY. A query string is kept (`?platform=ios` pins the
           chrome for a design check), and any other path — an asset, a module,
           the HMR socket — is left alone. */
        if (req.url === '/' || req.url?.startsWith('/?')) {
          req.url = `/${MOBILE_HTML}` + (req.url.length > 1 ? req.url.slice(1) : '')
        }
        next()
      })
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
/** Is this build for a phone? `ios`, and `android`/`androideabi` for the ABI
 *  variant the Tauri CLI sets on some Android targets — the same three values
 *  `platformFromTauriEnv` folds into two platforms. */
const MOBILE = ['ios', 'android', 'androideabi'].includes(process.env.TAURI_ENV_PLATFORM ?? '')

/** The phone's HTML entry, named once — the dev-server rewrite and the build's
 *  rename have to agree about it, and two spellings is how they stop agreeing. */
const MOBILE_HTML = 'index.mobile.html'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  // `paperComposition()` resolves `virtual:paper-composition` (imported by
  // src/main.tsx) to this build's platform composition from
  // `TAURI_ENV_PLATFORM`, and at `generateBundle` fails the build unless the
  // bundle holds exactly that platform's manifest set — the WI-5.9 assertion,
  // inside the build. See scripts/vite/assert-bundle.mjs.
  //
  // `timingLog()` is dev-only (`apply: 'serve'`) and puts the launch timings
  // `kernel/ui/devTiming` sends over the HMR socket into THIS terminal.
  plugins: [paperComposition(), react(), pdfjsAssets(), foliatePdfStub(), timingLog(), mobileEntry()],

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

  /* NO `public/` IN THE WEB BUILD. It holds three sample books — one of them
   * 3.1 MB — which vite copies verbatim into the output, and that output is
   * then embedded byte for byte into the shipped binary by
   * `tauri-plugin-webhost`'s build script. pdf.js's runtime is NOT affected:
   * it is staged from `vendor/` by `pdfjsAssets()`, deliberately outside
   * `publicDir` (see that plugin's note).
   *
   * A ROOT option, not a `build` one — written under `build` first, where it
   * is silently ignored and the books shipped anyway. */
  ...(process.env.TAURI_ENV_PLATFORM === 'web' ? { publicDir: false as const } : {}),

  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    /* THE WEB BUILD HAS ITS OWN ENTRY, and needs one for two reasons that are
     * both structural rather than stylistic.
     *
     * `index.html` carries an inline script for the first-paint hint, which
     * would need `script-src 'unsafe-inline'` — exactly what the web host's
     * policy refuses, because a book's HTML runs in that origin
     * (`rendererIsolation.test.ts`). And `src/main.tsx` arms a shutdown
     * handshake with the Rust shell, tears down the sync journal, and migrates
     * a legacy library: all dead in a browser, and all reached through imports
     * that would pull `@tauri-apps` into the bundle.
     *
     * So `index.web.html` → `src/main.web.tsx`, selected here rather than by a
     * branch inside either file. */
    /* A SEPARATE OUTPUT DIRECTORY, and this is not tidiness. Both builds
     * default to `dist/`, so running one after the other leaves that directory
     * holding whichever went last — a desktop bundle where the shelf expects a
     * browser one, or the reverse, with nothing anywhere saying so. They are
     * different programs and they get different directories. */
    ...(process.env.TAURI_ENV_PLATFORM === 'web'
      ? {
          outDir: 'dist-web',
          rollupOptions: { input: 'index.web.html' },
        }
      : {}),
    /* THE PHONE'S ENTRY, selected the same way and for the same reason.
     *
     * `index.html` -> `src/main.tsx` mounts `App`, the DESKTOP shell: a
     * titlebar with traffic lights, a side pane, a command palette. Building
     * that for iOS and Android is what the mobile build did until this branch —
     * the platform picked the right CAPABILITIES all along (`composition.ios.ts`
     * is `[peer, sync]`) and then rendered the wrong shell over them.
     *
     * `index.mobile.html` -> `src/main.mobile.tsx` mounts the mobile design's
     * shell instead, over the same launch sequence. Selected HERE rather than
     * by a branch inside either file, so the desktop pane tree is not in the
     * phone's module graph at all.
     *
     * A SEPARATE OUTPUT DIRECTORY, for the reason spelled out above `dist-web`:
     * all three builds would otherwise default to `dist/`, and running one
     * after another leaves that directory holding whichever went last. The
     * per-platform Tauri configs point at this one. */
    ...(MOBILE
      ? {
          outDir: 'dist-mobile',
          rollupOptions: { input: MOBILE_HTML },
        }
      : {}),
    // The webview is known at build time: WebKit on macOS/Linux, WebView2 on
    // Windows. Targeting them directly avoids shipping transpiled fallbacks.
    // A browser build is served to an unknown phone, so it targets the oldest
    // engine worth supporting rather than the one this machine happens to run.
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows'
        ? 'chrome105'
        : process.env.TAURI_ENV_PLATFORM === 'web'
          ? 'safari16'
          : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})

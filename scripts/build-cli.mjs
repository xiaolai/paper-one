import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm build:cli` — bundle `src/cli/main.ts` into the `paper` executable.
 *
 * WHY A BUNDLE AT ALL, since Node 24 strips types on its own. Because the
 * tree imports WITHOUT file extensions (`./lib/port`, `../kernel`), and
 * Node's ESM resolver does not fill them in — so `node src/cli/main.ts`
 * fails on the first relative import it reaches, whatever it does with the
 * types. Rewriting several hundred imports to satisfy one entry point would
 * be the wrong trade; one bundling step is the right one.
 *
 * WHY VITE rather than esbuild directly: esbuild is a transitive dependency
 * here and is not resolvable from the repository root under pnpm, while Vite
 * is a declared devDependency and is already the build this project uses.
 * Same bundler underneath, no new dependency, and the CLI is built by the
 * same tool as the app.
 *
 * WHY NOT `dist/`: `vite build` empties its own output directory, so a CLI
 * emitted there would be deleted by the next `pnpm build`. `bin/` is the
 * CLI's, is gitignored, and is where `package.json`'s `bin` points.
 *
 * THE OUTPUT IS CHECKED, and that is the only real failure signal there is.
 * A bundler that wrote nothing exits 0 exactly like one that wrote
 * everything — the same trap `actool` sets for the icon build, and the same
 * answer: assert the artifact exists and is not empty, by name.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const ENTRY = 'src/cli/main.ts'
export const OUT_DIR = 'bin'
export const OUT_FILE = 'paper.mjs'
/** Anything smaller than this is a bundle that did not bundle. Measured at
 *  roughly 200 KB when this was written; the floor is deliberately far below
 *  that, because it exists to catch "empty", not to police size. */
export const MIN_BYTES = 4096

/** The shebang, so `bin/paper.mjs` is executable without naming node. */
const BANNER = '#!/usr/bin/env node'

/**
 * Build the CLI under `root`. Resolves with the absolute output path.
 *
 * Rejects when the bundle is missing or implausibly small — see the header.
 */
export async function buildCli(root = REPO_ROOT) {
  const outDir = path.join(root, OUT_DIR)
  await mkdir(outDir, { recursive: true })
  /* THE OLD ONE GOES FIRST, and this is the whole assertion rather than
   * tidiness. `bin/` is not emptied by the build (a human may have put
   * something else in it), so a build that produced NOTHING would leave
   * yesterday's bundle in place — and the size check below would find a file
   * over the floor and report success. The same trap `actool` sets, and the
   * same answer: make the artifact's existence mean this run wrote it. */
  await rm(path.join(outDir, OUT_FILE), { force: true })
  /* What `bin/` held BEFORE this build, so the residue sweep below can tell
   * the old build's leftovers from anything this build wrote. */
  const before = new Set(await readdir(outDir))
  await build({
    root,
    /* Vite's own config file is the APP's: it installs the composition
     * resolver, the React plugin and the pdf.js copy step, none of which a
     * CLI wants and one of which would fail without a platform. */
    configFile: false,
    /* NOTHING FROM `public/`. `configFile: false` leaves Vite's DEFAULT
     * `publicDir`, which is `public/` — the app's static assets, and whatever
     * a developer drops there to try the reader on. Every `build:cli` copied
     * all of it into `bin/`: measured 2026-08-28, three books beside the
     * bundle, one of them a 3 MB PDF. This build owns exactly one file. */
    publicDir: false,
    logLevel: 'warn',
    /* See the note in `build` below: this is the option that bundles the
     * dependencies in rather than leaving them as bare imports. */
    ssr: { noExternal: true },
    build: {
      outDir,
      /* NOT emptied: `bin/` is a directory a human may have put something in,
       * and this owns exactly one file in it. */
      emptyOutDir: false,
      target: 'node24',
      minify: false,
      /* SSR mode is what makes `node:` builtins external and keeps the output
       * a real ES module rather than a browser bundle with polyfills. */
      ssr: true,
      /* NOTE: the `noExternal` that makes this bundle self-contained is a
       * TOP-LEVEL `ssr` option, below — `build.ssr` only says "this is an SSR
       * build". Setting it here silently does nothing, which is how the first
       * version shipped a bundle that still had two bare imports in it.
       *
       * EVERYTHING ELSE GOES IN. `ssr: true` externalises `node_modules` by
       * default, which for this entry point is wrong twice over:
       *
       *   - the output is then not a FILE, it is a file plus whichever
       *     `node_modules` happens to sit beside it. `foliate-js` is pinned
       *     to a commit SHA and the pin DIFFERS BETWEEN BRANCHES of this
       *     repository, so a bundle copied to another machine resolved
       *     `compare` and `collapse` from a different fork commit than it was
       *     built against — in the one dependency `AGENTS.md` records as
       *     having silently rewritten its API past a green `tsc`. The CLI
       *     compares CFIs (`mark.list` orders by `compareMarks`), so that is
       *     not a theoretical mismatch.
       *   - it dragged `@tauri-apps/plugin-fs` into a Node process, reached
       *     through the kernel's public entry by `bookVault.ts`. Harmless
       *     today and a landmine: a plugin that grew an import-time check for
       *     the Tauri IPC would break `paper` on a machine that has no app.
       *
       * Bundled, `bin/paper.mjs` imports `node:` builtins and nothing else —
       * which is what makes `scp bin/paper.mjs other-mac:` a correct way to
       * put the CLI on a second machine, rather than one that appears to
       * work. `scripts/build-cli.mjs`'s own test asserts it. */
      rollupOptions: {
        input: path.join(root, ENTRY),
        output: { format: 'es', entryFileNames: OUT_FILE, banner: BANNER },
      },
    },
  })
  const out = path.join(outDir, OUT_FILE)
  let size = 0
  try {
    size = (await stat(out)).size
  } catch (cause) {
    throw new Error(`build:cli wrote no ${OUT_DIR}/${OUT_FILE} (${cause?.code ?? cause?.message})`, { cause })
  }
  if (size < MIN_BYTES) {
    throw new Error(`build:cli wrote ${OUT_DIR}/${OUT_FILE} at ${size} bytes, under the ${MIN_BYTES}-byte floor`)
  }
  await chmod(out, 0o755)
  await removePublicResidue(root, outDir, before)
  return out
}

/**
 * Remove from `bin/` what the OLD build copied there from `public/`.
 *
 * `emptyOutDir: false` is right — `bin/` is not this build's to empty — but
 * it also means the copies the `publicDir` defect left behind would sit
 * beside the bundle on every machine that ever ran `build:cli`, until a
 * human noticed. A name that `public/` has AND that was in `bin/` before
 * this build ran is that residue by construction: the app's static assets
 * had no other way into `bin/`. Files `public/` does not name are left
 * alone.
 *
 * ONLY WHAT WAS THERE BEFORE. A sweep of every shared name would also erase
 * a copy THIS build made — so a `publicDir` that quietly came back would be
 * swept clean after the fact, and the test that plants a file in `public/`
 * could not tell "never copied" from "copied and swept". Confined to the
 * pre-build listing, a fresh copy survives to fail that test.
 */
export async function removePublicResidue(root, outDir, before) {
  const publicDir = path.join(root, 'public')
  let names
  try {
    names = await readdir(publicDir)
  } catch (cause) {
    if (cause?.code === 'ENOENT') return []
    throw cause
  }
  const removed = []
  for (const name of names) {
    if (!before.has(name)) continue
    await rm(path.join(outDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

if (isProcessEntry(import.meta)) {
  try {
    const out = await buildCli()
    process.stdout.write(`build:cli: ${path.relative(REPO_ROOT, out)}\n`)
  } catch (cause) {
    process.stderr.write(`build:cli: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 1
  }
}

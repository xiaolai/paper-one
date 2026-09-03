import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Vitest's own CLI entry, resolved through the one subpath every package is
 * obliged to export.
 *
 * ⚠️ **NOT `require.resolve('vitest/vitest.mjs')`, which is what two scripts
 * did.** That file still exists and is still the package's `bin` — but vitest 4
 * removed it from the `exports` map, so resolving it throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. The failure is not subtle in effect: it took
 * thirteen tests down in `check-test-ledger.test.mjs` and three more in
 * `check-test-projects.test.mjs`, all with one error, and both gates report the
 * throw as *"vitest could not answer"* — which is the right behaviour and looks
 * exactly like a broken config.
 *
 * ⚠️ **SHARED BECAUSE IT WAS WRITTEN TWICE, and the second copy is how the
 * upgrade cost two rounds instead of one.** Fixing the first file left the
 * second failing for the identical reason in the identical line; two instances
 * are a class, and a class gets one definition.
 *
 * `./package.json` is exported by every package — Node requires it — and
 * `bin.vitest` is where the entry's real name lives, so this follows a rename
 * rather than hard-coding one. Works on vitest 3 and 4 alike.
 *
 * The same shape as `check-boundaries.mjs`'s note about never spawning
 * `node_modules/.bin/depcruise`: reach for what the package declares, never for
 * a path that happens to work today.
 */
export function vitestBin() {
  const manifest = require.resolve('vitest/package.json')
  return path.join(path.dirname(manifest), binEntryOf(require(manifest)))
}

/**
 * The `bin` entry a package manifest declares, as a relative path.
 *
 * ⚠️ **SPLIT OUT SO IT CAN BE TESTED WITHOUT A BROKEN VITEST ON DISK.**
 * `scripts/lib/**` is held to 100% functions and 99.5% lines — the strictest
 * threshold in the repository — and the refusal branch below is unreachable
 * from `vitestBin()` unless the installed vitest declares no `bin`. Taking the
 * manifest as an ARGUMENT makes the whole decision a pure function over a plain
 * object, which is the same shape `undeclaredRequires` was carved into for the
 * same reason.
 *
 * A string `bin` is the shorthand form npm allows (`"bin": "./cli.js"`), and it
 * is handled because a package is free to switch between the two spellings
 * without it being a breaking change — which is exactly the kind of quiet move
 * that broke the caller this module exists to fix.
 */
export function binEntryOf(manifest) {
  const bin = manifest?.bin
  const entry = typeof bin === 'string' ? bin : bin?.vitest
  if (!entry) throw new Error('vitest declares no `bin` — cannot list tests')
  return entry
}

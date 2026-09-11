/**
 * A module resolver that fills in the extension this tree leaves out.
 *
 * `src/kernel/**` imports without file extensions — `from './marks'`, not
 * `'./marks.ts'` — which vite resolves and Node's ESM resolver does not.
 * `scripts/build-cli.mjs` bundles for exactly this reason. `surfaces.mjs`
 * cannot bundle: it needs to EVALUATE the real modules and read the real
 * values out of them, so it registers this instead and lets Node's own type
 * stripping do the rest.
 *
 * ## Why evaluation rather than a parse
 *
 * The alternative is reading `KERNEL_SETTINGS` and its friends with a regex,
 * and `gen-feature-ledger.py`'s own docstring is the argument against it: its
 * first version carried a transcription of the ledger's rows and 44 of them had
 * already diverged before anything compared the two. *A duplicated table does
 * not stay a copy; it becomes a second opinion.* A parse of a declaration is a
 * transcription with extra steps — it agrees with the file until the file uses
 * a shape the pattern did not anticipate, and then it is silently wrong in the
 * safe-looking direction.
 *
 * ⚠️ **THIS DOES NOT REACH `.tsx`, AND THAT IS NODE RATHER THAN THIS FILE.**
 * Type stripping has no JSX, so a module that imports a component cannot be
 * evaluated at all: `--experimental-transform-types` gets past the parameter
 * property in the capability graph and then stops at
 * `Unknown file extension ".tsx"`. Both were measured on node v24.18.0 on
 * 2026-09-10. That is the whole reason `surfaces.mjs` has two collectors and
 * not one, and why the read half carries a known-positive test.
 *
 * ONLY RELATIVE, EXTENSIONLESS SPECIFIERS ARE TOUCHED. A bare specifier is a
 * package and belongs to node_modules; an extension that is already present is
 * an answer somebody wrote down. Anything this does not recognise is handed
 * straight to the next resolver rather than guessed at.
 */

import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Tried in order. `.ts` first because it is almost all of the kernel. */
const EXTENSIONS = Object.freeze(['.ts', '.tsx', '.mts'])

/**
 * A FILE at `candidate`, or null.
 *
 * ⚠️ **`existsSync` ALONE ACCEPTED A DIRECTORY**, so a directory named
 * `item.ts` beat a real `item.mts` beside it and the import then failed
 * downstream for a reason that pointed nowhere near here. Found by audit on
 * 2026-09-11.
 */
function fileAt(candidate) {
  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

export async function resolve(specifier, context, next) {
  /* ⚠️ `startsWith('.')` ALSO ACCEPTED `.private`, which is a BARE specifier
     and not a relative one — if `.private.ts` happened to exist the hook
     rewrote an import it has no business touching. Node's own rule is the two
     explicit prefixes; this now matches it. */
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return next(specifier, context)
  const parent = context.parentURL
  if (parent === undefined || !parent.startsWith('file:')) return next(specifier, context)

  /* ⚠️ **A SPECIFIER IS A URL, NOT A PATH, AND TREATING IT AS ONE LOST THE
     QUERY AND THE PERCENT-ENCODING.** `./marks?audit=1` and `./%6Darks` both
     failed with ERR_MODULE_NOT_FOUND where plain `./marks` resolved — measured
     by audit on 2026-09-11. Resolving through `URL` decodes the pathname the
     way node does and keeps `?`/`#` to hand back on the rewritten specifier. */
  const asUrl = new URL(specifier, parent)
  const tail = `${asUrl.search}${asUrl.hash}`
  const base = fileURLToPath(new URL(asUrl.pathname, parent))
  /* ⚠️ **DECODE BEFORE ASKING WHETHER AN EXTENSION IS ALREADY THERE.** Testing
     the RAW pathname meant `./marks%2Ets` — which already names `marks.ts` —
     looked extensionless, so the hook appended another and resolved it to
     `marks.ts.ts` where that existed. Found by the verification pass on
     2026-09-11 as a defect introduced by the URL fix itself. `fileURLToPath`
     has done the decoding by this point, so `base` is the honest spelling. */
  if (path.extname(base) !== '') return next(specifier, context)

  for (const ext of EXTENSIONS) {
    const found = fileAt(base + ext)
    if (found !== null) return next(`${pathToFileURL(found).href}${tail}`, context)
  }
  for (const ext of EXTENSIONS) {
    const found = fileAt(path.join(base, `index${ext}`))
    if (found !== null) return next(`${pathToFileURL(found).href}${tail}`, context)
  }
  return next(specifier, context)
}

/**
 * Every name the app declares about itself, printed as JSON.
 *
 * `node scripts/surfaces.mjs` — the whole inventory.
 * `node scripts/surfaces.mjs --names` — one name per line, which is what
 * `check-ledger.mjs` reads.
 *
 * ## What this is for
 *
 * `dev-docs/feature-ledger.md` is written by hand and is gitignored, so nothing
 * in a clean checkout can hold it to the tree. The 2026-09-10 audit is what
 * that cost: eight findings, the largest of which was **fifteen shipped
 * reading settings with no row at all** — the third time this repository has
 * discovered a whole surface the ledger had never described.
 *
 * The half of that problem which CAN live in the tree is this file. It answers
 * *what does the app declare* without any opinion about what the ledger says,
 * so it is tracked, runs everywhere, and its test binds CI even where the
 * ledger is absent. `check-ledger.mjs` is the half that reads a ledger, and it
 * skips loudly when there is not one.
 *
 * ## Derived, never transcribed
 *
 * Every value here is read out of the module that declares it, by evaluating
 * that module. Nothing in this file lists a setting, a pane, a service or a
 * theme. The reason is `gen-feature-ledger.py`'s: it began by carrying its own
 * copy of the ledger's 61 rows, and an audit found 44 already differing — *a
 * duplicated table does not stay a copy; it becomes a second opinion.*
 *
 * ⚠️ **THERE ARE TWO COLLECTORS AND THE SECOND ONE IS WEAKER.** The kernel's
 * registries are plain values in modules Node can evaluate through
 * `lib/tsResolve.mjs`. The capability index modules import `.tsx` components
 * and **cannot be evaluated at all** — Node's type stripping has no JSX — so
 * their contribution ids are READ from the source. A read is a pattern, and a
 * pattern agrees with the file until the file changes shape. `surfaces.test.mjs`
 * therefore checks the read half against known positives rather than trusting
 * it, because a collector that finds nothing looks exactly like a clean result
 * — which `check-browser-safe.mjs` shipped twice before it worked.
 */

import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'
import { contributionsIn, namesOf } from './lib/surfaces.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const KERNEL = new URL('../src/kernel/', import.meta.url)
const CAPABILITIES = new URL('../src/capabilities/', import.meta.url)

register(new URL('./lib/tsResolve.mjs', import.meta.url), import.meta.url)

/**
 * The capabilities, by directory name.
 *
 * ⚠️ **READ FROM `capabilities.manifest.json` RATHER THAN LISTED HERE OR
 * GLOBBED.** The manifest is what `check-compositions.mjs` already holds the
 * compositions to, so a capability that exists on disk and is in no manifest is
 * a finding that gate owns — and one in the manifest with no directory is a
 * finding this one raises rather than skips past.
 */
function capabilityIds() {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'capabilities.manifest.json'), 'utf8'))
  return manifest.capabilities.map((c) => c.ts ?? c.id)
}

/** Everything the app declares, as one object. */
export async function collectSurfaces() {
  const load = (rel) => import(new URL(rel, KERNEL).href)

  const [settings, metrics, uiTypes, table, marks, cards, panes, typefaces, formats] = await Promise.all([
    load('core/settings.ts'),
    load('core/metrics.ts'),
    load('core/uiTypes.ts'),
    load('core/serviceTable.ts'),
    load('core/marks.ts'),
    load('core/cards.ts'),
    load('ui/panes.ts'),
    load('core/typefaces.ts'),
    load('core/formats.ts'),
  ])

  const capabilities = {}
  for (const id of capabilityIds()) {
    const file = path.join(fileURLToPath(CAPABILITIES), id, 'index.ts')
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch (cause) {
      throw new Error(
        `capabilities.manifest.json names "${id}" and ${path.relative(REPO_ROOT, file)} cannot be read ` +
          `(${cause.code ?? cause.message}) — a manifest entry with no capability is a finding, not a skip`,
        { cause },
      )
    }
    capabilities[id] = contributionsIn(source)
  }

  return {
    kernelSettings: Object.keys(settings.KERNEL_SETTINGS),
    readingStyle: Object.keys(metrics.DEFAULT_READING_STYLE),
    readingSteps: metrics.READING_STEPS.map((s) => s.size),
    spacingAxes: Object.keys(metrics.SPACING),
    panes: [...uiTypes.KERNEL_PANE_IDS],
    unfinishedPanes: [...uiTypes.UNFINISHED_PANE_IDS],
    aligns: [...uiTypes.ALIGNS],
    services: table.SERVICE_TABLE.map((s) => s.name),
    markTints: [...marks.MARK_TINTS],
    markStyles: [...marks.MARK_STYLES],
    readerStyles: [...marks.READER_STYLES],
    cardKinds: [...cards.CARD_KINDS],
    themes: panes.THEMES.map((t) => t.id),
    paneShortcuts: panes.PANE_SHORTCUTS.map((s) => `${s.combo} ${s.pane}`),
    bundledFaces: typefaces.BUNDLED_FACES.map((f) => f.id),
    allFaces: typefaces.ALL_FACES.map((f) => f.id),
    acceptFormats: formats.ACCEPT_FORMATS.split(','),
    capabilities,
  }
}

const USAGE = 'usage: node scripts/surfaces.mjs [--names]'

async function main(argv) {
  /* ⚠️ AN UNKNOWN ARGUMENT USED TO SUCCEED. `--nmaes` printed the whole JSON
     inventory and exited 0, so a caller asking for the name list got the wrong
     format with every signal saying it had worked. Found by audit 2026-09-11. */
  const unknown = argv.filter((a) => a !== '--names')
  if (unknown.length > 0) {
    process.stderr.write(`surfaces: unknown argument ${JSON.stringify(unknown[0])}\n${USAGE}\n`)
    return 2
  }
  const surfaces = await collectSurfaces()
  if (argv.includes('--names')) {
    for (const name of namesOf(surfaces)) process.stdout.write(`${name}\n`)
    return 0
  }
  process.stdout.write(`${JSON.stringify(surfaces, null, 2)}\n`)
  return 0
}

if (isProcessEntry(import.meta)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error) => {
      process.stderr.write(`surfaces: ${error?.message ?? error}\n`)
      process.exitCode = 2
    },
  )
}

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DELETED_ENV } from './verify-without.mjs'

/**
 * THE KERNEL'S PUBLIC ENTRY RE-EXPORTS NO MODULE FOR NAMES NOBODY IMPORTS.
 *
 * ⚠️ **AN EXPORT NOBODY IMPORTS IS NOT AUTOMATICALLY WEIGHT, AND AN AUDIT READ
 * IT AS WEIGHT.** Two hundred names in `src/kernel/index.ts` had no importer,
 * which sounds like two hundred modules' worth of dead loading and is not: a
 * barrel's re-exports evaluate with the barrel, so what a name costs is the
 * module behind it — and almost every one of those names sits beside a name
 * that IS imported, in a module the entry pulls in regardless.
 *
 * ⚠️ **THIS SAID THE COST "MEASURED" WAS TWO MODULES, `core/cardStore` AND
 * `core/formats`, AND NEITHER WAS A COST.** Their clauses named nothing any
 * importer asked for, and both modules still load with the entry anyway —
 * `core/services.ts` imports `cardStore` and `core/bookFolder.ts` imports
 * `formats`. Dropping the clauses shrank the API; it saved no load.
 *
 * WHAT THIS HOLDS IS THE NAMES. A value clause none of whose names anything
 * outside the entry imports is a finding on the day it lands, whether or not
 * another module here loads the one behind it. It does not walk the module
 * graph, so it says nothing about loading — and the rest of the surface is left
 * alone, because a declared contract is not dead weight.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = 'src/kernel/index.ts'
const MANIFEST = 'capabilities.manifest.json'

/**
 * WHAT CUTTING A CAPABILITY LEAVES WITH NO IMPORTER, BY THE ID CUT.
 *
 * Each of these is a kernel module the kernel does not need through its entry
 * and one capability does, so the deletion proof orphans its clause by
 * construction — and the proof forbids touching a kernel file, so the clause
 * stays. Anything else orphaned by a cut is a finding, cut or no cut.
 */
const ORPHANED_BY_A_CUT = Object.freeze({
  circle: ['./core/coverFacts'],
  passages: ['./ui/reader/bookScripts', './ui/reader/passageText'],
  voices: ['./ui/reader/clipKey'],
})

/** The clauses that load a module for names `used` does not hold. */
const orphansIn = (byModule, used) =>
  [...byModule]
    .filter(([, held]) => held.value && !held.names.some((one) => used.has(one)))
    .map(([from]) => from)

/** The orphans a cut of `cut` does not explain; with no cut, all of them. */
const unexplained = (orphans, cut) => orphans.filter((one) => !(ORPHANED_BY_A_CUT[cut] ?? []).includes(one))

/** Every `export { … } from '…'` clause in the entry, by the module it names. */
function clausesOf(text) {
  const byModule = new Map()
  for (const found of text.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']*)'/g)) {
    const names = found[2]
      .split(',')
      .map((one) => one.trim().replace(/^type\s+/, ''))
      .filter(Boolean)
      /* `X as Y` is published as `Y`, which is the name an importer writes. */
      .map((one) => one.split(/\s+as\s+/).pop().trim())
    const held = byModule.get(found[3]) ?? { names: [], value: false }
    held.names.push(...names)
    /* A `export type { … }` clause is erased by the compiler and loads
       nothing; only a value clause can cost a module. */
    held.value ||= !found[1]
    byModule.set(found[3], held)
  }
  return byModule
}

function sourcesUnder(dir, into = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourcesUnder(path, into)
    else if (/\.(ts|tsx|mts|mjs)$/.test(path)) into.push(path)
  }
  return into
}

/** Every name anything imports — or re-exports — THROUGH the kernel entry. */
function importedThroughTheEntry(files) {
  const used = new Set()
  for (const file of files) {
    if (file.endsWith(ENTRY)) continue
    const text = readFileSync(file, 'utf8')
    for (const found of text.matchAll(/(?:import|export)\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*'([^']*)'/g)) {
      const from = found[2]
      /* The entry, however it is spelled from where the file sits. A deeper
         path into `kernel/` is a different module and `kernel-public-entry-only`
         refuses it anyway. */
      if (!/(^|\/)kernel$/.test(from) && !/kernel\/index$/.test(from)) continue
      for (const part of found[1].split(',')) {
        const one = part.trim().replace(/^type\s+/, '')
        /* `X as Y` is IMPORTED as `X`, which is the published name. */
        if (one) used.add(one.split(/\s+as\s+/)[0].trim())
      }
    }
  }
  return used
}

describe("the kernel's public entry", () => {
  it('re-exports no module that nothing imports a name from', () => {
    const text = readFileSync(join(ROOT, ENTRY), 'utf8')
    const byModule = clausesOf(text)
    /* NON-VACUOUS: a parse that found nothing would pass silently, which is
       the failure this whole case exists to make loud. */
    expect(byModule.size).toBeGreaterThan(40)

    const files = ['src', 'scripts', 'tests'].flatMap((dir) => sourcesUnder(join(ROOT, dir)))
    expect(files.length).toBeGreaterThan(500)
    const used = importedThroughTheEntry(files)
    /* NON-VACUOUS the other way: names really are being found as imported, so
       an empty set cannot make every module look dead. */
    expect(used.size).toBeGreaterThan(100)

    /* ⚠️ **THE DELETION PROOF ORPHANS WHAT `ORPHANED_BY_A_CUT` LISTS, AND ONLY
       THAT IS EXCUSED.** `PAPER_VERIFY_WITHOUT` is set only by `verify:without`,
       which names the id it cut; on the real tree nothing is excused. */
    expect(
      unexplained(orphansIn(byModule, used), process.env[DELETED_ENV]),
      'the entry loads these for names nothing imports through it — either drop the clause or import from the module directly inside the kernel',
    ).toEqual([])
  })

  it('lists exactly what cutting each capability would orphan', (context) => {
    /* The proof runs on a copy and only for the id it is handed, so a new orphan
       is caught here, on the real tree, for every id. A copy has already lost
       a capability and the case above holds it to its own row. */
    const cut = process.env[DELETED_ENV]
    if (cut !== undefined) return context.skip(`${cut} was cut from this copy`)

    const byModule = clausesOf(readFileSync(join(ROOT, ENTRY), 'utf8'))
    const files = ['src', 'scripts', 'tests'].flatMap((dir) => sourcesUnder(join(ROOT, dir)))
    const { capabilities } = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'))
    /* An id another entry requires cannot be cut; `capability:remove` refuses. */
    const cuttable = capabilities.filter(({ id }) => !capabilities.some((one) => one.requires?.includes(id)))
    expect(cuttable.length).toBeGreaterThan(3)

    for (const { id, ts } of cuttable) {
      const home = join(ROOT, 'src', 'capabilities', ts) + sep
      const orphans = orphansIn(byModule, importedThroughTheEntry(files.filter((file) => !file.startsWith(home))))
      expect(orphans.sort(), `cutting ${id}`).toEqual([...(ORPHANED_BY_A_CUT[id] ?? [])].sort())
    }
  })

  it('excuses an orphan only for the capability whose cut it is listed under', () => {
    expect(Object.keys(ORPHANED_BY_A_CUT).length).toBeGreaterThan(0)
    expect(unexplained(['./core/coverFacts'], 'circle')).toEqual([])
    expect(unexplained(['./core/coverFacts'], 'voices')).toEqual(['./core/coverFacts'])
    expect(unexplained(['./core/coverFacts'], undefined)).toEqual(['./core/coverFacts'])
    expect(unexplained(['./core/planted'], 'circle')).toEqual(['./core/planted'])
  })
})

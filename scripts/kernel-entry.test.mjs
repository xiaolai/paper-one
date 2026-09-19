import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
  it('re-exports no module that nothing imports a name from', (context) => {
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

    const loadedForNothing = [...byModule]
      .filter(([, held]) => held.value && !held.names.some((one) => used.has(one)))
      .map(([from]) => from)
    /* ⚠️ **THE DELETION PROOF MAKES THIS FIRE BY CONSTRUCTION.** Cutting a
       capability deletes the only importer of the contract the kernel declares
       for it — `./core/circle/*` for `circle` — and the proof forbids touching
       a kernel file, so the clause stays with no importer. Found
       2026-09-15 running the proof on a clean tree; it failed on `main` too.
       `PAPER_VERIFY_WITHOUT` is set only by `verify:without`, which names the
       id it cut, and on the real tree this is a hard assertion — the same rule
       `check-third-party-notices.test.mjs` follows for the crates of a cut. */
    const cut = process.env[DELETED_ENV]
    if (cut !== undefined && loadedForNothing.length > 0) {
      return context.skip(`${cut} was cut from this copy, and the kernel keeps what it declared for it (${loadedForNothing.join(', ')}), because the proof touches no kernel file`)
    }
    expect(
      loadedForNothing,
      'the entry loads these for names nothing imports through it — either drop the clause or import from the module directly inside the kernel',
    ).toEqual([])
  })
})

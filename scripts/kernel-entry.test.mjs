import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE KERNEL'S PUBLIC ENTRY CARRIES NO MODULE IT LOADS FOR NOTHING.
 *
 * ⚠️ **AN EXPORT NOBODY IMPORTS IS NOT AUTOMATICALLY WEIGHT, AND AN AUDIT READ
 * IT AS WEIGHT.** Two hundred names in `src/kernel/index.ts` had no importer,
 * which sounds like two hundred modules' worth of dead loading and is not: a
 * barrel's re-exports evaluate with the barrel, so what a name costs is the
 * module behind it — and almost every one of those names sits beside a name
 * that IS imported, in a module the entry pulls in regardless. Measured, the
 * cost was two modules, `core/cardStore` and `core/formats`, each re-exported
 * only for names nothing outside the kernel ever asked for. Both are gone.
 *
 * This is what keeps the distinction rather than the sentence in that file's
 * header: a clause added for a module nothing else here loads is a finding on
 * the day it lands, and the rest of the surface is left alone, because a
 * declared contract is not dead weight.
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

    const loadedForNothing = [...byModule]
      .filter(([, held]) => held.value && !held.names.some((one) => used.has(one)))
      .map(([from]) => from)
    expect(
      loadedForNothing,
      'the entry loads these for names nothing imports through it — either drop the clause or import from the module directly inside the kernel',
    ).toEqual([])
  })
})

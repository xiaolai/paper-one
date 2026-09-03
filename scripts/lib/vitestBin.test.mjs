import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { binEntryOf, vitestBin } from './vitestBin.mjs'

/**
 * The resolution two gates depend on, and the one that broke on an upgrade.
 *
 * `check-test-ledger` and `check-test-projects` both spawn Vitest to ask what
 * it would collect. Both resolved `vitest/vitest.mjs` directly; vitest 4
 * removed that subpath from its `exports` map, and the throw took sixteen tests
 * down across the two files with one error — reported by both gates as
 * *"vitest could not answer"*, which is the right behaviour and looks exactly
 * like a broken config.
 */
describe('binEntryOf', () => {
  it('reads the vitest entry out of the object form', () => {
    expect(binEntryOf({ bin: { vitest: './vitest.mjs' } })).toBe('./vitest.mjs')
  })

  it('reads the string shorthand, which npm also allows', () => {
    /* A package may switch between `"bin": "./cli.js"` and
       `"bin": { "name": "./cli.js" }` without calling it a breaking change —
       which is the same class of quiet move that broke the callers here. */
    expect(binEntryOf({ bin: './cli.mjs' })).toBe('./cli.mjs')
  })

  it('refuses a manifest that declares no bin, rather than returning undefined', () => {
    /* ⚠️ Returning `undefined` would make `path.join` produce the package
       DIRECTORY, which `spawnSync` would then run as if it were a program. The
       failure would arrive as an opaque spawn error somewhere else entirely. */
    expect(() => binEntryOf({})).toThrow(/declares no `bin`/u)
    expect(() => binEntryOf({ bin: {} })).toThrow(/declares no `bin`/u)
    expect(() => binEntryOf(undefined)).toThrow(/declares no `bin`/u)
  })
})

describe('vitestBin', () => {
  it('resolves to a file that is really there', () => {
    /* ⚠️ **THE KNOWN POSITIVE.** A resolver that answered a plausible-looking
       path nobody checked is what the old code was: `vitest/vitest.mjs` read
       correctly and resolved to nothing on vitest 4. Asserting the file EXISTS
       is what tells "resolved" from "composed a string". */
    const bin = vitestBin()
    expect(existsSync(bin)).toBe(true)
    expect(bin.endsWith('.mjs')).toBe(true)
  })

  it('goes through the package manifest, which every package must export', () => {
    /* `./package.json` is exported by every package — Node requires it — which
       is why this survives an `exports` map that drops the bin's own subpath. */
    expect(vitestBin()).toContain('/vitest/')
  })
})

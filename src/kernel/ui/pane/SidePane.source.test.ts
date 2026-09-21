import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The rail's exhaustiveness check (`RailCoversEveryPane`) catches a MISSING
 * pane and cannot catch a DUPLICATE one: a second row for an id compiles, then
 * renders two buttons under one React key. A pin on the source, on the
 * `pageTurn.test.ts` precedent, because the entries are a module constant
 * nothing exports.
 *
 * ⚠️ **IN ITS OWN FILE, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.** The
 * mutation gate leaves a test that READS a subject's source out of that
 * subject's run — Stryker rewrites the very file such a test reads, so it would
 * fail the dry run. Beside `SidePane.test.tsx`'s twenty behavioural cases, this
 * one pin therefore cost every one of them: the pane was mutated against
 * nothing, and eighteen of its mutants came back as reached by no test at all.
 * Read the source in a file that asserts nothing else, and the behaviour tests
 * next door keep counting.
 */
describe('the rail, read as source', () => {
  it('lists every kernel pane once — a duplicated row would draw two buttons under one key', () => {
    const source = readFileSync(fileURLToPath(new URL('./SidePane.tsx', import.meta.url)), 'utf8')
    const block = source.slice(source.indexOf('const RAIL_ENTRIES'), source.indexOf('as const satisfies'))
    const ids = [...block.matchAll(/id: '([a-z]+)'/gu)].map((m) => m[1])
    expect(ids.length, 'the pin found the rail').toBeGreaterThan(3)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

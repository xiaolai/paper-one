import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PANE_SHORTCUTS } from '../panes'

/**
 * The two things about the rail that only its SOURCE can answer.
 *
 * ⚠️ **IN A FILE THAT ASSERTS NOTHING ELSE, AND THAT IS THE WHOLE REASON IT
 * EXISTS.** The mutation gate leaves a test that READS a subject's source out of
 * that subject's run — Stryker rewrites the very file such a test reads, so it
 * would fail the dry run — and it leaves out the WHOLE FILE, not the one case.
 * Both pins below used to sit beside dozens of behavioural cases, which cost
 * `SidePane.tsx` every one of them: the pane was mutated against what was left,
 * and mutants came back reached by no test at all.
 *
 * It is worse than that, and it is why this file is on `main` rather than on the
 * branch that wanted it. An excluded reader is excluded on BOTH sides of the
 * merge-base comparison, so the gate refuses to judge the subject at all once
 * that reader has CHANGED — `reading-changed`, which authorises nothing. A pin
 * living in a busy test file therefore makes its subject unmeasurable whenever
 * anybody edits that file for an unrelated reason. `reanchor.source.test.ts`
 * (`64c47d0b`) is the same fix one file over.
 *
 * So: a file per subject read, holding source pins and nothing else. Behaviour
 * goes next door, where it keeps counting.
 */
describe('the rail, read as source', () => {
  const source = () => readFileSync(fileURLToPath(new URL('./SidePane.tsx', import.meta.url)), 'utf8')

  it('lists every kernel pane once — a duplicated row would draw two buttons under one key', () => {
    /* The rail's exhaustiveness check (`RailCoversEveryPane`) catches a MISSING
       pane and cannot catch a DUPLICATE one: a second row for an id compiles,
       then renders two buttons under one React key. A pin on the source, on the
       `pageTurn.test.ts` precedent, because the entries are a module constant
       nothing exports. */
    const text = source()
    const block = text.slice(text.indexOf('const RAIL_ENTRIES'), text.indexOf('as const satisfies'))
    const ids = [...block.matchAll(/id: '([a-z]+)'/gu)].map((m) => m[1])
    expect(ids.length, 'the pin found the rail').toBeGreaterThan(3)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('binds every digit to a panel that actually renders', () => {
    /* The invariant, and the reason ⌘4 was unbound until Cards existed: a
     * shortcut pointing at a panel nothing renders is a keystroke that gets
     * swallowed to do nothing, which is indistinguishable from a broken key.
     *
     * Checked against the RENDERER, not against `buildCommands`. Both derive
     * from the same PANES table, so asking one about the other could only ever
     * agree with itself — the missing SidePane branch this is meant to catch
     * would have passed. Reading the source is the same technique the reader's
     * layout guard uses, for the same reason: the two things that must agree
     * live in different files, and nothing else makes them fail together. */
    const text = source()
    for (const shortcut of PANE_SHORTCUTS) {
      expect(text).toContain(`pane === '${shortcut.pane}'`)
    }
  })
})

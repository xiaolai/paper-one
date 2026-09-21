/**
 * `scripts/surfaces.mjs` finds what the app actually declares.
 *
 * ⚠️ **THE COUNTS BELOW ARE ASSERTIONS, NOT DOCUMENTATION.** A collector whose
 * only test is "it returned something" passes on the day it is written and
 * passes forever afterwards, including the day it silently stops reading half
 * the tree. Every number here was measured on 2026-09-10 and is pinned so that
 * a registry changing shape is a red test rather than a quiet drift — which is
 * the whole failure this file exists to end.
 *
 * ⚠️ **AND THE READ HALF IS TESTED AGAINST KNOWN POSITIVES BEFORE IT IS
 * BELIEVED.** `check-browser-safe.mjs` shipped two confident wrong answers —
 * counting a package named inside a doc comment, and a newline-forbidding regex
 * that missed every multi-line import and called the Tauri binding clean. A
 * detector that finds nothing looks exactly like a clean result, so
 * `contributionsIn` is shown a source it must find things in, a source it must
 * find NOTHING in, and a source that would fool the obvious flat regex.
 *
 * The evaluated half runs `surfaces.mjs` as a CHILD PROCESS rather than
 * importing it: that module registers a loader hook at import time, and
 * installing a resolver into the test runtime to check a script is a larger
 * change to the thing under test than the test is worth.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONTRIBUTION_SEAMS, contributionsIn, namesOf } from './lib/surfaces.mjs'

const SCRIPT = fileURLToPath(new URL('./surfaces.mjs', import.meta.url))
const REPO = fileURLToPath(new URL('..', import.meta.url))

const run = (...args) => execFileSync('node', [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' })
const surfaces = JSON.parse(run())

describe('the registries it evaluates', () => {
  /* Exact lists, not counts, wherever the list is short enough to read. A count
   * says a member changed; a list says WHICH, which is the difference between a
   * red test somebody can act on and one they re-run. */
  it('reads the fifteen reading-typography fields', () => {
    expect(surfaces.readingStyle).toEqual([
      'separation', 'flourish', 'headingScale', 'blockquote', 'codeFace', 'codeWrap',
      'figureWidth', 'figureFrame', 'figureScalesWithText', 'figureHeight',
      'wideTables', 'noteSize', 'cjkSpacing', 'minimumSize', 'fidelity',
    ])
  })

  it('reads the seven kernel panes and the one that is unfinished', () => {
    expect(surfaces.panes).toEqual(['toc', 'marginalia', 'cards', 'search', 'library', 'settings', 'dev'])
    expect(surfaces.unfinishedPanes).toEqual(['cards'])
  })

  it('reads three tints, three mark styles, and only two offered to the reader', () => {
    expect(surfaces.markTints).toEqual(['yellow', 'green', 'purple'])
    expect(surfaces.markStyles).toEqual(['fill', 'underline', 'wave'])
    /* `wave` is never offered to a reader — the one relationship here that is a
     * product decision rather than a count. It was reserved for the deleted
     * companion's marks; what keeps it out now is that a squiggle under prose
     * reads as an error, which `marks.ts` sets out. */
    expect(surfaces.readerStyles).toEqual(['fill', 'underline'])
    expect(surfaces.markStyles).toContain('wave')
    expect(surfaces.readerStyles).not.toContain('wave')
  })

  it('reads five card kinds and five themes', () => {
    expect(surfaces.cardKinds).toEqual(['Idea', 'Claim', 'Recall', 'Synthesis', 'Excerpt'])
    expect(surfaces.themes).toEqual(['paper', 'slate', 'sepia', 'sage', 'night'])
  })

  it('reads three bundled faces, and Crimson Pro is not one of them', () => {
    expect(surfaces.bundledFaces).toEqual(['literata', 'instrument', 'plex'])
    /* Bundled and OFFERED are separate lists: `main.tsx` loads four families and
     * sets the app's own chrome in the fourth. A face that is loaded and not
     * offered is deliberate; a face that is offered and not loaded falls
     * through to Georgia and reports nothing. */
    expect(surfaces.allFaces).not.toContain('crimson')
    expect(surfaces.allFaces).toHaveLength(15)
  })

  it('reads the counts this phase measured', () => {
    /* 18 when `kernel.lookUpLanguage` went with Look up and the rest of the AI
       features; 20 since read aloud stopped taking whatever voice the platform
       handed it — `readingVoice` and `readingRate` (2026-09-20); 22 since the
       reader could set the silence after a sentence and after a paragraph —
       `sentenceGapMs` and `paragraphGapMs` (2026-09-20); 23 since a listener
       could ask for footnote BODIES to be read — `readingNotesAloud`
       (2026-09-21), which EPUB Media Overlays calls skippable content and this
       app had been dropping with no way to ask for it.

       ⚠️ **THE NAMES ARE ASSERTED BESIDE THE COUNT, BECAUSE A COUNT ALONE CANNOT
       SAY WHICH.** Two preferences added and two removed leaves this number
       unchanged, and the point of the row is that a change to the persisted
       surface is a deliberate act with a note beside it. */
    expect(surfaces.kernelSettings).toHaveLength(23)
    expect(surfaces.kernelSettings).not.toContain('lookUpLanguage')
    expect(surfaces.kernelSettings).toContain('readingVoice')
    expect(surfaces.kernelSettings).toContain('readingRate')
    expect(surfaces.kernelSettings).toContain('sentenceGapMs')
    expect(surfaces.kernelSettings).toContain('paragraphGapMs')
    expect(surfaces.kernelSettings).toContain('readingNotesAloud')
    expect(surfaces.services).toHaveLength(31)
    expect(surfaces.readingSteps).toHaveLength(14)
    expect(surfaces.spacingAxes).toEqual(['letter', 'word', 'line', 'paragraph'])
    expect(surfaces.acceptFormats).toEqual(['.epub', '.pdf', '.mobi', '.azw3', '.cbz', '.fb2', '.fbz'])
  })

  it('reads the reading steps as 15px through 28px', () => {
    expect(surfaces.readingSteps[0]).toBe(15)
    expect(surfaces.readingSteps.at(-1)).toBe(28)
  })

  it('names every service as <noun>.<verb>', () => {
    for (const name of surfaces.services) expect(name).toMatch(/^[a-z]+\.[a-zA-Z]+$/u)
    expect(new Set(surfaces.services).size).toBe(surfaces.services.length)
  })
})

describe('the capability contributions it reads', () => {
  it('covers every capability the manifest declares', () => {
    const manifest = JSON.parse(execFileSync('cat', ['capabilities.manifest.json'], { cwd: REPO, encoding: 'utf8' }))
    const declared = manifest.capabilities.map((c) => c.ts ?? c.id).sort()
    expect(Object.keys(surfaces.capabilities).sort()).toEqual(declared)
  })

  /* ⚠️ **NAMED CAPABILITIES, AND ONE OF THEM GETS DELETED UNDER THIS TEST.**
     `pnpm verify:without` copies the tree, removes a capability and runs the
     suite — and it now DERIVES which one, so `circle` and `public` are both
     candidates. Asserting on a fixed pair made this fail in the copy for a
     defect in neither the surfaces reader nor the removal.

     So each expectation is skipped when its capability is absent, and the
     COUNT is asserted: on a real tree both run, in a copy one does, and a
     reader who deletes the last of them gets a failure rather than a green
     test that checks nothing. */
  it('finds the seams each capability actually contributes', () => {
    const expected = {
      circle: {
        panes: ['circle:book'],
        screens: ['circle:circle'],
        markControls: ['circle:share'],
        overlays: ['circle:shared'],
      },
      public: { panes: ['public:book'], markControls: ['public:publish'] },
    }
    let asserted = 0
    for (const [id, seams] of Object.entries(expected)) {
      const found = surfaces.capabilities[id]
      if (found === undefined) continue
      for (const [seam, ids] of Object.entries(seams)) {
        expect(found[seam], `${id} contributes different ${seam}`).toEqual(ids)
      }
      asserted += 1
    }
    expect(asserted, 'every capability this case knows about is gone, so it asserts nothing').toBeGreaterThan(0)
  })

  it('gives a capability that contributes nothing an empty object, not a crash', () => {
    for (const [id, seams] of Object.entries(surfaces.capabilities)) {
      expect(seams, `${id} should be an object of seams`).toBeTypeOf('object')
      for (const [seam, ids] of Object.entries(seams)) {
        expect(CONTRIBUTION_SEAMS, `${id} contributed an unknown seam ${seam}`).toContain(seam)
        expect(Array.isArray(ids)).toBe(true)
      }
    }
  })
})

describe('contributionsIn, against known positives', () => {
  it('finds ids at the top level of a seam', () => {
    const source = ['export const cap = {', "  panes: [", "    { id: 'x:one' },", "    { id: 'x:two' },", '  ],', '}'].join('\n')
    expect(contributionsIn(source)).toEqual({ panes: ['x:one', 'x:two'] })
  })

  /* ⚠️ THE CASE THE OBVIOUS IMPLEMENTATION GETS WRONG, AND THE FIRST VERSION OF
   * THIS TEST GOT WRONG TOO. It was named "does not count an id nested inside a
   * render" and then asserted `['x:real', 'not-a-pane', 'nor-this']` — it pinned
   * the defect under a name claiming the opposite, so a correct parser would
   * have failed it. Two independent audits flagged it on 2026-09-11. A test
   * whose title disagrees with its assertion is worse than no test: it defends
   * the bug. */
  it('does not count an id nested inside a render', () => {
    const source = [
      'export const cap = {',
      '  panes: [',
      "    { id: 'x:real', render: () => createElement(P, { id: 'not-a-pane', rows: [{ id: 'nor-this' }] }) },",
      '  ],',
      '  markControls: [',
      "    { id: 'x:control' },",
      '  ],',
      '}',
    ].join('\n')
    const got = contributionsIn(source)
    expect(got.panes).toEqual(['x:real'])
    expect(got.markControls).toEqual(['x:control'])
  })

  /* Brackets inside a LABEL are text, not syntax. A capability id cannot carry
   * one; the label beside it can carry anything. */
  it('is not confused by a bracket inside a string', () => {
    const closing = ['export const cap = {', '  panes: [', "    { label: ']', id: 'x:one' },", "    { id: 'x:two' },", '  ],', '}'].join('\n')
    expect(contributionsIn(closing).panes).toEqual(['x:one', 'x:two'])
    const opening = ['export const cap = {', '  panes: [', "    { label: '[', id: 'x:one' },", '  ],', '}'].join('\n')
    expect(contributionsIn(opening).panes).toEqual(['x:one'])
  })

  it('ignores an id that is commented out', () => {
    const source = [
      'export const cap = {',
      '  panes: [',
      "    // { id: 'x:removed' },",
      "    /* { id: 'x:also-removed' } */",
      "    { id: 'x:live' },",
      '  ],',
      '}',
    ].join('\n')
    expect(contributionsIn(source).panes).toEqual(['x:live'])
  })

  /* ⚠️ THE FOUR CASES A HAND-ROLLED SCANNER CANNOT GET RIGHT, each reproduced
   * by an audit against two successive attempts before the parser was replaced
   * with TypeScript's own. A regex literal, a nested template substitution and
   * an apostrophe inside a regex each threw a character scanner's depth count
   * off, and a shape filter added to contain that failed both ways — it let a
   * nested `book:moby` through and silently dropped a legitimate `x:reader2`. */
  it.each([
    ['a regex literal containing braces', "{ id: 'x:real', render: () => /\\}/.test(t) ? h('div', { id: 'book:moby' }) : /\\{/.test(t) }"],
    ['a nested template substitution', "{ id: 'x:real', label: `o ${`}`}`, render: () => h('div', { id: 'book:moby' }) }"],
    ['an apostrophe inside a regex', "{ id: 'x:real', render: () => /'/.test(t) ? h(P, { id: 'book:moby' }) : null }"],
  ])('is not confused by %s', (_, element) => {
    expect(contributionsIn(`export const cap = {\n  panes: [\n    ${element},\n  ],\n}`).panes).toEqual(['x:real'])
  })

  /* `PaneId` is `${string}:${string}`, so digits are legal in a contribution
   * id. The shape filter that briefly guarded the scanner dropped this one
   * without a word, which is the quiet failure the AST removes entirely. */
  it('keeps an id containing digits or hyphens', () => {
    const source = "export const cap = {\n  panes: [{ id: 'x:reader2' }, { id: 'x:side-note' }],\n}"
    expect(contributionsIn(source).panes).toEqual(['x:reader2', 'x:side-note'])
  })

  /* ⚠️ A SEAM NAME INSIDE A CONTRIBUTION IS NOT THE CAPABILITY'S SEAM. A pane
   * carries `screens: ['reader']` meaning *this pane appears on the reader
   * screen*; the first AST version read that as the capability contributing a
   * `screens` seam, because it accepted any literal that could reach an export
   * rather than the export's own initializer. */
  it('does not mistake a seam name inside a contribution for the capability own seam', () => {
    const source = [
      'export const cap = {',
      '  panes: [',
      "    { id: 'x:book', screens: ['reader'] },",
      '  ],',
      '}',
    ].join('\n')
    const got = contributionsIn(source)
    expect(got.panes).toEqual(['x:book'])
    expect(got).not.toHaveProperty('screens')
  })

  /* ⚠️ THE REGRESSION THE ROUND 3 VERIFICATION CAUGHT. Parsing as TSX made a
   * generic arrow's `<T>` look like a JSX tag, so valid TypeScript reported
   * parse diagnostics and was refused. Capability inputs are `.ts`. */
  it('reads a generic arrow, which TSX mode would reject', () => {
    const source = 'const identity = <T>(value: T) => value\nexport const cap = {\n  panes: [{ id: \'x:real\' }],\n}'
    expect(contributionsIn(source).panes).toEqual(['x:real'])
  })

  /* The shapes an AST walk meets that a regex never did. Each of these is a
   * branch the parser takes and nothing else reaches. */
  it('ignores a spread and a computed property name', () => {
    const source = "export const cap = {\n  ...base,\n  panes: [{ ...shared, [KEY]: 1, id: 'x:real' }],\n}"
    expect(contributionsIn(source).panes).toEqual(['x:real'])
  })

  it('reads a quoted or templated property name', () => {
    const source = "export const cap = {\n  'panes': [{ \"id\": 'x:quoted' }],\n}"
    expect(contributionsIn(source).panes).toEqual(['x:quoted'])
  })

  it('ignores a seam whose value is not an array literal', () => {
    /* `panes: SHARED_PANES` names a list this reader cannot see into. It is
       omitted rather than guessed at — the same rule as a command factory. */
    expect(contributionsIn('export const cap = {\n  panes: SHARED_PANES,\n}')).toEqual({})
  })

  it('ignores an object literal that is not an export default or const', () => {
    expect(contributionsIn("export default {\n  panes: [{ id: 'x:real' }],\n}")).toEqual({})
    expect(contributionsIn("const cap = {\n  panes: [{ id: 'x:real' }],\n}")).toEqual({})
  })

  it('refuses an id it cannot read rather than skipping it', () => {
    const source = "export const cap = {\n  panes: [{ id: NAMES.pane }],\n}"
    const cause = (() => {
      try {
        contributionsIn(source)
        return null
      } catch (e) {
        return e
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toMatch(/non-literal id/u)
  })

  it('reads a double-quoted id and an array on one line', () => {
    expect(contributionsIn('export const cap = {\n  panes: [{ id: "x:one" }, { id: "x:two" }],\n}').panes).toEqual([
      'x:one',
      'x:two',
    ])
  })

  /* Indentation is not the signal. The first version keyed on exactly two
   * spaces, so any other formatting returned `{}` — indistinguishable from a
   * capability that contributes nothing. */
  it('does not depend on how the source is indented', () => {
    const source = ['export const cap = {', '    panes: [', "        { id: 'x:one' },", '    ],', '}'].join('\n')
    expect(contributionsIn(source).panes).toEqual(['x:one'])
  })

  it('does not take a seam from an object nested inside the capability', () => {
    const source = [
      'export const cap = {',
      '  wrapper: {',
      "    panes: [{ id: 'not:mine' }],",
      '  },',
      "  markControls: [{ id: 'x:real' }],",
      '}',
    ].join('\n')
    const got = contributionsIn(source)
    expect(got.markControls).toEqual(['x:real'])
    expect(got.panes ?? []).not.toContain('not:mine')
  })

  it('reports a present-but-empty seam as an empty array, and omits an absent one', () => {
    const source = ['export const cap = {', '  panes: [', '  ],', '}'].join('\n')
    const got = contributionsIn(source)
    expect(got.panes).toEqual([])
    expect(got).not.toHaveProperty('screens')
  })

  /* KNOWN NEGATIVE. If this returned ids, the reader would be matching
   * something other than a top-level seam and every count above would be
   * meaningless. */
  it('finds nothing in a module that contributes nothing', () => {
    expect(contributionsIn('export const cap = { id: "x", requires: [] }\n')).toEqual({})
  })

  /* TypeScript's parser RECOVERS from a truncated file and returns a tree, so
     without the diagnostics check this would quietly report a short list. */
  it('refuses a truncated source rather than reporting a short list', () => {
    const source = ['export const cap = {', '  panes: [', "    { id: 'x:one' },"].join('\n')
    const cause = (() => { try { contributionsIn(source); return null } catch (e) { return e } })()
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toMatch(/does not parse/u)
  })
})

describe('namesOf', () => {
  it('carries every reading-typography field through', () => {
    const names = namesOf(surfaces)
    for (const field of surfaces.readingStyle) expect(names, `${field} should reach the name set`).toContain(field)
  })

  /* A COUNT THAT ONLY EVER GOES UP SILENTLY IS NOT AN ASSERTION. This proves
   * the derivation propagates: a field that did not exist before appears
   * without anybody editing a list. */
  it('picks up a field that was not there before', () => {
    const before = namesOf(surfaces)
    const after = namesOf({ ...surfaces, readingStyle: [...surfaces.readingStyle, 'inventedForThisTest'] })
    expect(before).not.toContain('inventedForThisTest')
    expect(after).toContain('inventedForThisTest')
    expect(after).toHaveLength(before.length + 1)
  })

  it('refuses a surfaces object with a field it has never been told about', () => {
    /* The guard that stops a new registry falling out of coverage silently. */
    const cause = (() => {
      try {
        namesOf({ ...surfaces, inventedRegistry: ['x'] })
        return null
      } catch (e) {
        return e
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toMatch(/neither included in nor excluded/u)
  })

  it('leaves out the fields that would make a coincidence pass', () => {
    const names = namesOf(surfaces)
    /* `readingSteps` and `paneShortcuts` are numbers and glyph strings; a ledger
     * containing "15" proves nothing about whether anybody described the size
     * ladder. */
    expect(names).not.toContain('15')
    expect(names).not.toContain('⌘1 toc')
  })

  it('is sorted and free of duplicates', () => {
    const names = namesOf(surfaces)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
  })
})

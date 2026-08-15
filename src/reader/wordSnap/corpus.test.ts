import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CORPUS, type Tag } from './corpus'
import { snapWordRange } from './snapWordRange'
import { scan } from './sourceScan.testkit'

/**
 * The row count, pinned by hand.
 *
 * Not derived, not computed — a literal, updated deliberately whenever a row is
 * added. `it.each([])` passes silently and reports zero tests, which in a
 * summary looks exactly like a healthy run; a corpus quietly emptied by a bad
 * merge, a stray `.filter`, or a `.slice` that crept into the export would
 * therefore be invisible. This number is the only thing that can tell the
 * difference between "every row passed" and "there were no rows".
 */
const PINNED_ROWS = 51

/**
 * The categories the corpus must cover, stated HERE rather than in `corpus.ts`.
 *
 * If the requirement lived beside the data, deleting the last CJK row and its
 * tag from the required list would be one edit and the suite would stay green.
 * From here, the corpus cannot weaken its own coverage requirement.
 */
const REQUIRED_TAGS: readonly Tag[] = [
  'latin',
  'numeric',
  'hyphen',
  'apostrophe',
  'soft-hyphen',
  'sentinel',
  'cjk',
  'thai',
  'mixed',
  'punctuation',
  'emoji',
]

/** A `{index, offset}` pair, checked as data rather than as a type: these
 *  guards exist to catch a row that TypeScript already believes is fine. */
function isEdge(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const edge = value as Record<string, unknown>
  return Number.isInteger(edge['index']) && Number.isInteger(edge['offset'])
}

function isSnap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const snap = value as Record<string, unknown>
  return isEdge(snap['start']) && isEdge(snap['end'])
}

/**
 * Everything wrong with one row, named.
 *
 * Deliberately typed `unknown`: the point of this validator is to check at run
 * time what the compiler has already been told, so a row arriving from a merge
 * conflict, a hand edit, or a generator cannot be waved through by its
 * declared type. Comparing a typed field against `undefined` would not even
 * compile — TypeScript calls the comparison unintentional — which is exactly
 * why the data is read back as `unknown` here.
 */
function faults(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return ['is not an object']
  const row = value as Record<string, unknown>
  const out: string[] = []
  if (typeof row['id'] !== 'string' || row['id'] === '') out.push('id')
  if (!Array.isArray(row['tags']) || row['tags'].length === 0) out.push('tags')
  if (!Array.isArray(row['strs'])) out.push('strs')
  if (!isEdge(row['start'])) out.push('start')
  if (!isEdge(row['end'])) out.push('end')
  if (!('expected' in row) || row['expected'] === undefined) out.push('expected is missing')
  else if (row['expected'] !== 'none' && !isSnap(row['expected'])) out.push('expected is malformed')
  if (typeof row['why'] !== 'string' || row['why'].trim() === '') out.push('why')
  return out
}

describe('corpus — every row under Node ICU', () => {
  /*
   * `it.each` rather than a loop inside one `it`, so a single divergence names
   * its row and the other fifty still run. The corpus is the regression net for
   * the whole snapping policy; a net that stops reporting after the first hole
   * is not one.
   */
  it.each([...CORPUS])('$id', (row) => {
    const result = snapWordRange(row.strs, row.start, row.end, {})

    if (row.expected === 'none') {
      expect(result).toBeNull()
      return
    }
    expect(result).toEqual(row.expected)
  })
})

describe('corpus — the guards that make a green run mean something', () => {
  it('is non-empty and holds exactly the pinned number of rows', () => {
    expect(CORPUS.length).toBeGreaterThan(0)
    expect(CORPUS).toHaveLength(PINNED_ROWS)
  })

  /* The other half of the count guard: a copy-pasted row shadows its original
   * in the report while the total still matches. */
  it('gives every row a unique id', () => {
    const counts = new Map<string, number>()
    for (const row of CORPUS) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)

    expect([...counts].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([])
    expect(new Set(CORPUS.map((row) => row.id)).size).toBe(CORPUS.length)
  })

  /*
   * The count above cannot see COMPOSITION: fifty-one Latin rows would satisfy
   * it. This is what stops someone deleting the Thai and CJK rows on the
   * grounds that "they all return the input unchanged, so what are they
   * testing" — those rows are the ones the two engines are most likely to
   * disagree about.
   *
   * The missing list is asserted rather than the two sets, so a failure names
   * what is absent instead of printing the whole corpus.
   */
  it('represents every required category', () => {
    const present = new Set<string>(CORPUS.flatMap((row) => [...row.tags]))

    expect(REQUIRED_TAGS.filter((tag) => !present.has(tag))).toEqual([])
  })

  /*
   * `expected` is the literal `'none'`, never `null` and never optional. `null`
   * would be indistinguishable from "nobody filled this in", and an optional
   * field makes an unfinished row a silently passing one.
   */
  it('leaves no row without an expectation', () => {
    const bad = CORPUS.map((row) => ({ id: row.id, faults: faults(row) })).filter(
      (entry) => entry.faults.length > 0,
    )

    expect(bad).toEqual([])
  })

  /* Non-vacuity for the validator itself: it must actually reject something,
   * or the assertion above passes on an empty check. */
  it('rejects a row with no expectation, so the guard above is not vacuous', () => {
    const unfinished = {
      id: 'unfinished',
      tags: ['latin'],
      strs: ['abc'],
      start: { index: 0, offset: 0 },
      end: { index: 0, offset: 3 },
      why: 'nobody filled this in',
    }

    expect(faults(unfinished)).toContain('expected is missing')
    expect(faults({ ...unfinished, expected: null })).toContain('expected is malformed')
    expect(faults({ ...unfinished, expected: 'none', why: '  ' })).toContain('why')
    expect(faults({ ...unfinished, expected: 'none' })).toEqual([])
  })
})

const SOURCE_PATH = fileURLToPath(new URL('./corpus.ts', import.meta.url))

describe('corpus.ts is plain data', () => {
  /*
   * The load-bearing property for WI-4's whole point. `scripts/word-snap-parity.mjs`
   * imports this module with nothing but Node's own type stripping — no vite, no
   * bundler, no build step — and Node's ESM resolver does not add extensions.
   * One value import of `./snapWordRange` would resolve fine under vitest and
   * fail only when someone runs the parity script, which is the moment it is
   * least welcome. A type-only import is erased before the resolver ever sees
   * it, so it costs nothing.
   */
  it('imports nothing at run time, so plain Node can load it with no build step', () => {
    const { withoutComments } = scan(readFileSync(SOURCE_PATH, 'utf8'))
    const statements = [...withoutComments.matchAll(/^[ \t]*import\b[^\n]*/gm)].map((match) =>
      match[0].trim(),
    )

    // Non-vacuity: the module does import its types, so an empty list here
    // would mean the scanner stopped seeing imports rather than that there are
    // none to see.
    expect(statements.length).toBeGreaterThan(0)
    expect(statements.filter((line) => !line.startsWith('import type'))).toEqual([])
  })

  it('holds no executable expression — the rows are literals', () => {
    const { codeOnly } = scan(readFileSync(SOURCE_PATH, 'utf8'))

    expect(codeOnly).not.toMatch(/\bfunction\b/)
    expect(codeOnly).not.toMatch(/=>/)
    expect(codeOnly).not.toMatch(/\bnew\b/)
  })
})

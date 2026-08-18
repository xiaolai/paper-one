import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CORPUS, type CorpusRow } from './corpus'
import { snapWordRange, type Edge, type SnapOptions, type SnappedRange } from './snapWordRange'
import { DOM_IDENTIFIERS, importSpecifiers, scan } from './sourceScan.testkit'

/**
 * The selected text, reconstructed from a result.
 *
 * Written independently of the module under test — a plain join and slice —
 * so it is an oracle rather than an echo. The cases below assert this text
 * where it says something a reader can check by eye; the exact offsets are
 * `corpus.test.ts`'s job, and restating them here would be two homes for one
 * measurement.
 */
function sliceFlat(strs: readonly string[], range: SnappedRange): string {
  const flat = (edge: Edge): number => strs.slice(0, edge.index).join('').length + edge.offset
  return strs.join('').slice(flat(range.start), flat(range.end))
}

/** The same call, with the `null` case turned into a failure, so the rest of a
 *  case can talk about offsets without a nullable in the way. */
function mustSnap(
  strs: readonly string[],
  start: Edge,
  end: Edge,
  opts: SnapOptions = {},
): SnappedRange {
  const result = snapWordRange(strs, start, end, opts)
  if (result === null) throw new Error(`expected a snap for ${JSON.stringify(strs)}, got null`)
  return result
}

const at = (index: number, offset: number): Edge => ({ index, offset })

/**
 * One fixture, by id.
 *
 * Every string, edge and expectation in this file comes from `corpus.ts`,
 * which is also what `scripts/word-snap-parity.mjs` runs inside the live
 * webview. A fixture written out again here would be a second copy that drifts
 * — and the drift would be invisible, because both copies would keep passing
 * their own tests while the two engines were being asked different questions.
 *
 * A missing id throws rather than skipping: renaming a corpus row must fail
 * loudly here, not quietly stop testing something.
 */
function row(id: string): CorpusRow {
  const found = CORPUS.find((entry) => entry.id === id)
  if (!found) throw new Error(`snapWordRange.test: no corpus row \`${id}\``)
  return found
}

/** The corpus row, snapped. */
function snapOf(id: string): { fixture: CorpusRow; result: SnappedRange } {
  const fixture = row(id)
  return { fixture, result: mustSnap(fixture.strs, fixture.start, fixture.end) }
}

describe('snapWordRange — expansion', () => {
  it('expands both mid-word edges outward to whole words', () => {
    const { fixture, result } = snapOf('expand-both-edges')

    expect(sliceFlat(fixture.strs, result)).toBe('quick brown')
  })

  /*
   * The single case that pins the policy. `abc` with a start edge at 2: the
   * NEAREST boundary is 3, and the rule is not "nearest" — it is "expand the
   * word you are touching", which sends the edge back to 0. An implementation
   * that snaps to the nearer boundary collapses this range to nothing.
   */
  it('sends a start edge at offset 2 of `abc` to 0, not to the nearer boundary 3', () => {
    const { fixture, result } = snapOf('expand-not-to-the-nearest-boundary')

    expect(result.start.offset).toBe(0)
    expect(result.start.offset).not.toBe(3)
    expect(sliceFlat(fixture.strs, result)).toBe('abc')
  })

  it('leaves a start edge already at a word start and an end edge already at a word end', () => {
    const { fixture, result } = snapOf('already-aligned-stays-put')

    // Asserted against the INPUT edges, which is the claim: nothing moved.
    expect(result).toEqual({ start: fixture.start, end: fixture.end })
    expect(sliceFlat(fixture.strs, result)).toBe('quick')
  })

  it('returns the whole word for a selection wholly inside one word', () => {
    const { fixture, result } = snapOf('wholly-inside-one-word')

    expect(sliceFlat(fixture.strs, result)).toBe('internationalization')
  })
})

describe('snapWordRange — trimming', () => {
  /*
   * The asymmetry IS the behaviour. A drag that begins at the end of `the`
   * means the reader did not want `the`; a symmetric "at a boundary, expand
   * outward" rule hands back `the quick brown`.
   */
  it('moves a start edge sitting exactly at a word end forward to the next word', () => {
    const { fixture, result } = snapOf('trim-start-sitting-at-a-word-end')

    expect(sliceFlat(fixture.strs, result)).toBe('quick brown')
    expect(sliceFlat(fixture.strs, result)).not.toContain('the')
  })

  /* The mirror. Applying the `start` rule to both edges fails this one. */
  it('moves an end edge sitting exactly at the next word start back to the previous word end', () => {
    const { fixture, result } = snapOf('trim-end-sitting-at-a-word-start')

    expect(sliceFlat(fixture.strs, result)).toBe('quick')
  })

  /*
   * Two rows, and two spaces rather than one: with a single-space fixture,
   * "moved to the nearest word" and "moved one character" are the same answer,
   * so the fixture could not tell them apart.
   */
  it('trims an edge inside a whitespace run inward, never outward', () => {
    const fromWhitespace = snapOf('trim-start-inside-a-whitespace-run')
    const toWhitespace = snapOf('trim-end-inside-a-whitespace-run')

    expect(sliceFlat(fromWhitespace.fixture.strs, fromWhitespace.result)).toBe('bb')
    expect(sliceFlat(toWhitespace.fixture.strs, toWhitespace.result)).toBe('aa')
  })

  /*
   * The end edge sits one character from `beta`'s end and one from `gamma`'s
   * start — a genuine tie, built on purpose. "Nearest boundary" resolves it
   * arbitrarily; trimming inward always gives up the overshoot.
   */
  it('does not swallow the next word when the end edge overshoots by one space', () => {
    const { fixture, result } = snapOf('trim-end-overshooting-by-one-space')

    expect(sliceFlat(fixture.strs, result)).toBe('alpha beta')
  })
})

describe('snapWordRange — nothing to snap', () => {
  /*
   * The two channels, side by side, which is the assertion the corpus cannot
   * make row by row. `null` tells WI-6 to leave the live selection completely
   * alone; an unchanged range tells it the selection is already correct and
   * there is no mutation to make. Collapsing them into one signal would make a
   * Han selection behave like a punctuation-only one.
   */
  it('answers null for nothing-to-snap and an unchanged range for already-correct', () => {
    const nothing = row('none-lone-plus')
    const held = row('cjk-han-edges-unchanged')

    expect(snapWordRange(nothing.strs, nothing.start, nothing.end, {})).toBeNull()
    expect(snapWordRange(held.strs, held.start, held.end, {})).toEqual({
      start: held.start,
      end: held.end,
    })
  })

  /*
   * The order of the checks is the behaviour, and this is the only case that
   * pins it. The collapsed edge is strictly inside `quick`, so an
   * implementation that expands before testing for a zero-length range answers
   * `'quick'` — turning a plain click into a word selection. The second
   * assertion is the control: give the same edge one character of width and it
   * does snap, so the `null` above is the collapse check firing rather than an
   * inability to find a word.
   */
  it('returns null for a zero-length range, rather than the word around it', () => {
    const collapsed = row('none-zero-length-range')

    expect(snapWordRange(collapsed.strs, collapsed.start, collapsed.end, {})).toBeNull()
    expect(sliceFlat(collapsed.strs, mustSnap(collapsed.strs, collapsed.start, at(0, 6)))).toBe(
      'quick',
    )
  })
})

describe('snapWordRange — across `strs` entries', () => {
  /*
   * `quick` is split across the entry boundary on purpose: an implementation
   * that segments each entry on its own sees `qui` and `ck`, and answers
   * {0,4}/{1,2}.
   */
  it('snaps in the correct entry when a word is split across two entries', () => {
    const { fixture, result } = snapOf('seam-word-split-across-two-entries')

    expect(sliceFlat(fixture.strs, result)).toBe('quick brown')
  })

  /*
   * A position on a seam has two spellings. Pinned: `start` takes the LATER
   * entry at offset 0, `end` takes the EARLIER entry at its length — so both
   * edges name a position inside an entry that exists, which is what WI-5's
   * mapping back to a live node needs. Each row feeds in the OTHER spelling,
   * so a pass-through implementation fails both, and the assertion is on the
   * entry index because the text is identical either way.
   */
  it('normalizes a snapped edge that lands on an entry seam', () => {
    const fromEarlier = snapOf('seam-start-takes-the-later-entry')
    const fromLater = snapOf('seam-end-takes-the-earlier-entry')

    expect(fromEarlier.result.start).toEqual(at(1, 0))
    expect(sliceFlat(fromEarlier.fixture.strs, fromEarlier.result)).toBe('beta')
    expect(fromLater.result.end.index).toBe(0)
    expect(sliceFlat(fromLater.fixture.strs, fromLater.result)).toBe('alpha')
  })

  /*
   * The empty entry sits between the two halves of the word `ab`, so it must be
   * invisible to the answer and visible to the mapping. An implementation that
   * skips empty entries when building the flat text but not when mapping back
   * returns {1,0} or throws. The single-character row makes every entry one
   * character, so an off-by-one in the walk cannot hide inside a long entry.
   */
  it('treats an empty entry as transparent to the answer and present in the mapping', () => {
    const { fixture, result } = snapOf('seam-empty-entry-is-transparent')

    expect(sliceFlat(fixture.strs, result)).toBe('ab')
  })

  it('walks single-character entries without an off-by-one', () => {
    const { fixture, result } = snapOf('seam-single-character-entries')

    expect(sliceFlat(fixture.strs, result)).toBe('abc d')
  })
})

describe('snapWordRange — the block sentinel', () => {
  /*
   * The control is the case. `'done'` on its own is also what a broken
   * expansion that never moves returns, so the sentinel row alone would pass
   * for the wrong reason; only the pair shows that the sentinel is what
   * stopped it.
   *
   * The guarantee comes from UAX #29, which makes LF a mandatory break on both
   * sides — not from anything this module does to the character.
   */
  it('stops expansion at `\\n`, and the control without it merges', () => {
    const stopped = snapOf('sentinel-newline-stops-expansion')
    const merged = snapOf('sentinel-absent-merges-two-blocks')

    expect(sliceFlat(stopped.fixture.strs, stopped.result)).toBe('done')
    expect(sliceFlat(merged.fixture.strs, merged.result)).toBe('doneStart')
    expect(stopped.result).not.toEqual(merged.result)
  })

  /*
   * The other half of the sentinel rule, and the reason it is stated as two
   * halves: expansion may never cross a block break, trimming may. A start
   * edge sitting on the `\n` itself belongs to no word, so it trims forward
   * into the next block — an implementation that turns the sentinel into a
   * hard barrier for both operations leaves it stranded on the newline.
   */
  it('lets trimming cross `\\n`, which expansion may not', () => {
    const { fixture, result } = snapOf('sentinel-newline-lets-trimming-cross')

    expect(sliceFlat(fixture.strs, result)).toBe('Start')
  })

  /*
   * The REJECTED design, asserted so it cannot be quietly reinstated by
   * someone tidying the sentinel into an invisible character. U+2060 WORD
   * JOINER is General_Category `Cf`, UAX #29 WB4 ignores Format characters, and
   * the two words either side of one are therefore ONE segment. Matched with a
   * pattern rather than spelled out, so the assertion stays readable: `done`,
   * exactly one character, `Start`. If a future ICU changes this, the test
   * fails loudly and the choice gets revisited on evidence.
   */
  it('does NOT stop expansion at U+2060 — the sentinel that looks right and is not', () => {
    const { fixture, result } = snapOf('sentinel-word-joiner-does-not-stop-expansion')

    expect(sliceFlat(fixture.strs, result)).toMatch(/^done.Start$/u)
  })
})

describe('snapWordRange — settled segmentation decisions', () => {
  /*
   * U+00AD is `Cf`, WB4 ignores it, and WebKit's own double-click takes the
   * whole word. Anyone who "fixes" this by adding the soft hyphen to a
   * separator list re-breaks every word hyphenated at a line end — this test
   * is the thing that stops them.
   *
   * Twelve characters for an eleven-letter word: the invisible one is inside
   * the range, which is what makes this different from `hyphenation` with
   * nothing in it.
   */
  it('expands across a soft hyphen inside a word', () => {
    const { fixture, result } = snapOf('soft-hyphen-inside-a-word')
    const text = sliceFlat(fixture.strs, result)

    expect(text).toHaveLength(12)
    expect(text.startsWith('hyphen')).toBe(true)
    expect(text.endsWith('ation')).toBe(true)
  })
})

describe('snapWordRange — the per-edge script gate', () => {
  /*
   * Both halves in one expectation, so "the gate blocks everything" and "the
   * gate blocks nothing" are each a failure. A gate applied per SELECTION
   * rather than per EDGE returns both-moved or both-unmoved and fails either
   * way. Asserted as moved/held against the INPUT edges, which is the claim
   * being made — the offsets themselves are `corpus.test.ts`'s.
   */
  it('snaps the Latin edge and leaves the Han edge inside a Chinese sentence', () => {
    const { fixture, result } = snapOf('mixed-latin-inside-a-chinese-sentence')

    expect(result.start).not.toEqual(fixture.start)
    expect(result.end).toEqual(fixture.end)
    expect(sliceFlat(fixture.strs, result).startsWith('English')).toBe(true)
  })

  /*
   * The mirror, so neither edge is the one that happens to work. Here the
   * BLOCKED edge is the start and the snapping edge is the end; the case above
   * has it the other way round. An implementation that gates only one edge
   * passes one of these two and fails the other.
   */
  it('leaves the Han edge and snaps the Latin edge with the roles reversed', () => {
    const { fixture, result } = snapOf('mixed-han-start-latin-end')

    expect(result.start).toEqual(fixture.start)
    expect(result.end).not.toEqual(fixture.end)
    expect(sliceFlat(fixture.strs, result).endsWith('English')).toBe(true)
  })

  /*
   * The gate blocks EXPANSION into a blocked script; it does not block
   * TRIMMING onto one. The two look alike and are not, and the difference is
   * what the reader can see:
   *
   * - Expanding a Han edge would move it to a boundary produced by
   *   probabilistic dictionary segmentation — a place the reader cannot see
   *   and did not choose. That is what the gate exists to refuse.
   * - Trimming from whitespace lands on a RUN boundary, the whitespace-to-text
   *   transition. That boundary is visible in every script, so refusing it
   *   would leave a stray space in the selection for no benefit.
   *
   * Both directions are asserted because an implementation can easily get one
   * right and the other wrong: the gate is consulted in two separate places,
   * one per edge. Both fixtures carry two spaces rather than one, so "moved to
   * the run boundary" cannot be confused with "moved one character".
   *
   * NOTE — the test matrix left this interaction unpinned. It was settled
   * deliberately, on the reasoning above, and pinned here so a later work item
   * does not rediscover it and quietly reverse it.
   */
  it('trims a start edge in whitespace forward onto a blocked run, which it may not expand into', () => {
    const { fixture, result } = snapOf('mixed-trim-start-onto-a-blocked-run')

    // Start trimmed forward to the visible run boundary; end held, because
    // expanding it would cross an invisible one.
    expect(result.start.offset).toBeGreaterThan(fixture.start.offset)
    expect(result.end).toEqual(fixture.end)
    expect(sliceFlat(fixture.strs, result)).toHaveLength(1)
  })

  it('trims an end edge in whitespace back onto a blocked run, which it may not expand into', () => {
    const { fixture, result } = snapOf('mixed-trim-end-onto-a-blocked-run')

    expect(result.end.offset).toBeLessThan(fixture.end.offset)
    expect(result.start).toEqual(fixture.start)
    expect(sliceFlat(fixture.strs, result)).toHaveLength(1)
  })

  /*
   * Unchanged offsets, NOT `null`. The two mean different things downstream:
   * `null` tells WI-6 to leave the live selection alone, an unchanged result
   * tells it there is no mutation to make — and WI-9 publishes either way.
   * Asserted against the input edges, so this says "did not move" rather than
   * restating the corpus's numbers.
   */
  const unsnappable = [
    'cjk-han-edges-unchanged',
    'thai-edges-unchanged',
    'kana-long-vowel-mark-unchanged',
    'astral-han-edges-unchanged',
  ].map(row)

  it.each(unsnappable)('leaves both edges of $id where the reader put them', (fixture) => {
    const result = snapWordRange(fixture.strs, fixture.start, fixture.end, {})

    expect(result).not.toBeNull()
    expect(result).toEqual({ start: fixture.start, end: fixture.end })
  })
})

describe('snapWordRange — caller bugs throw', () => {
  /*
   * Not normalised by swapping. WI-6 reads selection DIRECTION from
   * anchor/focus, so a silently-swapped result would let a direction bug
   * through undetected. The cross-entry row is here because comparing `offset`
   * alone gets the single-entry row right and this one wrong.
   *
   * These fixtures stay inline rather than moving to the corpus: the corpus
   * maps an input to a snap or to `none`, and a throw is neither.
   */
  it('throws when start is after end, within one entry and across entries', () => {
    expect(() => snapWordRange(['the quick brown fox'], at(0, 12), at(0, 5), {})).toThrow(RangeError)
    expect(() => snapWordRange(['the quick brown fox'], at(0, 12), at(0, 5), {})).toThrow(
      /start .* after .* end/i,
    )
    expect(() => snapWordRange(['ab', 'cd'], at(1, 1), at(0, 1), {})).toThrow(RangeError)
    expect(() => snapWordRange(['ab', 'cd'], at(1, 1), at(0, 1), {})).toThrow(
      /start .* after .* end/i,
    )
  })

  /*
   * `Math.min(offset, str.length)` clamping is the refactor this forbids. The
   * non-integer rows matter more than they look: a `1.5` arriving from DOM
   * offset arithmetic is a real bug upstream, and clamping turns it into a
   * quietly wrong selection instead of a loud failure where it is diagnosable.
   */
  const outOfRange: ReadonlyArray<readonly [string, Edge]> = [
    ['an index past the last entry', at(1, 0)],
    ['a negative index', at(-1, 0)],
    ['an offset past the entry length', at(0, 4)],
    ['a negative offset', at(0, -1)],
    ['a fractional offset', at(0, 1.5)],
    ['a fractional index', at(0.5, 0)],
  ]

  it.each(outOfRange)('throws for %s, as either edge', (_label, edge) => {
    expect(() => snapWordRange(['abc'], edge, at(0, 3), {})).toThrow(RangeError)
    expect(() => snapWordRange(['abc'], at(0, 0), edge, {})).toThrow(RangeError)
  })

  /* Off-by-one guard on the guard: an offset exactly at the entry length is a
   * valid position and must not throw. */
  it('accepts an offset exactly at the entry length', () => {
    expect(() => snapWordRange(['abc'], at(0, 0), at(0, 3), {})).not.toThrow()
    expect(mustSnap(['abc'], at(0, 0), at(0, 3))).toEqual({ start: at(0, 0), end: at(0, 3) })
  })

  /* Validation runs before the zero-length check, so a caller bug is never
   * masked by a benign-looking `null`. */
  it('throws for an out-of-range position on an empty `strs` rather than returning null', () => {
    expect(() => snapWordRange([], at(0, 1), at(0, 1), {})).toThrow(RangeError)
  })
})

describe('snapWordRange — totality and determinism', () => {
  /*
   * Every result offset must be a position that exists in `strs`, across the
   * whole corpus — the property that makes WI-5's mapping back to a live node
   * safe. Driven from the corpus rather than from a hand-listed subset, so a
   * row added for its segmentation gets this property checked for free.
   */
  const snapping = CORPUS.filter((fixture) => fixture.expected !== 'none')

  /* `it.each([])` passes silently and reports zero tests, which looks exactly
   * like a healthy run. This is what tells the two apart. */
  it('has corpus rows that snap, so the property below is not vacuous', () => {
    expect(snapping.length).toBeGreaterThan(0)
    expect(snapping.length).toBeLessThan(CORPUS.length)
  })

  it.each(snapping)('$id returns positions that exist in strs', (fixture) => {
    const result = mustSnap(fixture.strs, fixture.start, fixture.end)

    for (const edge of [result.start, result.end]) {
      expect(Number.isInteger(edge.index)).toBe(true)
      expect(edge.index).toBeGreaterThanOrEqual(0)
      expect(edge.index).toBeLessThan(Math.max(fixture.strs.length, 1))
      expect(Number.isInteger(edge.offset)).toBe(true)
      expect(edge.offset).toBeGreaterThanOrEqual(0)
      expect(edge.offset).toBeLessThanOrEqual(
        fixture.strs.slice(edge.index, edge.index + 1).join('').length,
      )
    }
  })

  /*
   * `Object.freeze` catches in-place normalisation of the input edges
   * directly, and the snapshot is compared against a `structuredClone` taken
   * before the call rather than against the same array the call received —
   * otherwise a mutating implementation would be rewriting its own oracle. The
   * corpus row is copied before freezing, so this case cannot freeze data the
   * rest of the suite shares.
   */
  it('is deterministic, allocates a fresh result, and mutates nothing', () => {
    const fixture = row('expand-both-edges')
    const strs = Object.freeze([...fixture.strs])
    const start = Object.freeze({ ...fixture.start })
    const end = Object.freeze({ ...fixture.end })
    const snapshot = structuredClone({ strs, start, end })

    const first = mustSnap(strs, start, end)
    const second = mustSnap(strs, start, end)

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.start).not.toBe(second.start)
    expect({ strs, start, end }).toEqual(snapshot)
  })
})

describe('snapWordRange — degrading instead of throwing', () => {
  const realSegmenter = Intl.Segmenter

  afterEach(() => {
    Reflect.set(Intl, 'Segmenter', realSegmenter)
  })

  /*
   * A host built-in stub, the same category as `Date.now`. If the Segmenter is
   * ever constructed at module load rather than per call, this file fails to
   * import at all — which is the correct signal, not a false negative.
   */
  it('returns null when the host has no Intl.Segmenter, without throwing', () => {
    const fixture = row('expand-both-edges')
    Reflect.set(Intl, 'Segmenter', undefined)

    expect(() => snapWordRange(fixture.strs, fixture.start, fixture.end, {})).not.toThrow()
    expect(snapWordRange(fixture.strs, fixture.start, fixture.end, {})).toBeNull()
  })

  /*
   * The WI-2 seam with both real modules. `new Intl.Segmenter('en_US')` throws
   * a RangeError (measured), and passing `opts.locale` straight through would
   * send that RangeError up into the selection publish path.
   *
   * Honest limitation: this cannot prove the locale AFFECTS segmentation — no
   * locale-sensitive difference is reachable in Node ICU for any fixture
   * tried. Totality is the whole unit-lane contract of the parameter.
   */
  it('accepts a hostile or absent locale and segments anyway', () => {
    const fixture = row('expand-both-edges')
    const opts: readonly SnapOptions[] = [
      { locale: 'en_US' },
      { locale: '???' },
      { locale: null as never },
      {},
    ]

    const results = opts.map((o) => mustSnap(fixture.strs, fixture.start, fixture.end, o))

    for (const result of results) {
      expect(result).toEqual(fixture.expected)
      expect(sliceFlat(fixture.strs, result)).toBe('quick brown')
    }
  })
})

const SOURCE_PATH = fileURLToPath(new URL('./snapWordRange.ts', import.meta.url))

describe('snapWordRange.ts is a pure module', () => {
  it('runs with no DOM globals present at all', () => {
    const fixture = row('expand-both-edges')

    expect(globalThis.document).toBeUndefined()
    expect(globalThis.window).toBeUndefined()
    expect(globalThis.getSelection).toBeUndefined()
    // And the module still answers, in that environment.
    expect(mustSnap(fixture.strs, fixture.start, fixture.end)).toEqual(fixture.expected)
  })

  it('names no DOM identifier outside its own prose', () => {
    const raw = readFileSync(SOURCE_PATH, 'utf8')
    const { codeOnly } = scan(raw)

    /* Non-vacuity: the module's docstring is required to name what it does not
     * touch, so a raw-source regex fails on the documentation alone. If this
     * line ever fails, the docstring lost its purity note — restore it rather
     * than deleting this assertion. */
    expect(raw.match(DOM_IDENTIFIERS)).not.toBeNull()
    expect(codeOnly.match(DOM_IDENTIFIERS) ?? []).toEqual([])
  })

  it('imports nothing from outside src/reader/wordSnap/', () => {
    const { withoutComments } = scan(readFileSync(SOURCE_PATH, 'utf8'))
    const outside = importSpecifiers(withoutComments).filter((s) => !s.startsWith('./'))

    expect(outside).toEqual([])
  })
})

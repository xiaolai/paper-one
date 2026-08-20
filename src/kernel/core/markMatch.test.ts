import { describe, expect, it } from 'vitest'
import { cfiOverlaps, findMark, upsertOverlapping } from './markMatch'
import { liveMarks, type Mark } from './marks'

/**
 * Fixture CFIs are real range CFIs: parent path, then start, then end.
 * `epubcfi(/6/4!/4/2,/1:5,/1:12)` is characters 5..12 of the first text node
 * of `/4/2` — the shape `view.getCFI` produces for a text selection.
 */
function mark(over: Partial<Mark> = {}): Mark {
  return {
    id: 'm1',
    bookId: 'book-a',
    cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)',
    sectionIndex: 0,
    text: 'Ishmael',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Ch. 1',
    createdAt: 1000,
    ...over,
  }
}

/** Where a selection is, in the shape the matcher takes. */
function at(cfi: string, over: { sectionIndex?: number; bookId?: string } = {}) {
  return { cfi, sectionIndex: 0, bookId: 'book-a', ...over }
}

describe('cfiOverlaps', () => {
  it('is symmetric, and true for a range against itself', () => {
    const a = 'epubcfi(/6/4!/4/2,/1:5,/1:12)'
    const b = 'epubcfi(/6/4!/4/2,/1:0,/1:20)'
    expect(cfiOverlaps(a, b)).toBe(true)
    expect(cfiOverlaps(b, a)).toBe(true)
    expect(cfiOverlaps(a, a)).toBe(true)
  })

  it('is false where two ranges only touch', () => {
    // Half-open: 5..12 and 12..20 share no character, so they are two
    // passages, not one. Pinned from both sides one line down.
    expect(cfiOverlaps('epubcfi(/6/4!/4/2,/1:5,/1:12)', 'epubcfi(/6/4!/4/2,/1:12,/1:20)')).toBe(
      false,
    )
    expect(cfiOverlaps('epubcfi(/6/4!/4/2,/1:5,/1:12)', 'epubcfi(/6/4!/4/2,/1:11,/1:20)')).toBe(
      true,
    )
  })
})

describe('findMark', () => {
  it('resolves a mark the selection contains', () => {
    // The rollout case in its simplest form: the reader marked part of a word
    // before snapping shipped, and now selects the whole word.
    const marks = [mark({ id: 'm1', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)' })]
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:0,/1:20)'))?.id).toBe('m1')
  })

  it('resolves a mark that contains the selection', () => {
    /* The bug that exists TODAY, before any snapping: selecting a few words
     * inside a paragraph that is already highlighted offered "Mark" and made a
     * second, overlapping mark on top of the first. */
    const marks = [mark({ id: 'm1', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:20)' })]
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:5,/1:12)'))?.id).toBe('m1')
  })

  it('resolves a mark whose CFI is byte-identical', () => {
    // The old behaviour has to remain a strict subset of the new one.
    const marks = [mark({ id: 'm1', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)' })]
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:5,/1:12)'))?.id).toBe('m1')
  })

  it('resolves a mark whose CFI is a single point, against itself', () => {
    /* A CFI with no range at all — one position, no text between its ends.
     * There is nothing for a strict overlap test to find here, not even
     * against an identical copy, so equality is its own answer rather than a
     * special case of overlap. Without that, a mark stored at a point would be
     * reachable by NO selection whatsoever, including the one that made it. */
    const marks = [mark({ id: 'point', cfi: 'epubcfi(/6/4!/4/2/1:5)' })]
    expect(findMark(marks, at('epubcfi(/6/4!/4/2/1:5)'))?.id).toBe('point')
  })

  it('resolves a pre-rollout partial-word mark from a snapped selection', () => {
    /* The whole point of the work item, with the CFIs the rollout actually
     * produces: a mark made across part of a word, re-selected after snapping
     * widened the gesture to the whole word. Byte equality cannot see these as
     * the same passage, and the reader can no longer reproduce the original
     * partial selection to reach the mark by hand. */
    const marks = [mark({ id: 'old', cfi: 'epubcfi(/6/4!/4/2,/1:7,/1:11)' })]
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:5,/1:12)'))?.id).toBe('old')
  })

  it('does not resolve a mark the selection only touches', () => {
    const marks = [mark({ id: 'm1', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)' })]
    // Ends exactly where the mark begins, and starts exactly where it ends.
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:12,/1:20)'))).toBeNull()
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:0,/1:5)'))).toBeNull()
    // One character in from either side, and it does.
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:11,/1:20)'))?.id).toBe('m1')
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:0,/1:6)'))?.id).toBe('m1')
  })

  it('takes the first mark in document order when a selection overlaps two', () => {
    /* The documented tie-break, and the fixture is built so that no other rule
     * produces this answer:
     *
     *   array order      would answer `wide`, which is stored first
     *   creation order   would answer `wide`, which is older
     *   greatest overlap would answer `wide`, which shares 9 characters with
     *                    the selection against `early`'s 2
     *
     * `compareMarks` order answers `early`, because it starts at character 0.
     * That comparator is the one the Notes list already reads in, is total over
     * CFIs that carry no offsets at all, and needs nothing measured. */
    const marks = [
      mark({ id: 'wide', cfi: 'epubcfi(/6/4!/4/2,/1:8,/1:30)', createdAt: 50 }),
      mark({ id: 'early', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:7)', createdAt: 100 }),
    ]
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:5,/1:17)'))?.id).toBe('early')
  })

  it('is deterministic over CFIs that carry no character offsets', () => {
    /* `view.getCFI` genuinely emits these — a range that begins and ends at an
     * element boundary has no offset to report. There is no "amount of overlap"
     * to measure here, which is why the tie-break is not a measurement. Every
     * permutation must answer the same mark; an implementation that subtracts
     * missing offsets gets NaN, compares false, and silently returns whichever
     * mark the array happened to yield first. */
    const first = mark({ id: 'first', cfi: 'epubcfi(/6/4!/4/2/1,/2,/6)', createdAt: 300 })
    const second = mark({ id: 'second', cfi: 'epubcfi(/6/4!/4/2/1,/4,/8)', createdAt: 100 })
    const selection = at('epubcfi(/6/4!/4/2/1,/4,/6)')

    expect(findMark([first, second], selection)?.id).toBe('first')
    expect(findMark([second, first], selection)?.id).toBe('first')
    expect(() => findMark([second, first], selection)).not.toThrow()
  })

  it('never matches a mark in another section', () => {
    /* Two CFIs from different spine items address positions in different
     * documents and are not comparable at all — `marks.ts` says so where it
     * sorts. The fixture is structurally identical on purpose, so an
     * implementation that skips the section check matches the wrong mark
     * rather than merely returning something odd. */
    const marks = [mark({ id: 'elsewhere', sectionIndex: 3 })]
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:5,/1:12)'))).toBeNull()
  })

  it('never matches a mark from another book', () => {
    const marks = [mark({ id: 'other-book', bookId: 'book-b' })]
    expect(findMark(marks, at('epubcfi(/6/4!/4/2,/1:5,/1:12)'))).toBeNull()
  })

  it('neither throws on nor matches a stored CFI that will not parse', () => {
    /* Storage is a trust boundary, and the failure here is not "no match" — it
     * is the opposite. foliate parses an unusable string into a degenerate path
     * that sorts BEFORE everything, so an overlap test built on comparison
     * alone finds one corrupt row overlapping every selection in the book.
     *
     * The last two are the ones a plain regex guard misses: `epubcfi(garbage)`
     * has the right wrapper and no path, and a range CFI missing its end throws
     * outright when collapsed. */
    const broken = [
      '',
      ' ',
      'not a cfi',
      'epubcfi(',
      'epubcfi(garbage)',
      'epubcfi(/6/4!/4/2,/1:5)',
    ]
    for (const cfi of broken) {
      const marks = [mark({ id: `bad-${cfi}`, cfi })]
      const selection = at('epubcfi(/6/4!/4/2,/1:5,/1:12)')
      expect(() => findMark(marks, selection)).not.toThrow()
      expect(findMark(marks, selection)).toBeNull()
      // Not even against itself: equality is a shortcut through the overlap
      // test, never through the validity check.
      expect(findMark(marks, at(cfi))).toBeNull()
    }
  })

  it('finds the same mark whatever order the store hands them over in, and mutates nothing', () => {
    const marks = [
      mark({ id: 'far', cfi: 'epubcfi(/6/4!/4/6,/1:0,/1:9)', createdAt: 10 }),
      mark({ id: 'inner', cfi: 'epubcfi(/6/4!/4/2,/1:6,/1:9)', createdAt: 20 }),
      mark({ id: 'before', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', createdAt: 30 }),
      mark({ id: 'outer', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:14)', createdAt: 40 }),
      mark({ id: 'other-section', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)', sectionIndex: 1 }),
    ]
    const permutations = [
      marks,
      [...marks].reverse(),
      [marks[3]!, marks[0]!, marks[4]!, marks[1]!, marks[2]!],
    ]
    for (const permutation of permutations) {
      const before = structuredClone(permutation)
      // `outer` starts at 5 and `inner` at 6, so document order settles it.
      expect(findMark(permutation, at('epubcfi(/6/4!/4/2,/1:7,/1:12)'))?.id).toBe('outer')
      expect(permutation).toEqual(before)
    }
  })
})

describe('upsertOverlapping', () => {
  it('replaces the mark a re-mark resolved to, rather than stacking a second', () => {
    /* The duplicate this work item exists to prevent. The reader marks a
     * passage, selects it again — snapped wider than the first time — and the
     * toolbar offers "Re-mark", which re-adds with the note carried over. Keyed
     * by byte-exact CFI, that leaves two overlapping marks and draws both. */
    const existing = mark({ id: 'first', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)', note: 'a note' })
    const created = mark({
      id: 'second',
      cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:20)',
      note: 'a note',
      createdAt: 2000,
    })

    const next = upsertOverlapping([existing], created)

    /* The replaced row is TOMBSTONED, not dropped — a replace is a removal
     * wearing a new mark, and a removal that leaves no row cannot travel to
     * another device. The read model (`liveMarks`) shows one mark. */
    expect(liveMarks(next)).toEqual([created])
    expect(next.find((row) => row.id === 'first')?.deletedAt).toBeDefined()
  })

  it('still replaces a mark at the byte-identical anchor', () => {
    const existing = mark({ id: 'first', note: '' })
    const created = mark({ id: 'second', note: 'a note', createdAt: 2000 })
    expect(liveMarks(upsertOverlapping([existing], created))).toEqual([created])
  })

  it('keeps a mark the new one only touches', () => {
    const neighbour = mark({ id: 'neighbour', cfi: 'epubcfi(/6/4!/4/2,/1:12,/1:20)' })
    const created = mark({ id: 'new', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)', createdAt: 2000 })
    expect(upsertOverlapping([neighbour], created).map((row) => row.id)).toEqual([
      'neighbour',
      'new',
    ])
  })

  it('keeps an overlapping mark in another book', () => {
    const elsewhere = mark({ id: 'elsewhere', bookId: 'book-b' })
    const created = mark({ id: 'new', createdAt: 2000 })
    expect(upsertOverlapping([elsewhere], created).map((row) => row.id)).toEqual([
      'elsewhere',
      'new',
    ])
  })

  it('supersedes only the mark it resolved, leaving the reader’s other notes alone', () => {
    /* One removal, not every overlapping row. A selection spanning a paragraph
     * overlaps everything marked inside it, and each of those may carry a
     * written note; dropping them all would delete work the reader never asked
     * to lose. The one that goes is the one the toolbar named. */
    const early = mark({ id: 'early', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:8)', note: 'first note' })
    const late = mark({ id: 'late', cfi: 'epubcfi(/6/4!/4/2,/1:10,/1:18)', note: 'second note' })
    const created = mark({ id: 'wide', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:20)', createdAt: 2000 })

    expect(liveMarks(upsertOverlapping([early, late], created)).map((row) => row.id)).toEqual([
      'late',
      'wide',
    ])
  })

  it('never leaves two rows at one anchor, even when the row it superseded was another', () => {
    /* Reachable from a store that already holds overlapping rows — anything
     * written before this rule existed. The tie-break resolves `outer`, so
     * that is the row this mark supersedes; `inner` then goes by the older
     * byte-exact rule, which has not been given up. Keeping it would leave two
     * rows at one anchor, which foliate draws twice and the Notes list shows
     * twice — exactly what `upsertMark` exists to prevent. */
    const outer = mark({ id: 'outer', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:20)', createdAt: 10 })
    const inner = mark({ id: 'inner', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)', createdAt: 20 })
    const created = mark({ id: 'new', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)', createdAt: 2000 })

    expect(liveMarks(upsertOverlapping([outer, inner], created)).map((row) => row.id)).toEqual(['new'])
  })

  it('does not mutate the collection it is given', () => {
    const marks = [mark({ id: 'first' })]
    const before = structuredClone(marks)
    upsertOverlapping(marks, mark({ id: 'second', createdAt: 2000 }))
    expect(marks).toEqual(before)
  })
})

/**
 * A bookmark anchors to the VISIBLE PAGE, so it overlaps every highlight on
 * that page by construction — which makes overlap-replacement, the rule this
 * whole module exists for, exactly the wrong rule to apply across the two.
 */
describe('upsertOverlapping keeps bookmarks and annotations off each other', () => {
  /* A page-sized range, the shape a relocation reports: it covers the
   * character range every mark on that page sits inside. */
  const page = 'epubcfi(/6/4!/4/2,/1:0,/1:400)'

  it('does not let a bookmark of the page tombstone a highlight on it', () => {
    const highlight = mark({ id: 'h', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)', note: 'kept' })
    const place = mark({ id: 'b', kind: 'bookmark', cfi: page, createdAt: 2000 })

    const next = upsertOverlapping([highlight], place)

    expect(liveMarks(next).map((row) => row.id).sort()).toEqual(['b', 'h'])
    expect(next.find((row) => row.id === 'h')?.deletedAt).toBeUndefined()
  })

  it('does not let a highlight tombstone the bookmark of the page it is on', () => {
    const place = mark({ id: 'b', kind: 'bookmark', cfi: page })
    const highlight = mark({ id: 'h', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)', createdAt: 2000 })

    const next = upsertOverlapping([place], highlight)

    expect(liveMarks(next).map((row) => row.id).sort()).toEqual(['b', 'h'])
    expect(next.find((row) => row.id === 'b')?.deletedAt).toBeUndefined()
  })

  /* The candidates are NARROWED rather than the answer screened afterwards,
   * and this is the case that tells the two apart: `findMark` returns the
   * first in document order, so a bookmark starting before the highlight would
   * be picked and then discarded — leaving the highlight that should have been
   * superseded standing, and a duplicate drawn over it. */
  it('supersedes the highlight even when a bookmark sorts ahead of it', () => {
    const place = mark({ id: 'b', kind: 'bookmark', cfi: page })
    const highlight = mark({ id: 'h', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)' })
    const remark = mark({ id: 'h2', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:20)', createdAt: 2000 })

    const next = upsertOverlapping([place, highlight], remark)

    expect(liveMarks(next).map((row) => row.id).sort()).toEqual(['b', 'h2'])
    expect(next.find((row) => row.id === 'h')?.deletedAt).toBeDefined()
  })

  /* And within the class the rule is unchanged, which is what makes the toggle
   * work: bookmarking a page that already carries one replaces it rather than
   * stacking a second a line below the first. */
  it('replaces a bookmark with a bookmark of the same page', () => {
    const first = mark({ id: 'b1', kind: 'bookmark', cfi: page })
    const again = mark({ id: 'b2', kind: 'bookmark', cfi: 'epubcfi(/6/4!/4/2,/1:20,/1:420)', createdAt: 2000 })
    expect(liveMarks(upsertOverlapping([first], again)).map((row) => row.id)).toEqual(['b2'])
  })
})

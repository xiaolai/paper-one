import { describe, expect, it } from 'vitest'
import {
  MARKS_STORAGE_KEY,
  bookIdFor,
  compareCfi,
  compareMarks,
  identityParts,
  loadMarks,
  marginMarks,
  marksForBook,
  parseMarks,
  removeMark,
  saveMarks,
  updateNote,
  upsertMark,
  type Mark,
  type MarkStorage,
} from './marks'

function mark(over: Partial<Mark> = {}): Mark {
  return {
    id: 'm1',
    bookId: 'book-a',
    cfi: 'epubcfi(/6/4!/4/2)',
    sectionIndex: 0,
    text: 'Call me Ishmael',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    chapter: 'Ch. 1',
    createdAt: 1000,
    ...over,
  }
}

/**
 * A storage double, with a switch for the failure the reader must be told about.
 *
 * It KEYS its entries, unlike the version that ignored the key and kept one
 * value: that one would have let `saveMarks` and `loadMarks` disagree about
 * which key to use and still pass the round trip, which is the one thing a
 * round-trip test exists to catch. `value` reads the marks key so the existing
 * assertions still read naturally.
 */
function fakeStorage(initial: string | null = null, failWrites = false) {
  const entries = new Map<string, string>()
  if (initial !== null) entries.set(MARKS_STORAGE_KEY, initial)
  return {
    entries,
    get value(): string | null {
      return entries.get(MARKS_STORAGE_KEY) ?? null
    },
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error('QuotaExceededError')
      entries.set(key, value)
    },
  } satisfies MarkStorage & { value: string | null; entries: Map<string, string> }
}

/**
 * Stands in for a file too large to allocate — `identityParts` reads only `size`
 * and `slice`, so this exercises the real branch without a 500MB buffer.
 * Slices are returned as plain ranges so the test can read back WHERE it looked.
 */
interface Probe {
  readonly start: number
  readonly end: number
}
function fakeBlob(size: number) {
  const blob = {
    size,
    slice: (start: number, end?: number): Probe => ({ start, end: end ?? size }),
  }
  return blob as unknown as Blob
}

describe('bookIdFor', () => {
  /* A URL is READ rather than used as its address. It used to be trusted as-is,
   * which gave the same bytes two identities depending on how they were opened,
   * so marks made from the picker did not exist when the book was opened from
   * its URL. */
  it('identifies a URL by its content, not by its address', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetched: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      fetched.push(url)
      return Promise.resolve(new Response(bytes))
    }) as typeof fetch

    try {
      const fromUrl = await bookIdFor('https://example.com/moby.epub')
      const fromFile = await bookIdFor(new File([bytes], 'moby.epub'))
      expect(fetched).toEqual(['https://example.com/moby.epub'])
      expect(fromUrl).toBe(fromFile)
      // And the address is nowhere in the identity.
      expect(fromUrl).not.toContain('example.com')
    } finally {
      globalThis.fetch = original
    }
  })

  it('reports a URL it cannot read rather than inventing an identity for it', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(new Response('', { status: 404 }))) as typeof fetch
    try {
      await expect(bookIdFor('https://example.com/gone.epub')).rejects.toThrow('404')
    } finally {
      globalThis.fetch = original
    }
  })

  it('identifies a picked file by content, so re-picking it finds its marks', async () => {
    const first = new File(['abcd'], 'moby.epub')
    const second = new File(['abcd'], 'moby.epub')
    // A different File object for the same book on disk — the case that makes
    // object identity useless as a key.
    expect(await bookIdFor(first)).toBe(await bookIdFor(second))
  })

  it('follows the book rather than the file name', async () => {
    // Renamed, moved, re-downloaded: same book, same marks.
    expect(await bookIdFor(new File(['abcd'], 'moby.epub'))).toBe(
      await bookIdFor(new File(['abcd'], 'moby-dick (1).epub')),
    )
  })

  it('separates different books', async () => {
    expect(await bookIdFor(new File(['a'], 'a.epub'))).not.toBe(
      await bookIdFor(new File(['b'], 'b.epub')),
    )
  })

  it('separates same-sized books with the same name', async () => {
    // The collision the old name-and-size identity had no way to see: one
    // book's highlights, notes and cards appearing inside another.
    expect(await bookIdFor(new File(['aaaa'], 'book.pdf'))).not.toBe(
      await bookIdFor(new File(['bbbb'], 'book.pdf')),
    )
  })

  /* The collision that was REPRODUCED, not imagined. Identity used to be the
   * size plus the first and last 64KB, which is a statement about the ends of a
   * file and says nothing about the middle. Both of these hashed to
   * `file:97055b281d7b0385e0297135aece6323`, so one book's entire annotation
   * history belonged to the other. */
  it('separates books that differ only in the middle', async () => {
    const size = 300 * 1024
    const a = new Uint8Array(size).fill(7)
    const b = new Uint8Array(size).fill(7)
    b.fill(42, 150 * 1024, 151 * 1024) // one kilobyte, mid-file

    expect(a.length).toBe(b.length)
    // Same first and last 64KB — the entire basis of the old identity.
    expect(a.slice(0, 64 * 1024)).toEqual(b.slice(0, 64 * 1024))
    expect(a.slice(size - 64 * 1024)).toEqual(b.slice(size - 64 * 1024))

    expect(await bookIdFor(new File([a], 'a.epub'))).not.toBe(
      await bookIdFor(new File([b], 'b.epub')),
    )
  })

  it('hashes a book of ordinary size whole, rather than sampling it', () => {
    // 10MB is a large EPUB and a small PDF; both must get exact identity.
    const blob = fakeBlob(10 * 1024 * 1024)
    const parts = identityParts(blob)
    expect(parts).toHaveLength(2) // the size prefix, then the blob itself
    expect(parts[1]).toBe(blob) // not a slice of it
  })

  /* Above the limit identity is approximate, and this pins WHAT it samples so
   * that "we sample the interior" cannot quietly become "we sample the ends"
   * again. It does not — and cannot — assert that an arbitrary change is
   * caught: gaps between probes are the trade, and are documented as such. */
  it('probes the interior of a book too large to hash whole', () => {
    const size = 500 * 1024 * 1024
    const parts = identityParts(fakeBlob(size))
    const slices = parts.slice(1) as unknown as Probe[]

    expect(slices.length).toBeGreaterThan(2)
    // Both ends, as before.
    expect(slices[0]?.start).toBe(0)
    expect(slices.at(-1)?.end).toBe(size)
    // And the middle, which is what the old scheme never looked at.
    const interior = slices.filter((s) => s.start > 0 && s.end < size)
    expect(interior.length).toBeGreaterThanOrEqual(8)
    expect(interior.some((s) => s.start > size * 0.4 && s.start < size * 0.6)).toBe(true)
  })
})

describe('parseMarks and the context fields', () => {
  /* Every mark anyone has already made predates these fields. Dropping such a
   * row would lose a reader's own words over a field that is, by design, not
   * read by anything yet — so absent must mean empty, not invalid. */
  it('keeps a mark stored before context existed', () => {
    const old = { ...mark(), prefix: undefined, suffix: undefined }
    delete (old as Record<string, unknown>)['prefix']
    delete (old as Record<string, unknown>)['suffix']

    const parsed = parseMarks(JSON.stringify([old]))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.prefix).toBe('')
    expect(parsed[0]?.suffix).toBe('')
  })

  it('normalises a malformed context rather than dropping the mark', () => {
    for (const bad of [42, null, {}, ['x'], true]) {
      const parsed = parseMarks(JSON.stringify([{ ...mark(), prefix: bad, suffix: bad }]))
      expect(parsed, `prefix/suffix: ${JSON.stringify(bad)}`).toHaveLength(1)
      expect(parsed[0]?.prefix).toBe('')
    }
  })

  it('reads back a stored context unchanged', () => {
    const parsed = parseMarks(JSON.stringify([mark({ prefix: 'Call me ', suffix: '. Some' })]))
    expect(parsed[0]?.prefix).toBe('Call me ')
    expect(parsed[0]?.suffix).toBe('. Some')
  })
})

describe('compareCfi', () => {
  /* Vectors from foliate-js's own `tests/epubcfi-tests.js` (MIT, John
   * Factotum). They are here because a hand-rolled comparator passed five of
   * them and failed two — both the ones carrying ASSERTIONS, which is what
   * `view.getCFI` emits for any element with an id, so the failure was in
   * ordinary books rather than exotic ones. Kept as a regression guard against
   * anyone reimplementing this again. */
  const cases: readonly [string, string, number][] = [
    ['/6/4!/10', '/6/4!/10', 0],
    ['/6/4!/2/3:0', '/6/4!/2', 1],
    ['/6/4!/2/4/6/8/10/3:0', '/6/4!/4', -1],
    ['/6/4[chap0^]!/1ref^^]!/4[body01^^]/10[para^]^,05^^]', '/6/4!/4/10', 0],
    [
      '/6/4[chap0^]!/1ref^^]!/4[body01^^],/10[para^]^,05^^],/15:10[foo^]]',
      '/6/4!/4/12',
      -1,
    ],
    ['/6/4', '/6/4!/2', -1],
    ['/6/4!/2', '/6/4!/2!/2', -1],
  ]

  it('orders CFIs by document position, assertions and all', () => {
    for (const [a, b, expected] of cases) {
      expect(Math.sign(compareCfi(a, b))).toBe(Math.sign(expected))
    }
  })

  it('never throws on an anchor that will not parse', () => {
    /* Marks come out of storage, which is a trust boundary: one bad row must
     * not take the whole Notes list down. Asserting "does not throw, returns a
     * number" rather than a specific order, because where a malformed CFI sorts
     * is foliate's business and not a promise Paper should pin. */
    for (const bad of ['not a cfi', '', 'epubcfi(', 'epubcfi(/6/4', ' ']) {
      expect(() => compareCfi(bad, 'epubcfi(/6/4!/2)')).not.toThrow()
      expect(Number.isFinite(compareCfi(bad, 'epubcfi(/6/4!/2)'))).toBe(true)
    }
  })
})

describe('compareMarks', () => {
  it('orders by document position, comparing numbers as numbers', () => {
    /* Lexicographic order is wrong exactly where a book gets long: it walks
     * digit by digit, so chapter 10 sorts between chapter 1 and chapter 2 and
     * the Notes list stops reading in book order. */
    const marks = [
      mark({ id: 'ten', cfi: 'epubcfi(/6/10!/4/2)' }),
      mark({ id: 'four', cfi: 'epubcfi(/6/4!/4/2)' }),
      mark({ id: 'two', cfi: 'epubcfi(/6/2!/4/2)' }),
    ]
    expect([...marks].sort(compareMarks).map((m) => m.id)).toEqual(['two', 'four', 'ten'])
  })

  it('falls back to creation time for two marks on the same anchor', () => {
    const first = mark({ id: 'first', createdAt: 1 })
    const second = mark({ id: 'second', createdAt: 2 })
    expect([second, first].sort(compareMarks).map((m) => m.id)).toEqual(['first', 'second'])
  })
})

describe('upsertMark', () => {
  it('replaces a mark on the same anchor rather than stacking a second one', () => {
    const first = mark({ id: 'm1', note: '' })
    const second = mark({ id: 'm2', note: 'a thought' })
    const result = upsertMark([first], second)

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('m2')
    expect(result[0]?.note).toBe('a thought')
  })

  it('keeps a mark at the same anchor in a DIFFERENT book', () => {
    // The anchor alone is not identity: two books can share a CFI.
    const a = mark({ id: 'm1', bookId: 'book-a' })
    const b = mark({ id: 'm2', bookId: 'book-b' })
    expect(upsertMark([a], b)).toHaveLength(2)
  })
})

describe('marksForBook', () => {
  it('returns only the named book, in book order', () => {
    const all = [
      mark({ id: 'b', cfi: 'epubcfi(/6/8)', bookId: 'book-a' }),
      mark({ id: 'other', bookId: 'book-b' }),
      mark({ id: 'a', cfi: 'epubcfi(/6/4)', bookId: 'book-a' }),
    ]
    expect(marksForBook(all, 'book-a').map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('is empty when no book is open', () => {
    expect(marksForBook([mark()], null)).toEqual([])
  })
})

describe('marginMarks', () => {
  it('keeps notes and companion marks, and drops bare highlights', () => {
    const bare = mark({ id: 'bare' })
    const noted = mark({ id: 'noted', note: 'why this matters' })
    const companion = mark({ id: 'companion', kind: 'companion' })

    expect(marginMarks([bare, noted, companion]).map((m) => m.id)).toEqual([
      'noted',
      'companion',
    ])
  })

  it('leaves the column collapsed when every mark is a bare highlight', () => {
    // The rule the reader sees: highlighting a line does not open a 250px
    // column to show a dot repeating what the gold fill already says.
    expect(marginMarks([mark(), mark({ id: 'm2' })])).toEqual([])
  })
})

describe('updateNote and removeMark', () => {
  it('writes a note onto one mark only', () => {
    const marks = [mark({ id: 'm1' }), mark({ id: 'm2', cfi: 'x' })]
    const next = updateNote(marks, 'm2', 'a note')
    expect(next.find((m) => m.id === 'm1')?.note).toBe('')
    expect(next.find((m) => m.id === 'm2')?.note).toBe('a note')
  })

  it('removes by id', () => {
    expect(removeMark([mark({ id: 'm1' }), mark({ id: 'm2' })], 'm1')).toHaveLength(1)
  })
})

describe('parseMarks', () => {
  it('reads back what was written', () => {
    const marks = [mark()]
    expect(parseMarks(JSON.stringify(marks))).toEqual(marks)
  })

  it('returns nothing for absent, malformed or non-array payloads', () => {
    expect(parseMarks(null)).toEqual([])
    expect(parseMarks('not json')).toEqual([])
    expect(parseMarks('{"marks":[]}')).toEqual([])
  })

  /* Everything downstream addresses a mark by id and assumes one row per id:
   * `remove` drops every match and `setNote` rewrites every match. Nothing
   * enforced it, so a store carrying a duplicate id — a legacy write, a merge
   * across devices — turned one delete into several, across books. The ids
   * here differ in book and anchor precisely so a leak would be visible. */
  it('keeps one row per id, so a by-id delete cannot take another book with it', () => {
    const dupe = [
      { ...mark(), id: 'shared', bookId: 'book-a', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)' },
      { ...mark(), id: 'shared', bookId: 'book-b', cfi: 'epubcfi(/6/8!/4/2,/1:9,/1:14)' },
      { ...mark(), id: 'other', bookId: 'book-a' },
    ]
    const parsed = parseMarks(JSON.stringify(dupe))
    expect(parsed).toHaveLength(2)
    expect(parsed.map((m) => m.id)).toEqual(['shared', 'other'])
    // First wins — the oldest surviving row, not the later probable corruption.
    expect(parsed[0]?.bookId).toBe('book-a')
  })

  it('drops rows that fail validation and keeps the rest', () => {
    // Storage is a trust boundary: one bad row must not cost the reader every
    // other mark they have made.
    const payload = JSON.stringify([mark({ id: 'good' }), { id: 'bad' }, null, 7])
    const parsed = parseMarks(payload)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('good')
  })

  it('rejects a record missing its section index', () => {
    const { sectionIndex: _omitted, ...withoutSection } = mark()
    expect(parseMarks(JSON.stringify([withoutSection]))).toEqual([])
  })
})

describe('storage', () => {
  it('round-trips through a storage', () => {
    const storage = fakeStorage()
    const marks = [mark()]
    expect(saveMarks(storage, marks)).toBe(true)
    expect(loadMarks(storage)).toEqual(marks)
  })

  it('writes under the versioned key, and reads back from the same one', () => {
    /* Both halves, against ONE storage. The previous version wrote to a
     * throwaway object and then asserted that a `storage` it had never been
     * given was still empty — a true statement about nothing, which would have
     * passed just as well had `saveMarks` and `loadMarks` disagreed about the
     * key. Since the double now keys its entries, the round trip is the test:
     * a mismatch loses every mark on reload. */
    const storage = fakeStorage()
    saveMarks(storage, [mark()])
    expect([...storage.entries.keys()]).toEqual([MARKS_STORAGE_KEY])
    expect(loadMarks(storage)).toHaveLength(1)

    storage.entries.set('paper.marks.wrong-key', storage.entries.get(MARKS_STORAGE_KEY) ?? '')
    storage.entries.delete(MARKS_STORAGE_KEY)
    expect(loadMarks(storage)).toEqual([])
  })

  it('reports a failed write rather than throwing or silently losing it', () => {
    // The reader can be told their marks are not being saved only if this
    // returns false instead of swallowing the error.
    expect(saveMarks(fakeStorage(null, true), [mark()])).toBe(false)
  })

  it('survives a storage that throws on read', () => {
    const hostile: MarkStorage = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {},
    }
    expect(loadMarks(hostile)).toEqual([])
  })
})

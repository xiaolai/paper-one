import { describe, expect, it } from 'vitest'
import {
  BOOKMARK_TEXT_MAX,
  MARKS_STORAGE_KEY,
  MAX_MARK_TEXT,
  annotationsIn,
  bookIdFor,
  bookmarkFrom,
  bookmarksIn,
  openingLine,
  compareCfi,
  compareMarks,
  contentId,
  identityParts,
  liveMarks,
  loadMarks,
  marginMarks,
  parseMarks,
  removeMark,
  sameClass,
  saveMarks,
  updateNote,
  upsertMark,
  type Annotation,
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
    tint: 'yellow',
    style: 'fill',
    chapter: 'Ch. 1',
    createdAt: 1000,
    ...over,
  }
}

/**
 * The same fixture, typed as the class it is.
 *
 * `marginMarks` takes `readonly Annotation[]` now — the column is an annotation
 * surface and its signature says so — and `mark()` answers `Mark`, which is the
 * wider type. This narrows without a cast by deciding the kind in an expression
 * the compiler can follow.
 */
function annotation(over: Partial<Annotation> = {}): Annotation {
  /* `Partial<Annotation>`, so a fixture cannot ask for `kind: 'bookmark'` here
     and silently get a highlight — a test whose meaning changed without its
     author noticing. */
  return { ...mark(over), kind: over.kind ?? 'highlight' }
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

  /**
   * ⚠️ **TWO DIFFERENT FILES, ONE ID — MEASURED, NOT REASONED ABOUT** (WI-21.4).
   *
   * The test above pins WHERE the sampling looks and says plainly that it
   * "does not — and cannot — assert that an arbitrary change is caught". This
   * one asserts the other half: that a change landing in a gap is genuinely
   * invisible, on real blobs, through the real `contentId`.
   *
   * **It is correct-by-design behaviour and it exists so that the "Exact" label
   * cannot be re-asserted by someone reading the key table too quickly.** The
   * phase-21 design's own key table said `file:<bookId>` was exact, and it is
   * not: above 64 MiB it is sampled, and a `file:` match was very nearly
   * allowed to authorise painting a foreign CFI without checking the text.
   * A comment can be skimmed past; a failing test cannot.
   *
   * Built from repeats of one 64 KiB chunk so only that chunk is ever held in
   * JavaScript memory — the blobs are large, the working set is not.
   */
  it('gives two different 65 MiB files the same id when they differ only in a gap', async () => {
    const CHUNK = 64 * 1024
    const chunks = Math.ceil((65 * 1024 * 1024) / CHUNK)
    const ordinary = new Uint8Array(CHUNK).fill(0x41)
    const different = new Uint8Array(CHUNK).fill(0x42)
    /* Chunk 15, at byte 983 040 — after the leading 64 KiB window and well
       before the first interior probe, which for a blob this size lands at
       ~4 009 261. Nothing samples it. */
    const inAGap = 15
    const build = (odd: number | null) =>
      new Blob(Array.from({ length: chunks }, (_, at) => (at === odd ? different : ordinary)))

    const a = build(null)
    const b = build(inAGap)
    expect(a.size).toBe(b.size)
    expect(a.size).toBeGreaterThan(64 * 1024 * 1024)
    /* The files really are different — asserted, because a test that compared
       two identical blobs would pass while proving nothing at all. */
    expect(new Uint8Array(await a.slice(inAGap * CHUNK, inAGap * CHUNK + 1).arrayBuffer())[0]).not.toBe(
      new Uint8Array(await b.slice(inAGap * CHUNK, inAGap * CHUNK + 1).arrayBuffer())[0],
    )

    expect(await contentId(a)).toBe(await contentId(b))

    /* AND THE INSTRUMENT IS PROVED TO WORK: the same difference inside the
       leading window DOES change the id. Without this, a `contentId` that
       ignored its input entirely would pass the assertion above. */
    expect(await contentId(build(0))).not.toBe(await contentId(a))
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

  /* THE SAME BOUND `text` AND `note` ARE CUT AT, on the two fields beside them.
     `book.mark.add` refuses a prefix past `MAX_MARK_TEXT`, but a hand-edited
     file and a peer's merge do not pass the table — and a mark carrying a
     chapter in `prefix` made every later answer that included it too large for
     the transport. Cut, not dropped: the reader's highlight survives. */
  it('cuts an over-long context at the bound the service table refuses at', () => {
    const long = 'x'.repeat(MAX_MARK_TEXT + 500)
    const parsed = parseMarks(JSON.stringify([mark({ prefix: long, suffix: long })]))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.prefix).toHaveLength(MAX_MARK_TEXT)
    expect(parsed[0]?.suffix).toHaveLength(MAX_MARK_TEXT)
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
     * not take the whole Marginalia list down. Asserting "does not throw, returns a
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
     * the Marginalia list stops reading in book order. */
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

    /* One LIVE mark — the replaced row stays as a tombstone so the
     * replacement can travel, and every read model hides it. */
    const live = liveMarks(result)
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe('m2')
    expect(live[0]?.note).toBe('a thought')
    expect(result.find((m) => m.id === 'm1')?.deletedAt).toBeDefined()
  })

  it('keeps a mark at the same anchor in a DIFFERENT book', () => {
    // The anchor alone is not identity: two books can share a CFI.
    const a = mark({ id: 'm1', bookId: 'book-a' })
    const b = mark({ id: 'm2', bookId: 'book-b' })
    expect(upsertMark([a], b)).toHaveLength(2)
  })
})

describe('upsertMark is idempotent by id', () => {
  /* Two rows sharing an id is a state everything downstream assumes cannot
   * happen: `remove(id)` drops every match and `setNote(id)` rewrites every
   * one. `dedupeById` resolves it on load by the merge rule — latest action
   * wins — but the pair should never be written in the first place, which is
   * what this describes. */
  it('replaces a row of the same id rather than tombstoning it and appending a twin', () => {
    const held = mark({ id: 'same', note: 'first' })
    const again = mark({ id: 'same', note: 'second', createdAt: 2000 })

    const next = upsertMark([held], again)

    expect(next).toHaveLength(1)
    expect(next[0]?.note).toBe('second')
    expect(next[0]?.deletedAt).toBeUndefined()
  })

  it('still supersedes a DIFFERENT mark at the same anchor', () => {
    const held = mark({ id: 'a' })
    const other = mark({ id: 'b', createdAt: 2000 })
    const next = upsertMark([held], other)
    expect(next.find((m) => m.id === 'a')?.deletedAt).toBeDefined()
    expect(next.find((m) => m.id === 'b')?.deletedAt).toBeUndefined()
  })
})

describe('marginMarks', () => {
  it('keeps notes and companion marks, and drops bare highlights', () => {
    const bare = annotation({ id: 'bare' })
    const noted = annotation({ id: 'noted', note: 'why this matters' })
    const companion = annotation({ id: 'companion', kind: 'companion' })

    expect(marginMarks([bare, noted, companion]).map((m) => m.id)).toEqual([
      'noted',
      'companion',
    ])
  })

  it('leaves the column collapsed when every mark is a bare highlight', () => {
    // The rule the reader sees: highlighting a line does not open a 250px
    // column to show a dot repeating what the gold fill already says.
    expect(marginMarks([annotation(), annotation({ id: 'm2' })])).toEqual([])
  })
})

describe('updateNote and removeMark', () => {
  it('writes a note onto one mark only', () => {
    const marks = [mark({ id: 'm1' }), mark({ id: 'm2', cfi: 'x' })]
    const next = updateNote(marks, 'm2', 'a note')
    expect(next.find((m) => m.id === 'm1')?.note).toBe('')
    expect(next.find((m) => m.id === 'm2')?.note).toBe('a note')
  })

  it('removes by id — a tombstone in the file, no row in the read model', () => {
    const next = removeMark([mark({ id: 'm1' }), mark({ id: 'm2' })], 'm1')
    // The row STAYS, stamped, so the deletion can travel to another device…
    expect(next).toHaveLength(2)
    expect(next.find((m) => m.id === 'm1')?.deletedAt).toBeDefined()
    // …and every read model hides it.
    expect(liveMarks(next).map((m) => m.id)).toEqual(['m2'])
  })

  it('is the input by identity for an id already deleted or not there', () => {
    const gone = removeMark([mark({ id: 'm1' })], 'm1')
    expect(removeMark(gone, 'm1')).toBe(gone)
    expect(removeMark(gone, 'nobody')).toBe(gone)
  })

  it('leaves a tombstoned row alone on a note edit — resurrection is the merge’s call', () => {
    const gone = removeMark([mark({ id: 'm1' })], 'm1')
    expect(updateNote(gone, 'm1', 'a late thought')).toBe(gone)
  })

  it('stamps a note edit', () => {
    const next = updateNote([mark({ id: 'm1' })], 'm1', 'a note')
    expect(next.find((m) => m.id === 'm1')?.updatedAt).toBeDefined()
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
    /* The FIRST row's position, and `mergeMarks`'s winner. These two carry
       one stamp, so the tie falls to the serialised row — arbitrary, and the
       same arbitrary a peer's merge of the same pair reaches, which is the
       point of the two using one rule. */
    expect(parsed[0]?.bookId).toBe('book-b')
  })

  /* ⚠️ **A TOMBSTONE FIRST AND ITS REPLACEMENT SECOND.** Keeping the first row
     kept the tombstone and discarded the mark written after it — a mark the
     reader could see, gone at the next load, deleted by the deduplicator
     rather than by anybody. `upsertMark` no longer writes such a pair; a store
     from before it stopped still holds them. */
  it('keeps the later action when a duplicate id pairs a tombstone with a replacement', () => {
    const dupe = [
      { ...mark(), id: 'shared', note: 'deleted', deletedAt: '000000001000-0000-aaaaaaaaaaaaaaaa' },
      { ...mark(), id: 'shared', note: 'written after', updatedAt: '000000002000-0000-aaaaaaaaaaaaaaaa' },
    ]
    const parsed = parseMarks(JSON.stringify(dupe))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.note).toBe('written after')
    expect(parsed[0]?.deletedAt).toBeUndefined()
  })

  it('keeps the tombstone when it is the later action', () => {
    const dupe = [
      { ...mark(), id: 'shared', note: 'edited', updatedAt: '000000001000-0000-aaaaaaaaaaaaaaaa' },
      { ...mark(), id: 'shared', note: 'then deleted', deletedAt: '000000002000-0000-aaaaaaaaaaaaaaaa' },
    ]
    const parsed = parseMarks(JSON.stringify(dupe))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.deletedAt).toBe('000000002000-0000-aaaaaaaaaaaaaaaa')
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

describe('the wave belongs to the companion', () => {
  /* Reserving a shape only means something if the store keeps it reserved. The
     reader can no longer CHOOSE a wave, but marks made before that was true are
     on disk — and a reader's mark drawn as a wave says "a machine wrote this"
     about a passage the reader marked themselves. */
  it('reads a reader’s stored wave back as a plain underline', () => {
    const stored = JSON.stringify([{ ...mark(), kind: 'highlight', style: 'wave' }])
    expect(parseMarks(stored)[0]?.style).toBe('underline')
  })

  it('leaves the companion’s own style alone', () => {
    // The painter ignores it and draws amber regardless; nothing needs rewriting.
    const stored = JSON.stringify([{ ...mark(), kind: 'companion', style: 'wave' }])
    expect(parseMarks(stored)[0]?.style).toBe('wave')
  })

  it('does not disturb the styles the reader may still choose', () => {
    for (const style of ['fill', 'underline'] as const) {
      const stored = JSON.stringify([{ ...mark(), kind: 'highlight', style }])
      expect(parseMarks(stored)[0]?.style, style).toBe(style)
    }
  })
})

describe('re-marking a passage keeps what was written about it', () => {
  /* `mark(note, …)` is how every appearance change is applied, and ⌘D and the
     palette both pass an empty note because they are not writing one. Taken
     verbatim that emptied the note on any passage marked a second time — silent
     data loss with no undo. The rule lives in `useMarking`; this pins the store
     behaviour it depends on, which is that a replacement is matched by anchor. */
  it('replaces a mark on the same anchor rather than stacking one', () => {
    const first = mark({ id: 'm1', note: 'worth remembering' })
    const second = mark({ id: 'm2', note: 'worth remembering', tint: 'green' })
    /* ONE LIVE MARK, not one row: the replaced row stays as a tombstone so the
       replacement can travel to another device, and every read model hides it.
       What this pins is the note surviving a recolour, which is the same fact
       either way. */
    const live = liveMarks(upsertMark([first], second))
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe('m2')
    expect(live[0]?.tint).toBe('green')
    expect(live[0]?.note).toBe('worth remembering')
  })

  it('leaves a mark on a different anchor alone', () => {
    const here = mark({ id: 'm1', cfi: 'epubcfi(/6/4!/4/2)' })
    const elsewhere = mark({ id: 'm2', cfi: 'epubcfi(/6/8!/4/2)' })
    expect(liveMarks(upsertMark([here], elsewhere))).toHaveLength(2)
  })
})

/**
 * Bookmarks share the record, the file and the merge with annotations, and
 * share none of their consumers. These are the rules that make the second half
 * of that true — see `MarkKind` for why the two are one type rather than two.
 */
describe('bookmarks and annotations are told apart', () => {
  const highlight = mark({ id: 'h', kind: 'highlight' })
  const claim = mark({ id: 'c', kind: 'companion' })
  const place = mark({ id: 'b', kind: 'bookmark', cfi: 'epubcfi(/6/4!/4/8)' })

  it('splits a mixed list both ways, and nothing falls between them', () => {
    const all = [highlight, place, claim]
    expect(annotationsIn(all).map((m) => m.id)).toEqual(['h', 'c'])
    expect(bookmarksIn(all).map((m) => m.id)).toEqual(['b'])
    expect(annotationsIn(all).length + bookmarksIn(all).length).toBe(all.length)
  })

  /* The no-write convention every store's change detection rests on: a filter
   * that removed nothing must hand back the SAME array, or the store publishes
   * a change nobody can see and writes the file over itself. */
  it('returns its input by identity when there is no bookmark to drop', () => {
    const annotations = [highlight, claim]
    expect(annotationsIn(annotations)).toBe(annotations)
  })

  it('orders bookmarks by section first, then by CFI — `compareMarks`', () => {
    /* BOTH HALVES, and the second is the one that was missing: with every
     * fixture in a different section the CFI comparison never ran, so the test
     * named a rule it did not exercise. The same-section pair is deliberately
     * ordered so that plain string order would get it wrong — `/4/10` sorts
     * before `/4/4` byte by byte, which is the exact defect `compareCfi`
     * exists to avoid. */
    const later = mark({ id: 'b2', kind: 'bookmark', sectionIndex: 3, cfi: 'epubcfi(/6/4!/4/2)' })
    const earlier = mark({ id: 'b1', kind: 'bookmark', sectionIndex: 1, cfi: 'epubcfi(/6/4!/4/9)' })
    expect(bookmarksIn([later, earlier]).map((m) => m.id)).toEqual(['b1', 'b2'])

    const tenth = mark({ id: 'b4', kind: 'bookmark', sectionIndex: 1, cfi: 'epubcfi(/6/4!/4/10)' })
    const fourth = mark({ id: 'b3', kind: 'bookmark', sectionIndex: 1, cfi: 'epubcfi(/6/4!/4/4)' })
    expect(bookmarksIn([tenth, fourth]).map((m) => m.id)).toEqual(['b3', 'b4'])
  })

  /* The line replacement respects, and it is NOT `kind === kind`: a reader
   * marking over the companion's claim replaces it, and always has. */
  it('puts the companion on the reader’s side of the line, and a bookmark alone on the other', () => {
    expect(sameClass(highlight, claim)).toBe(true)
    expect(sameClass(highlight, place)).toBe(false)
    expect(sameClass(claim, place)).toBe(false)
  })

  /* THE FAILURE THIS PREVENTS: a bookmark anchors to the visible page, so it
   * shares an anchor with whatever is highlighted on that page as a matter of
   * course. Without the class guard the two take turns deleting each other,
   * silently and with no undo. */
  it('does not let a bookmark and a highlight at one anchor supersede each other', () => {
    /* BOTH ROWS LIVE AFTER EACH INSERTION, not merely "the old one was not
       tombstoned": dropping the INCOMING row entirely would have satisfied that
       weaker assertion while losing the mark the reader just made. */
    const kept = upsertMark([highlight], mark({ id: 'b', kind: 'bookmark' }))
    expect(liveMarks(kept).map((m) => m.id).sort()).toEqual(['b', 'h'])

    const back = upsertMark([place], mark({ id: 'h2', cfi: place.cfi }))
    expect(liveMarks(back).map((m) => m.id).sort()).toEqual(['b', 'h2'])
  })

  it('still replaces a bookmark with a bookmark at the same anchor', () => {
    const replaced = upsertMark([place], mark({ id: 'b2', kind: 'bookmark', cfi: place.cfi }))
    expect(replaced.find((m) => m.id === 'b')?.deletedAt).toBeDefined()
  })

  /* A bookmark must never reach the margin, and it no longer CAN: `marginMarks`
   * takes `readonly Annotation[]`, so handing it one is a compile error rather
   * than a filtered row — the guarantee moved out of this assertion and into
   * the signature. What is left to assert is the SECOND barrier, the one that
   * is still a runtime predicate: `marginMarks` admits a mark for its note or
   * for being the companion's, and a bookmark is neither. Both halves are
   * asserted against the predicate itself rather than read off a fixture's
   * fields, which was the old version's weakness — it checked that the bookmark
   * builder writes an empty note, which is `bookmarkFrom`'s own test, and never
   * asked what the margin does with one. */
  it('would still keep a bookmark out of the margin if one reached the predicate', () => {
    /* THE BOOKMARK IS ACTUALLY PUT THROUGH IT. Asserting that a bookmark
       fixture has an empty note is `bookmarkFrom`'s test, not this one, and it
       never asks the margin anything — which is what the previous version of
       this did. The cast is the point rather than a shortcut: it stages
       precisely the thing the type system now forbids, so what is left of the
       runtime guard can be held to its promise. */
    expect(marginMarks([place as Annotation])).toEqual([])

    /* And the guard is a real filter rather than one that drops everything:
       both ways IN are open to what they are for — something the reader wrote,
       and the companion's claim, which earns its place with or without a note. */
    expect(marginMarks([annotation({ id: 'n', note: 'said' })]).map((m) => m.id)).toEqual(['n'])
    expect(marginMarks([annotation({ id: 'c', kind: 'companion' })]).map((m) => m.id)).toEqual(['c'])
    expect(marginMarks([annotation({ id: 'q', note: '' })])).toEqual([])
  })
})

describe('openingLine', () => {
  it('collapses every run of whitespace to one space and trims the ends', () => {
    expect(openingLine('  a\n\n b \t c  ')).toBe('a b c')
  })

  /* A string index is a UTF-16 UNIT, so `slice(0, 140)` can land between the
   * halves of a surrogate pair and store a lone surrogate — a character that
   * is not a character, written to disk and sent over the wire. The emoji here
   * straddles the limit deliberately. */
  it('never cuts a character in half', () => {
    const cut = openingLine('x'.repeat(BOOKMARK_TEXT_MAX - 1) + '\u{1F4D6}' + 'tail')
    expect([...cut]).toHaveLength(BOOKMARK_TEXT_MAX)
    expect(cut.endsWith('\u{1F4D6}')).toBe(true)
    // No unpaired surrogate survived the cut.
    expect(cut).toBe(cut.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/gu, ''))
  })

  it('is idempotent, so a row normalised on the way in survives a second pass', () => {
    const once = openingLine('  a \n b  ')
    expect(openingLine(once)).toBe(once)
  })
})

describe('bookmarkFrom', () => {
  const draft = {
    bookId: 'book-a',
    cfi: 'epubcfi(/6/4!/4/2)',
    sectionIndex: 2,
    text: 'Call me Ishmael',
    prefix: 'before',
    suffix: 'after',
    chapter: 'Ch. 1',
  }

  it('makes a bookmark that carries no note and no appearance', () => {
    const made = bookmarkFrom(draft)
    expect(made.kind).toBe('bookmark')
    expect(made.note).toBe('')
    /* Exactly what a row WITHOUT these fields reads back as — see `readTint`
     * and `readStyle`. Nothing paints a bookmark, so the honest value is the
     * one that says nothing. */
    expect(made.tint).toBe('yellow')
    expect(made.style).toBe('fill')
  })

  /* A highlight's text is what the reader selected. A bookmark's is whatever
   * was on screen — a whole page — and storing that puts a screenful of prose
   * into `marks.json` and onto the wire for every bookmark. */
  it('keeps only the opening line of the page it was made on', () => {
    const long = bookmarkFrom({ ...draft, text: 'x'.repeat(BOOKMARK_TEXT_MAX * 3) })
    expect(long.text).toHaveLength(BOOKMARK_TEXT_MAX)
  })

  it('collapses the page’s own layout before spending the budget on it', () => {
    /* The shape a real capture arrives in — the text is walked out of rendered
     * markup, so it carries that markup's newlines and indentation. Cutting
     * first spent a quarter of the allowance on whitespace. */
    const ragged = bookmarkFrom({ ...draft, text: '\n  y\n + ing \u279a\n   simplify\n ing\n' })
    expect(ragged.text).toBe('y + ing \u279a simplify ing')
  })

  it('leaves the anchor, the section and the chapter exactly as given', () => {
    const made = bookmarkFrom(draft)
    expect(made.cfi).toBe(draft.cfi)
    expect(made.sectionIndex).toBe(draft.sectionIndex)
    expect(made.chapter).toBe(draft.chapter)
    expect([made.prefix, made.suffix]).toEqual(['before', 'after'])
  })

  /* THE COMPATIBILITY FAILURE THIS GUARDS: `validMarks` filters rather than
   * throws, so a validator that did not know the kind would drop every
   * bookmark on disk on the first load after the upgrade, in silence. */
  it('survives a round trip through storage', () => {
    const stored = parseMarks(JSON.stringify([{ ...bookmarkFrom(draft), id: 'b', createdAt: 5 }]))
    expect(stored).toHaveLength(1)
    expect(stored[0]?.kind).toBe('bookmark')
  })
})

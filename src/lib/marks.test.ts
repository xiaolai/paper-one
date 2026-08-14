import { describe, expect, it } from 'vitest'
import {
  MARKS_STORAGE_KEY,
  bookIdFor,
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
    note: '',
    kind: 'highlight',
    chapter: 'Ch. 1',
    createdAt: 1000,
    ...over,
  }
}

/** A storage double, with a switch for the failure the reader must be told about. */
function fakeStorage(initial: string | null = null, failWrites = false): MarkStorage & {
  value: string | null
} {
  const store = {
    value: initial,
    getItem: () => store.value,
    setItem: (_key: string, value: string) => {
      if (failWrites) throw new Error('QuotaExceededError')
      store.value = value
    },
  }
  return store
}

describe('bookIdFor', () => {
  it('uses the URL for a book already on disk', () => {
    expect(bookIdFor('https://example.com/moby.epub')).toBe(
      'url:https://example.com/moby.epub',
    )
  })

  it('identifies a picked file by name and size, so re-picking it finds its marks', () => {
    const first = new File(['abcd'], 'moby.epub')
    const second = new File(['abcd'], 'moby.epub')
    // A different File object for the same book on disk — the case that makes
    // object identity useless as a key.
    expect(bookIdFor(first)).toBe(bookIdFor(second))
  })

  it('separates different books', () => {
    expect(bookIdFor(new File(['a'], 'a.epub'))).not.toBe(
      bookIdFor(new File(['b'], 'b.epub')),
    )
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

  it('writes under the versioned key', () => {
    const storage = fakeStorage()
    let seen = ''
    saveMarks({ getItem: () => null, setItem: (key) => (seen = key) }, [mark()])
    expect(seen).toBe(MARKS_STORAGE_KEY)
    expect(storage.value).toBeNull()
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

import { describe, expect, it, vi } from 'vitest'
import { asIndexedBook, createRemoteBooks, parseRows } from './books'
import type { BookRow } from '../../kernel'
import type { ShelfChannel } from './channel'

/** A channel a test answers for. */
function fakeChannel(answers: () => unknown) {
  let onClosed: ((reason: 'closed' | 'lost' | 'refused') => void) | null = null
  const channel: ShelfChannel = {
    call: async () => answers(),
    /* `book.list` is a STREAM in the service table, so the fake answers as one.
       It used to answer `call`, which meant every test agreed with a client
       that asked the wrong question and got "protocol: stream frame for a
       plain call" from the real router. */
    stream: () => ({
      [Symbol.asyncIterator]: async function* () {
        const answer = answers()
        if (Array.isArray(answer)) for (const row of answer) yield row
        else yield answer
      },
    }),
    close: () => {},
    onClosed: (fn) => {
      onClosed = fn
      return () => {
        onClosed = null
      }
    },
  }
  return { channel, drop: () => onClosed?.('lost') }
}

/* `bookId`, as `services/rows.ts` names it. These fixtures said `id` and so did
   the parser, so every test agreed with the bug and the shelf rendered nothing.
   A fixture is only as true as the guess behind it. */
const TWO = [
  { bookId: 'a', title: 'Moby-Dick', author: 'Melville' },
  { bookId: 'b', title: 'The Silk Roads' },
]

/** Let the constructor's own refresh settle. */
const settled = () => new Promise((r) => setTimeout(r, 0))

describe('parseRows', () => {
  it('drops a row with no id, because React keys on it', () => {
    /* A missing or duplicate key is a rendering bug three screens from its
       cause. Better to lose a malformed row than to render one. */
    const kept = parseRows([{ title: 'no id' }, { bookId: '', title: 'empty' }, { bookId: 'a', title: 'A' }])
    expect(kept.map((r) => r.bookId)).toEqual(['a'])
  })

  /**
   * ⚠️ **THE COMMENT ABOVE NAMES A DUPLICATE AND THE TEST ONLY COVERED
   * MISSING.** They are not the same failure and only one of them was held.
   *
   * React resolves a duplicate key by rendering one element and discarding the
   * other, so a shelf that sends the same book twice makes a book VANISH from
   * the shelf — no error, no warning a reader could see, and the cause three
   * screens away. `marks.ts` and `cards.ts` both pin this; `books.ts` is the
   * one a reader looks at first.
   */
  it('keeps the first of two rows sharing an id', () => {
    const kept = parseRows([
      { bookId: 'a', title: 'First' },
      { bookId: 'b', title: 'Other' },
      { bookId: 'a', title: 'Second' },
    ])
    expect(kept.map((r) => r.bookId)).toEqual(['a', 'b'])
    expect(kept[0]?.title, 'the first row wins, so the order the shelf sent is kept').toBe('First')
  })

  it('survives an answer that is not a list at all', () => {
    /* A version skew, a proxy error page decoded as JSON, a shelf answering
       something this build does not know. None of them should throw inside a
       store a view is reading. */
    for (const junk of [null, undefined, 42, 'rows', { rows: [] }]) {
      expect(parseRows(junk)).toEqual([])
    }
  })

  it('keeps only fields it understands, and refuses a value of the wrong type', () => {
    const [row] = parseRows([{ bookId: 'a', title: 'A', author: 'M', extra: 'ignored', progress: 'x' }])
    expect(row).toMatchObject({ bookId: 'a', title: 'A', author: 'M' })
    expect(row).not.toHaveProperty('extra')
    /* `progress: 'x'` IS NOT 0-BY-COERCION. A number where a string belongs is
       a shelf disagreeing with this client about the wire; `Number(x)` would
       hide that behind a plausible row. It falls back to the field's own
       default, and the default is documented rather than inferred. */
    expect(row?.progress).toBe(0)
  })

  /**
   * EVERY FIELD THE WIRE SENDS SURVIVES THE PARSE.
   *
   * This is the regression that mattered: the client's row had FIVE fields
   * while `services/rows.ts` sent EIGHTEEN, so `tags`, `subjects`, `series`,
   * `addedAt`, `openedAt`, `format` and `hasContent` arrived and were dropped
   * on the floor. The shelf could not filter by tag or sort by date — not
   * because the shelf did not know, but because this function threw the answer
   * away, silently, and the type agreed with it.
   */
  it('keeps every field the wire carries', () => {
    const wire = {
      bookId: 'a',
      title: 'A',
      author: 'M',
      identifier: 'urn:isbn:9780142437247',
      series: 'S',
      seriesIndex: 2,
      publisher: 'P',
      published: '2020',
      languages: ['en'],
      subjects: ['history'],
      tags: ['unread'],
      position: 'epubcfi(/6/2)',
      progress: 0.5,
      finished: true,
      status: 'reading',
      rating: 4,
      review: 'a whale of a book',
      statusAt: null,
      ratingAt: null,
      reviewAt: null,
      addedAt: 111,
      openedAt: 222,
      format: 'epub',
      contentHash: 'ab'.repeat(32),
      hasContent: true,
    }
    expect(parseRows([wire])[0]).toEqual(wire)
  })

  /* THREE STATES, NOT TWO. `hasContent` is present / absent / never measured,
     and collapsing the third into "absent" reads as a definite answer this
     client has no grounds to give — a satchel deciding whether to offer
     Download cares about the difference. */
  it('keeps hasContent unmeasured rather than calling it absent', () => {
    expect(parseRows([{ bookId: 'a', title: 'A' }])[0]?.hasContent).toBeNull()
    expect(parseRows([{ bookId: 'a', hasContent: false }])[0]?.hasContent).toBe(false)
    expect(parseRows([{ bookId: 'a', hasContent: 'yes' }])[0]?.hasContent).toBeNull()
  })

  it('refuses a format it does not know', () => {
    expect(parseRows([{ bookId: 'a', format: 'epub' }])[0]?.format).toBe('epub')
    expect(parseRows([{ bookId: 'a', format: 'docx' }])[0]?.format).toBeNull()
  })

  it('keeps only the strings out of a list, rather than the list or nothing', () => {
    expect(parseRows([{ bookId: 'a', tags: ['x', 7, null, 'y'] }])[0]?.tags).toEqual(['x', 'y'])
    expect(parseRows([{ bookId: 'a', tags: 'x' }])[0]?.tags).toEqual([])
  })
})

describe('createRemoteBooks', () => {
  it('loads the shelf and reports ready', async () => {
    const { channel } = fakeChannel(() => TWO)
    const books = createRemoteBooks(channel)
    expect(books.status()).toBe('loading')
    await settled()
    expect(books.status()).toBe('ready')
    expect(books.getSnapshot().map((b) => b.bookId)).toEqual(['a', 'b'])
  })

  it('returns THE SAME array until the content changes', async () => {
    /* THE RULE THIS FILE EXISTS TO KEEP. `useSyncExternalStore` compares by
       identity: a fresh array each call makes React re-render, re-read, see a
       new array and re-render again — for ever, at full speed, with no error
       anywhere. It presents as the app hanging and nothing in the network layer
       looks wrong. */
    let answer: unknown = TWO
    const { channel } = fakeChannel(() => answer)
    const books = createRemoteBooks(channel)
    await settled()

    const first = books.getSnapshot()
    expect(books.getSnapshot()).toBe(first)

    // An identical answer must not produce a new array.
    await books.refresh()
    expect(books.getSnapshot()).toBe(first)

    // A different answer must.
    answer = [...TWO, { bookId: 'c', title: 'Third' }]
    await books.refresh()
    expect(books.getSnapshot()).not.toBe(first)
    expect(books.getSnapshot()).toHaveLength(3)
  })

  it('does not wake subscribers when nothing changed', async () => {
    /* The other half of the same rule: a poll that finds nothing new should
       cost no render. */
    const { channel } = fakeChannel(() => TWO)
    const books = createRemoteBooks(channel)
    await settled()

    const woken = vi.fn()
    books.subscribe(woken)
    await books.refresh()
    expect(woken).not.toHaveBeenCalled()
  })

  it('wakes subscribers exactly once per change', async () => {
    let answer: unknown = TWO
    const { channel } = fakeChannel(() => answer)
    const books = createRemoteBooks(channel)
    await settled()

    const woken = vi.fn()
    books.subscribe(woken)
    answer = [{ bookId: 'z', title: 'Only' }]
    await books.refresh()
    expect(woken).toHaveBeenCalledTimes(1)
  })

  it('keeps the books on screen when the shelf goes away', async () => {
    /* Emptying the list on disconnect tells a reader their library vanished,
       which is alarming and false. The books stay; the STATUS changes. */
    const { channel, drop } = fakeChannel(() => TWO)
    const books = createRemoteBooks(channel)
    await settled()

    drop()
    expect(books.status()).toBe('stale')
    expect(books.getSnapshot()).toHaveLength(2)
  })

  it('reports failed when nothing was ever loaded', async () => {
    /* Distinct from `stale`: there is nothing to show, so a view must say
       something different from "these are the books, but old". */
    const { channel } = fakeChannel(() => {
      throw new Error('disconnected')
    })
    const books = createRemoteBooks(channel)
    /* ⚠️ **SUBSCRIBED BEFORE THE FAILURE**, because the number of publishes is
     * half of what this path gets wrong. It used to set the status AND publish
     * unconditionally, so every failure woke every subscriber twice for one
     * piece of news — invisible to an assertion about `status()`, and a double
     * render of the whole shelf on a library of two thousand. */
    const woke = vi.fn()
    books.subscribe(woke)
    await settled()
    expect(books.status()).toBe('failed')
    expect(books.getSnapshot()).toEqual([])
    expect(woke, 'one failure is one piece of news').toHaveBeenCalledTimes(1)

    /* AND A SECOND FAILURE PUBLISHES NOTHING AT ALL: the status did not move,
       so there is nothing to tell anyone. */
    woke.mockClear()
    await books.refresh()
    expect(woke, 'a status that did not change must not re-render the shelf').not.toHaveBeenCalled()
    expect(books.status()).toBe('failed')
  })

  it('goes stale rather than failed when a refresh fails after a good load', async () => {
    let ok = true
    const { channel } = fakeChannel(() => {
      if (!ok) throw new Error('disconnected')
      return TWO
    })
    const books = createRemoteBooks(channel)
    await settled()
    ok = false
    await books.refresh()
    expect(books.status()).toBe('stale')
    expect(books.getSnapshot()).toHaveLength(2)
  })

  it('recovers to ready when the shelf comes back', async () => {
    let ok = true
    const { channel } = fakeChannel(() => {
      if (!ok) throw new Error('disconnected')
      return TWO
    })
    const books = createRemoteBooks(channel)
    await settled()
    ok = false
    await books.refresh()
    expect(books.status()).toBe('stale')

    ok = true
    await books.refresh()
    expect(books.status()).toBe('ready')
  })

  it('says nothing more after dispose', async () => {
    /* A late answer landing after the view unmounted must not wake a listener
       that no longer has anywhere to render. */
    /* Held in an object: assigned inside a promise executor, TypeScript's flow
       analysis narrows a bare `let` to `null` at the call site below. */
    const held: { release: ((value: unknown) => void) | null } = { release: null }
    const { channel } = fakeChannel(() => new Promise((r) => (held.release = r)))
    const books = createRemoteBooks(channel)
    const woken = vi.fn()
    books.subscribe(woken)

    books.dispose()
    held.release?.(TWO)
    await settled()
    expect(woken).not.toHaveBeenCalled()
  })

  it('stops listening to the channel on dispose', async () => {
    const { channel, drop } = fakeChannel(() => TWO)
    const books = createRemoteBooks(channel)
    await settled()
    books.dispose()
    drop()
    expect(books.status()).toBe('ready')
  })
})

describe('what wakes the shelf', () => {
  it('publishes when a register’s stamp moves with nothing else, and once more when a failure’s reason changes', async () => {
    let answer: unknown = TWO
    const { channel } = fakeChannel(() => {
      if (answer instanceof Error) throw answer
      return answer
    })
    const books = createRemoteBooks(channel)
    const told = vi.fn()
    books.subscribe(told)
    await settled()
    const before = told.mock.calls.length
    /* The same rows with one stamp moved: a re-render, because the stamp is the register. */
    answer = TWO.map((row, i) => (i === 0 ? { ...row, rating: 4, ratingAt: '018bcfe56809-0000-1d8865efc2eaef44' } : row))
    await books.refresh()
    expect(told.mock.calls.length).toBe(before + 1)
    answer = TWO.map((row, i) => (i === 0 ? { ...row, rating: 4, ratingAt: '018bcfe56809-0001-1d8865efc2eaef44' } : row))
    await books.refresh()
    expect(told.mock.calls.length).toBe(before + 2)
    /* Two failures, two reasons: each is news. The same reason twice is not. */
    answer = new Error('first reason')
    await books.refresh()
    const failed = told.mock.calls.length
    expect(books.status()).toBe('stale')
    answer = new Error('second reason')
    await books.refresh()
    expect(told.mock.calls.length).toBe(failed + 1)
    await books.refresh()
    expect(told.mock.calls.length).toBe(failed + 1)
  })
})

describe('the opinion stamps off the wire', () => {
  it('keeps a stamp that is an HLC and reads any other as no stamp', () => {
    const [row] = parseRows([{ bookId: 'a', title: 'A', statusAt: '018bcfe56809-0000-1d8865efc2eaef44', ratingAt: 'yesterday', reviewAt: 5 }])
    expect(row!.statusAt).toBe('018bcfe56809-0000-1d8865efc2eaef44')
    expect(row!.ratingAt).toBeNull()
    expect(row!.reviewAt).toBeNull()
  })
})

describe('progress off the wire', () => {
  it('is held to a fraction of the book', () => {
    const [over, under, nan, fine] = parseRows([
      { bookId: 'a', title: 'A', progress: 7 },
      { bookId: 'b', title: 'B', progress: -1 },
      { bookId: 'c', title: 'C', progress: Number.NaN },
      { bookId: 'd', title: 'D', progress: 0.25 },
    ])
    expect([over!.progress, under!.progress, nan!.progress, fine!.progress]).toEqual([1, 0, 0, 0.25])
  })
})

describe('a row projected onto the shelf', () => {
  const row = (over: Partial<BookRow> = {}): BookRow =>
    ({ bookId: 'a', title: 'A', author: '', identifier: '', series: '', seriesIndex: null, publisher: '', published: '', languages: [], subjects: [], tags: [], position: null, progress: 0, finished: false, status: null, statusAt: null, rating: null, ratingAt: null, review: null, reviewAt: null, addedAt: null, openedAt: null, format: null, contentHash: null, hasContent: null, ...over }) as BookRow
  const HLC = '018bcfe56809-0000-1d8865efc2eaef44'

  it('carries each opinion register only when the row has both its value and its stamp', () => {
    const whole = asIndexedBook(row({ status: 'reading', statusAt: HLC, rating: 4, ratingAt: HLC, review: 'r', reviewAt: HLC }))
    expect(whole.status).toEqual({ state: 'reading', at: HLC })
    expect(whole.rating).toBe(4)
    expect(whole.ratingAt).toBe(HLC)
    expect(whole.review).toEqual({ text: 'r', at: HLC })
    const unstamped = asIndexedBook(row({ status: 'reading', statusAt: null, rating: 4, ratingAt: null, review: 'r', reviewAt: null }))
    expect(unstamped.status).toBeUndefined()
    expect(unstamped.rating).toBe(4)
    expect('ratingAt' in unstamped).toBe(false)
    expect(unstamped.review).toBeUndefined()
    const unsaid = asIndexedBook(row({ status: null, statusAt: HLC, rating: null, ratingAt: HLC, review: null, reviewAt: HLC }))
    expect(unsaid.status).toBeUndefined()
    expect('rating' in unsaid).toBe(false)
    expect(unsaid.review).toBeUndefined()
  })
})

describe('two snapshots that say the same thing', () => {
  it('are one snapshot, list fields included — and a list that differs is a change', async () => {
    let answer: unknown[] = [{ bookId: 'a', title: 'A', languages: ['en', 'fr'], tags: ['x'] }]
    const { channel } = fakeChannel(() => answer)
    const books = createRemoteBooks(channel)
    await settled()
    const first = books.getSnapshot()
    await books.refresh()
    expect(books.getSnapshot()).toBe(first)
    answer = [{ bookId: 'a', title: 'A', languages: ['en', 'de'], tags: ['x'] }]
    await books.refresh()
    expect(books.getSnapshot()).not.toBe(first)
    expect(books.getSnapshot()[0]!.languages).toEqual(['en', 'de'])
    answer = [{ bookId: 'a', title: 'A', languages: ['en'], tags: ['x'] }]
    await books.refresh()
    expect(books.getSnapshot()[0]!.languages).toEqual(['en'])
  })
})

describe('what makes two rows differ', () => {
  const HLC = '018bcfe56809-0000-1d8865efc2eaef44'
  const HLC2 = '018bcfe56810-0000-1d8865efc2eaef44'
  const base = { bookId: 'a', title: 'A', status: 'reading', statusAt: HLC, rating: 4, ratingAt: HLC, review: 'r', reviewAt: HLC }
  for (const [field, value] of [['status', 'want'], ['statusAt', HLC2], ['rating', 5], ['ratingAt', HLC2], ['review', 'other'], ['reviewAt', HLC2]] as const) {
    it(`a change of ${field} alone is a new snapshot`, async () => {
      let answer: unknown[] = [base]
      const { channel } = fakeChannel(() => answer)
      const books = createRemoteBooks(channel)
      await settled()
      const first = books.getSnapshot()
      await books.refresh()
      expect(books.getSnapshot()).toBe(first)
      answer = [{ ...base, [field]: value }]
      await books.refresh()
      expect(books.getSnapshot()).not.toBe(first)
    })
  }

  it('keeps a review stamp that is an HLC', () => {
    const [row] = parseRows([{ bookId: 'a', title: 'A', reviewAt: HLC }])
    expect(row!.reviewAt).toBe(HLC)
  })

  it('carries a format and a content hash only when the row has them', () => {
    const digest = 'ab'.repeat(32)
    const with_ = asIndexedBook(parseRows([{ bookId: 'a', title: 'A', format: 'epub', contentHash: digest }])[0]!)
    expect(with_.format).toBe('epub')
    expect(with_.contentHash).toBe(digest)
    const without = asIndexedBook(parseRows([{ bookId: 'a', title: 'A' }])[0]!)
    expect('format' in without).toBe(false)
    expect('contentHash' in without).toBe(false)
  })

  /* THE KERNEL'S ONE DIGEST RULE, at the browser's door too. This fixture
     used to be `'h'`, and `'h'` went through: a shelf's malformed hash became
     the shelf's cache generation, which no real digest could ever equal. */
  it('reads a content hash only when it is a BLAKE3 digest, as the record and the sync wire do', () => {
    const [short, upper, fine] = parseRows([
      { bookId: 'a', title: 'A', contentHash: 'h' },
      { bookId: 'b', title: 'B', contentHash: 'AB'.repeat(32) },
      { bookId: 'c', title: 'C', contentHash: 'ab'.repeat(32) },
    ])
    expect([short!.contentHash, upper!.contentHash, fine!.contentHash]).toEqual([null, null, 'ab'.repeat(32)])
  })

  it('reads a status only from the kernel’s own vocabulary', () => {
    const [want, other] = parseRows([
      { bookId: 'a', title: 'A', status: 'want' },
      { bookId: 'b', title: 'B', status: 'abandoned' },
    ])
    expect([want!.status, other!.status]).toEqual(['want', null])
  })
})

/* ONE FACT, NOT TWO. With a status on the wire, `finished` follows it and
   is stamped by it, as every kernel writer spells it; the legacy flag speaks
   only for a row with no status. A row saying `reading` beside `finished:
   true` used to project a record that said both. */
describe('finished, projected from the row', () => {
  const HLC = '018bcfe56809-0000-1d8865efc2eaef44'
  const row = (over: Record<string, unknown>) => asIndexedBook(parseRows([{ bookId: 'a', title: 'A', ...over }])[0]!)

  it('follows the status when there is one, stamped by it, whatever the legacy flag said', () => {
    const reading = row({ status: 'reading', statusAt: HLC, finished: true })
    expect(reading.finished).toBe(false)
    expect(reading.finishedAt).toBe(HLC)
    const done = row({ status: 'finished', statusAt: HLC, finished: false })
    expect(done.finished).toBe(true)
    expect(done.finishedAt).toBe(HLC)
  })

  it('keeps the legacy flag, unstamped, for a row with no status or no stamp', () => {
    const legacy = row({ finished: true })
    expect(legacy.finished).toBe(true)
    expect('finishedAt' in legacy).toBe(false)
    const unstamped = row({ status: 'reading', finished: true })
    expect(unstamped.finished).toBe(true)
    expect('finishedAt' in unstamped).toBe(false)
  })
})

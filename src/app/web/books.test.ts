import { describe, expect, it, vi } from 'vitest'
import { createRemoteBooks, parseRows } from './books'
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
      addedAt: 111,
      openedAt: 222,
      format: 'epub',
      contentHash: 'h',
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
    await settled()
    expect(books.status()).toBe('failed')
    expect(books.getSnapshot()).toEqual([])
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

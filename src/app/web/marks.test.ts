import { describe, expect, it, vi } from 'vitest'
import type { ShelfChannel } from './channel'
import { asMark, createRemoteMarks, parseMarks } from './marks'

/**
 * The shelf's marks, over the channel.
 *
 * `prefix`/`suffix` — the recovery context — were absent from the wire until
 * phase 19 and an earlier version of this file pinned them EMPTY. They are on
 * the wire now; `asMark` carries them through rather than inventing them.
 */

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm1',
  bookId: 'b1',
  cfi: 'epubcfi(/6/2)',
  sectionIndex: 1,
  text: 'the whale',
  prefix: '',
  suffix: '',
  note: '',
  kind: 'highlight',
  tint: 'yellow',
  style: 'fill',
  chapter: 'One',
  createdAt: 10,
  ...over,
})

/** A shelf that answers `mark.list` with these rows, one page. */
function shelfOf(rows: readonly Record<string, unknown>[], onCall?: (s: string, b: unknown) => void) {
  return {
    call: async (service: string, body: unknown) => {
      onCall?.(service, body)
      return null
    },
    stream: (service: string, body: unknown) => ({
      [Symbol.asyncIterator]: async function* () {
        onCall?.(service, body)
        yield rows
      },
    }),
    close: () => {},
  } as unknown as ShelfChannel
}

/** A shelf whose every read waits for the test to hand it the rows it answers with. */
function gatedShelf() {
  const reads: ((rows: readonly Record<string, unknown>[]) => void)[] = []
  const channel = {
    call: async () => null,
    stream: () => ({
      [Symbol.asyncIterator]: async function* () {
        yield await new Promise<readonly Record<string, unknown>[]>((land) => reads.push(land))
      },
    }),
    close: () => {},
  } as unknown as ShelfChannel
  return { channel, reads }
}

const settled = () => new Promise((r) => setTimeout(r, 0))

/** What a reader supplies to make a highlight — every field distinct, so a body that swaps two is seen. */
const DRAFT = {
  bookId: 'b1',
  cfi: 'epubcfi(/6/4)',
  sectionIndex: 2,
  text: 'a new passage',
  prefix: 'is ',
  suffix: ' here',
  note: 'mine',
  tint: 'green',
  chapter: 'Two',
} as const

describe('asMark', () => {
  it('carries every field the wire sends', () => {
    expect(asMark(row() as never)).toMatchObject({
      id: 'm1',
      bookId: 'b1',
      text: 'the whale',
      kind: 'highlight',
      tint: 'yellow',
      chapter: 'One',
      createdAt: 10,
    })
  })

  /**
   * THE RECOVERY CONTEXT COMES THROUGH.
   *
   * `prefix`/`suffix` are the words either side of the marked text, kept so a
   * mark can be found again when its CFI stops resolving. The wire did not
   * carry them until phase 19, and this test then pinned that they were EMPTY
   * — which was honest about the wire and silent about the defect. They are
   * carried now, both ways, and a mark read here has what a desktop-made one
   * has.
   */
  it('keeps the recovery context the wire now carries', () => {
    const mark = asMark(row({ prefix: 'the ', suffix: ' calls' }) as never)
    expect(mark.prefix).toBe('the ')
    expect(mark.suffix).toBe(' calls')
  })
})

describe('parseMarks', () => {
  it('reads the rows a page carries', () => {
    expect(parseMarks([row(), row({ id: 'm2' })]).map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  /* AN ID AND A BOOK OR IT IS NOT A MARK: React keys on the first and every
     view groups by the second.
     ⚠️ THE BOOKLESS ROW USED TO SHARE `m1` WITH THE GOOD ONE, so a parser that
     let it through still answered `['m1']` — the duplicate rule dropped the
     good row instead. Its own id is what makes a missed drop visible. */
  it('drops a row with no id or no book', () => {
    expect(parseMarks([row({ id: '' }), row({ id: 'm2', bookId: undefined }), row()]).map((m) => m.id)).toEqual(['m1'])
  })

  it('survives an answer that is not a list', () => {
    for (const junk of [null, undefined, 7, 'rows', { rows: [] }]) expect(parseMarks(junk)).toEqual([])
  })

  /* NOT AN OBJECT IS NOT A ROW, `null` and `undefined` included — and a call
     that resolves nothing hands `add` exactly `[undefined]`. Reading a field off
     either throws, which would lose every good row beside it. */
  it('skips an item that is not an object and reads the rows beside it', () => {
    expect(parseMarks([null, undefined, 7, 'm1', row()]).map((m) => m.id)).toEqual(['m1'])
  })

  /* `null` IS HOW JSON SPELLS AN ABSENT VALUE. A row carrying `unplaced: null`
     is a placed mark with no record of being unplaced, not a row to throw on. */
  it('reads a row whose unplaced is null as a placed mark', () => {
    const [mark] = parseMarks([row({ unplaced: null })])
    expect(mark?.cfi).toBe('epubcfi(/6/2)')
    expect(mark).not.toHaveProperty('unplaced')
  })

  /**
   * ⚠️ **EVERY FIELD IS READ, AND TWO USED TO BE.**
   *
   * This checked `id` and `bookId` and cast the rest straight into `MarkRow`,
   * so the wrong TYPE in any of the other eleven reached the view: an
   * object-valued `text` renders by throwing, a string `createdAt` sorts
   * lexically against numbers, and a `kind` outside the three the client knows
   * falls through every switch to nothing. The row looked valid because the two
   * fields anybody had thought about were.
   */
  it('drops a row whose field is the wrong type, rather than passing it on', () => {
    const wrong: readonly Record<string, unknown>[] = [
      row({ text: { toString: () => 'no' } }),
      row({ createdAt: '10' }),
      row({ sectionIndex: 'one' }),
      row({ note: 42 }),
      row({ chapter: null }),
      row({ cfi: 7 }),
    ]
    for (const bad of wrong) {
      expect(parseMarks([bad]), JSON.stringify(Object.keys(bad))).toEqual([])
    }
  })

  /* A CLOSED DOMAIN IS CLOSED. An unknown value here is a shelf and a client
     disagreeing about the wire, which is worth seeing rather than rendering. */
  it('drops a row whose kind, tint or style is not one this build knows', () => {
    expect(parseMarks([row({ kind: 'scribble' })])).toEqual([])
    expect(parseMarks([row({ tint: 'chartreuse' })])).toEqual([])
    expect(parseMarks([row({ style: 'sparkle' })])).toEqual([])
  })

  /* …and recovery context genuinely may be absent: a mark made before phase 19
     carries none, so these two default rather than drop. */
  it('accepts a row with no prefix or suffix, which an older mark has', () => {
    const [mark] = parseMarks([row({ prefix: undefined, suffix: undefined })])
    expect(mark?.prefix).toBe('')
    expect(mark?.suffix).toBe('')
  })

  /**
   * A REPEATED ID LOSES A ROW IN THE RECONCILER. React resolves a duplicate key
   * by rendering one and discarding the other, so a shelf sending the same mark
   * twice makes one disappear three screens from the cause.
   */
  it('keeps the first of two rows sharing an id', () => {
    const rows = parseMarks([row({ text: 'first' }), row({ text: 'second' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toBe('first')
  })
})

describe('createRemoteMarks', () => {
  /* NO `book`, which the service reads as every book — the fact that makes this
     pane worth mounting at all. One call, not one per book. */
  it('asks for every book’s marks, not one book’s', async () => {
    const asked: { service: string; body: unknown }[] = []
    createRemoteMarks(shelfOf([row()], (service, body) => asked.push({ service, body })))
    await settled()
    expect(asked[0]).toEqual({ service: 'mark.list', body: {} })
  })

  it('splits annotations from bookmarks', async () => {
    const store = createRemoteMarks(shelfOf([row(), row({ id: 'm2', kind: 'bookmark' })]))
    await settled()
    expect(store.all.map((m) => m.id)).toEqual(['m1'])
    expect(store.allBookmarks.map((m) => m.id)).toEqual(['m2'])
  })

  /**
   * THE SAME ARRAY UNTIL SOMETHING CHANGES — `getSnapshot`'s contract. Filtering
   * in the getter hands React a new array every look, and `useSyncExternalStore`
   * reads it on every render: a new identity is an infinite re-render loop.
   *
   * ⚠️ **THIS READ THE GETTER TWICE WITH NOTHING IN BETWEEN**, which is true of
   * any expression that is not literally `[...x]` — a filter would have had to
   * run twice within one statement to fail it, and it does not. The contract
   * has two halves and it tested neither: STABLE across renders, and NEW after
   * a change. Both are asserted now, either side of a real mutation.
   */
  it('returns the same array until the marks change', async () => {
    const store = createRemoteMarks(shelfOf([row(), row({ id: 'm2' })]))
    await settled()
    const first = store.all
    /* ACROSS READS SEPARATED BY OTHER WORK, which is what a render is. */
    await settled()
    expect(store.all, 'a fresh array on every look is an infinite re-render').toBe(first)
    expect(store.allBookmarks).toBe(store.allBookmarks)

    store.remove({ id: 'm1', bookId: 'b1' })
    /* AND A NEW ONE AFTER A CHANGE. Returning the SAME array while its contents
       changed is the other half of the contract and the worse failure: React
       compares by identity and would draw the old list for ever. */
    expect(store.all, 'the marks changed and the snapshot did not').not.toBe(first)
    expect(store.all.map((m) => m.id)).toEqual(['m2'])
  })

  it('removes optimistically and tells the shelf', async () => {
    const asked: { service: string; body: unknown }[] = []
    const store = createRemoteMarks(shelfOf([row()], (s, b) => asked.push({ service: s, body: b })))
    await settled()
    store.remove({ id: 'm1', bookId: 'b1' })
    expect(store.all).toEqual([])
    expect(asked.at(-1)).toEqual({ service: 'mark.remove', body: { mark: 'm1', book: 'b1' } })
  })

  it('writes a note optimistically and tells the shelf', async () => {
    const asked: { service: string; body: unknown }[] = []
    const store = createRemoteMarks(
      shelfOf([row(), row({ id: 'm2', note: 'theirs' })], (s, b) => asked.push({ service: s, body: b })),
    )
    await settled()
    store.setNote({ id: 'm1', bookId: 'b1' }, 'mine')
    expect(store.all[0]?.note).toBe('mine')
    /* THAT MARK'S NOTE, and no other's. */
    expect(store.all[1]?.note).toBe('theirs')
    expect(asked.at(-1)).toEqual({ service: 'mark.set', body: { mark: 'm1', book: 'b1', note: 'mine' } })
  })

  /* ⚠️ **A NOTE WRITE HANDED BACK** (2026-09-14 verify). `setNote` returned
     nothing while its write went to the shelf asynchronously, so the note editor
     took the note for saved the moment it was handed over, and closed over a
     write the shelf could still refuse — the draft went with it. */
  it('hands a note write back, so an editor can tell a saved note from a refused one', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusing = {
      ...shelfOf([row()]),
      call: async () => {
        throw new Error('forbidden')
      },
    } as unknown as ShelfChannel
    const store = createRemoteMarks(refusing)
    await settled()

    const cause = await Promise.resolve(store.setNote({ id: 'm1', bookId: 'b1' }, 'mine')).then(
      () => null,
      (thrown: unknown) => thrown,
    )

    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/forbidden/u)
    expect(store.persistent, 'and the store still says it stopped saving').toBe(false)
    expect(errors).toHaveBeenCalledWith('Paper: mark.set was refused', cause)
    /* AND THE OPTIMISTIC NOTE IS UNDONE by the re-read the refusal starts: the
       shelf still holds the note it had, and that is what the reader is shown. */
    await settled()
    expect(store.all[0]?.note).toBe('')
    vi.restoreAllMocks()
  })

  /**
   * ⚠️ **THE LISTENER WAS SUBSCRIBED BEFORE THE FIRST READ SETTLED**, so it had
   * already been called by the time the mutation happened — `toHaveBeenCalled`
   * was satisfied by the initial load, and a store that published nothing on a
   * change would have passed. The publish under test is the one AFTER the
   * store is quiet.
   */
  it('wakes its listeners when the marks change', async () => {
    const store = createRemoteMarks(shelfOf([row()]))
    await settled()
    const woke = vi.fn()
    store.subscribe(woke)
    expect(woke, 'subscribing must not itself publish').not.toHaveBeenCalled()

    store.remove({ id: 'm1', bookId: 'b1' })
    expect(woke, 'a change nobody is told about is a list that never redraws').toHaveBeenCalledTimes(1)

    store.setNote({ id: 'm2', bookId: 'b1' }, 'mine')
    /* A SECOND CHANGE PUBLISHES AGAIN — a store that fires once and goes quiet
       is the failure a single `toHaveBeenCalled` cannot see. */
    expect(woke).toHaveBeenCalledTimes(2)
  })

  /* A DROPPED CHANNEL DOES NOT EMPTY THE LIST. The marks last seen are real and
     the channel is what went; emptying would tell a reader their highlights had
     been deleted, which is alarming and false. */
  it('keeps what it had when a re-read fails', async () => {
    let fail = false
    const flaky = {
      call: async () => null,
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          if (fail) throw new Error('gone')
          yield [row()]
        },
      }),
      close: () => {},
    } as unknown as ShelfChannel
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createRemoteMarks(flaky)
    await settled()
    expect(store.all).toHaveLength(1)
    fail = true
    store.refresh()
    await settled()
    expect(store.all).toHaveLength(1)
    /* SAID, not swallowed: a list that quietly stopped updating looks exactly
       like a list with nothing new in it. */
    expect(errors).toHaveBeenCalledWith('Paper: could not read your marks', expect.objectContaining({ message: 'gone' }))
    vi.restoreAllMocks()
  })

  it('says nothing more after dispose', async () => {
    const store = createRemoteMarks(shelfOf([row()]))
    const woke = vi.fn()
    store.subscribe(woke)
    store.dispose()
    await settled()
    expect(woke).not.toHaveBeenCalled()
    /* AND KEEPS NOTHING THAT LANDS AFTER IT. The read above answered after
       dispose; a store that took it would hold a list nobody reads. */
    expect(store.all).toEqual([])
    /* NOR IS A LISTENER TOLD about a change made after it. */
    store.remove({ id: 'm1', bookId: 'b1' })
    expect(woke).not.toHaveBeenCalled()
  })

  /* NOTHING UNTIL THE SHELF ANSWERS — no placeholder rows — and a store that
     has been refused nothing is one that saves. */
  it('holds no marks before the first read lands, and starts out saving', () => {
    const store = createRemoteMarks(shelfOf([row()]))
    expect(store.all).toEqual([])
    expect(store.allBookmarks).toEqual([])
    expect(store.allUnplaced).toEqual([])
    expect(store.persistent).toBe(true)
  })

  /* ONE SHARED EMPTY LIST while nothing is unplaced, so a change elsewhere does
     not hand the panel a new empty array to re-render on. */
  it('keeps the same empty unplaced list across a change', async () => {
    const store = createRemoteMarks(shelfOf([row(), row({ id: 'm2' })]))
    await settled()
    const none = store.allUnplaced
    expect(none).toEqual([])
    store.remove({ id: 'm1', bookId: 'b1' })
    expect(store.allUnplaced, 'a new empty list is a re-render for nothing').toBe(none)
  })

  it('names itself when a subscriber throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createRemoteMarks(shelfOf([row()]))
    await settled()
    store.subscribe(() => {
      throw new Error('boom')
    })
    store.remove({ id: 'm1', bookId: 'b1' })
    expect(errors).toHaveBeenCalledWith(
      'Paper: a web marks subscriber threw while being notified',
      expect.objectContaining({ message: 'boom' }),
    )
    vi.restoreAllMocks()
  })

  it('stops waking a listener once it unsubscribes', async () => {
    const store = createRemoteMarks(shelfOf([row(), row({ id: 'm2' })]))
    await settled()
    const woke = vi.fn()
    const unsubscribe = store.subscribe(woke)
    unsubscribe()
    store.remove({ id: 'm1', bookId: 'b1' })
    expect(woke, 'a panel that unmounted is still being told').not.toHaveBeenCalled()
  })

  /* THE READ THAT STARTED LAST STANDS, whichever lands last — see
     `generation`. An older answer landing on a newer one takes away a mark the
     reader has just made, until the next refresh brings it back. */
  it('does not let an older read that lands late overwrite a newer one', async () => {
    const { channel, reads } = gatedShelf()
    const store = createRemoteMarks(channel)
    store.refresh()
    await settled()
    expect(reads).toHaveLength(2)
    reads[1]?.([row({ id: 'newer' })])
    await settled()
    reads[0]?.([row({ id: 'older' })])
    await settled()
    expect(store.all.map((m) => m.id)).toEqual(['newer'])
  })

  describe('add', () => {
    /* NOT OPTIMISTIC: what is drawn is what the shelf made, under the id the
       shelf issued — and it joins the marks already there. */
    it('asks mark.add for a highlight and adds what the shelf made beside the marks already there', async () => {
      const asked: { service: string; body: unknown }[] = []
      const channel = {
        ...shelfOf([row()]),
        call: async (service: string, body: unknown) => {
          asked.push({ service, body })
          return row({ id: 'm9', text: DRAFT.text })
        },
      } as unknown as ShelfChannel
      const store = createRemoteMarks(channel)
      await settled()
      const woke = vi.fn()
      store.subscribe(woke)

      const made = await store.add(DRAFT)

      expect(asked).toEqual([
        {
          service: 'mark.add',
          body: {
            book: 'b1',
            cfi: 'epubcfi(/6/4)',
            section: 2,
            text: 'a new passage',
            prefix: 'is ',
            suffix: ' here',
            note: 'mine',
            colour: 'green',
            chapter: 'Two',
            kind: 'highlight',
          },
        },
      ])
      expect(made?.id).toBe('m9')
      expect(store.all.map((m) => m.id)).toEqual(['m1', 'm9'])
      expect(woke, 'a highlight nobody is told about is one the page never draws').toHaveBeenCalledOnce()
    })

    it('adds nothing, and still saves, when the shelf answers with something that is not a mark', async () => {
      const channel = { ...shelfOf([row()]), call: async () => ({ nope: true }) } as unknown as ShelfChannel
      const store = createRemoteMarks(channel)
      await settled()
      expect(await store.add(DRAFT)).toBeNull()
      expect(store.all.map((m) => m.id)).toEqual(['m1'])
      expect(store.persistent, 'an answer this build cannot read is not a refusal').toBe(true)
    })

    it('hands back null, says so and stops saving when the shelf refuses', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const refusal = new Error('forbidden')
      const channel = {
        ...shelfOf([row()]),
        call: async () => {
          throw refusal
        },
      } as unknown as ShelfChannel
      const store = createRemoteMarks(channel)
      await settled()

      expect(await store.add(DRAFT)).toBeNull()
      expect(store.persistent).toBe(false)
      expect(store.all.map((m) => m.id)).toEqual(['m1'])
      expect(errors).toHaveBeenCalledWith('Paper: mark.add was refused', refusal)
      vi.restoreAllMocks()
    })
  })
})

/**
 * ⚠️ **THE SHELF NEVER SENT ONE UNTIL WI-21.7's WIRE FIX**, so this parser's
 * unplaced branch had never been exercised against a real row.
 *
 * `cfi: ''` is what BOTH a mark with no anchor and a mark that LOST its anchor
 * look like, and the refusal below is right about the second. The discriminator
 * is the only thing that tells them apart, which is why a row carrying an empty
 * anchor and nothing else must still be refused.
 */
describe('a mark the shelf says has no place', () => {
  const STRANDED = { reason: 'foreign-build', fromBook: 'book:elsewhere' }

  it('is admitted, with its quote and note, when it says why', () => {
    const marks = parseMarks([row({ cfi: '', sectionIndex: 0, note: 'the reader wrote this', unplaced: STRANDED })])
    expect(marks).toHaveLength(1)
    expect(marks[0]?.unplaced).toEqual(STRANDED)
    expect(marks[0]?.cfi).toBe('')
    expect(marks[0]?.note).toBe('the reader wrote this')
    expect(marks[0]?.text).toBe('the whale')
  })

  it('is still refused when the empty anchor is not explained', () => {
    /* The pre-existing rule, and it must survive: an anchorless row with no
       reason is a mark that lost its place, not one that never had one. */
    expect(parseMarks([row({ cfi: '', sectionIndex: 0 })])).toEqual([])
  })

  it.each([
    ['a reason this build does not know', { reason: 'future-reason', fromBook: 'book:elsewhere' }],
    ['no fromBook', { reason: 'foreign-build' }],
    ['not an object', 'foreign-build'],
    ['true', true],
  ])('is refused when the reason is unreadable — %s', (_why, bad) => {
    expect(parseMarks([row({ cfi: '', sectionIndex: 0, unplaced: bad })])).toEqual([])
  })

  /* A GOOD REASON DOES NOT EXCUSE A BAD FIELD. Only the anchor may be missing;
     everything else is read exactly as a placed mark's is. One field at a time,
     so each check is the only thing between the row and the list. */
  it.each([
    ['text', { text: 7 }],
    ['note', { note: 42 }],
    ['chapter', { chapter: null }],
    ['createdAt', { createdAt: '10' }],
    ['kind', { kind: 'scribble' }],
    ['tint', { tint: 'chartreuse' }],
    ['style', { style: 'sparkle' }],
  ])('is refused for a %s that will not read, whatever reason it gives', (_field, bad) => {
    expect(parseMarks([row({ cfi: '', sectionIndex: 0, unplaced: STRANDED, ...bad })])).toEqual([])
  })

  it('keeps the recovery context it carries, and defaults what an older mark lacks', () => {
    const [carried] = parseMarks([row({ cfi: '', sectionIndex: 0, unplaced: STRANDED, prefix: 'the ', suffix: ' calls' })])
    expect(carried?.prefix).toBe('the ')
    expect(carried?.suffix).toBe(' calls')
    const [older] = parseMarks([
      row({ cfi: '', sectionIndex: 0, unplaced: STRANDED, prefix: undefined, suffix: undefined }),
    ])
    expect(older?.prefix).toBe('')
    expect(older?.suffix).toBe('')
  })

  it('is the only mark in allUnplaced when placed marks arrive beside it', async () => {
    const view = createRemoteMarks(
      shelfOf([row({ id: 'placed' }), row({ id: 'stranded', cfi: '', sectionIndex: 0, unplaced: STRANDED })]),
    )
    await settled()
    expect(view.allUnplaced.map((m) => m.id)).toEqual(['stranded'])
    expect(view.all.map((m) => m.id)).toEqual(['placed'])
  })

  it('reaches the pane through allUnplaced, not through all', async () => {
    /* The three-way split is what puts it in the panel and keeps it away from
       the painter. A row landing in `all` would be handed to the overlay. */
    const view = createRemoteMarks(
      shelfOf([row({ cfi: '', sectionIndex: 0, unplaced: STRANDED })]) as unknown as ShelfChannel,
    )
    await vi.waitFor(() => expect(view.allUnplaced).toHaveLength(1))
    expect(view.all, 'an anchorless mark was offered to the drawable list').toHaveLength(0)
    expect(view.allBookmarks).toHaveLength(0)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { openFileStore } from './fileStore'
import { hlcOf, isHlc } from './hlc'
import { createLookups } from './lookupStore'
import { LOOKUPS_STORAGE_KEY, parseLookups, type LookupEntry } from './lookups'

/**
 * The lookup store (WI-17.1) — `cardStore.test.ts`'s questions, asked of the
 * history: what it loads, what it writes, and whether it tells the truth about
 * whether a write landed.
 */

const entry = (over: Partial<LookupEntry> = {}): LookupEntry => ({
  bookId: 'moby',
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:7)',
  chapter: 'Loomings',
  spelled: 'wharves',
  sentence: 'Belted round by wharves.',
  gloss: 'Where ships dock.',
  language: 'en',
  at: 1_000,
  ...over,
})

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    storage: {
      getItem: vi.fn((key: string) => map.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => void map.set(key, value)),
      flush: vi.fn(async () => {}),
    },
  }
}

const clock = () => hlcOf(42)

describe('createLookups', () => {
  it('loads what is stored, most recently met first', () => {
    const { storage } = memory({
      [LOOKUPS_STORAGE_KEY]: JSON.stringify([
        { term: 'gam', occurrences: [entry({ spelled: 'gam' })], firstAt: 1, lastAt: 1 },
        { term: 'wharves', occurrences: [entry()], firstAt: 1, lastAt: 9 },
      ]),
    })

    const lookups = createLookups({ storage, clock })

    expect(lookups.getSnapshot().all.map((one) => one.term)).toEqual(['wharves', 'gam'])
    expect(lookups.getSnapshot().persistent).toBe(true)
  })

  it('records a lookup, publishes it, and writes it under its own key', async () => {
    const { storage, map } = memory()
    const lookups = createLookups({ storage, clock })
    const heard = vi.fn()
    lookups.subscribe(heard)

    await lookups.record(entry())

    expect(lookups.getSnapshot().all.map((one) => one.term)).toEqual(['wharves'])
    expect(heard).toHaveBeenCalled()
    expect(parseLookups(map.get(LOOKUPS_STORAGE_KEY) ?? null).map((one) => one.updatedAt)).toEqual([hlcOf(42)])
    expect(storage.flush).toHaveBeenCalled()
  })

  it('stops telling a listener once it unsubscribes', async () => {
    const lookups = createLookups({ storage: memory().storage, clock })
    const heard = vi.fn()
    const off = lookups.subscribe(heard)
    off()

    await lookups.record(entry())

    expect(heard).not.toHaveBeenCalled()
  })

  /* The snapshot filters the tombstone; `stored` keeps it, for the merge. */
  it('removes a term from the view and keeps its tombstone in the store', async () => {
    const { storage, map } = memory()
    const lookups = createLookups({ storage, clock })
    await lookups.record(entry())

    await lookups.remove('Wharves')

    expect(lookups.getSnapshot().all).toEqual([])
    expect(lookups.stored().map((one) => one.deletedAt)).toEqual([hlcOf(42)])
    expect(parseLookups(map.get(LOOKUPS_STORAGE_KEY) ?? null)[0]?.deletedAt).toBe(hlcOf(42))
  })

  it('writes nothing for a lookup there is nothing to file', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })

    await lookups.record(entry({ gloss: '' }))

    expect(storage.setItem).not.toHaveBeenCalled()
  })

  /* A LOOKUP THE HISTORY WOULD REFUSE IS REFUSED OUT LOUD (2026-09-13 verify).
     The record's refusal is its input by identity, which the store reads as "no
     change" — so `record` resolved, nothing was saved, `persistent` stayed up,
     and the reader was never told the word would not be there next launch. */
  it('refuses, through the promise, a lookup the history would not read back', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })

    const refused = await lookups.record(entry({ cfi: 'x'.repeat(4_001) })).then(
      () => null,
      (cause: unknown) => cause,
    )

    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toMatch(/would not read this lookup back/u)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(lookups.getSnapshot().all).toEqual([])
    expect(lookups.getSnapshot().persistent).toBe(true)
  })

  it('lives for the session, and says so, with no storage at all', async () => {
    const lookups = createLookups({ storage: null, clock })

    await lookups.record(entry())

    expect(lookups.getSnapshot().all).toHaveLength(1)
    expect(lookups.getSnapshot().persistent).toBe(false)
  })

  /* A LOAD FAILURE IS NOT AN EMPTY HISTORY. Writing "nothing plus this" over
     bytes that would not read this launch would erase the reader's history. */
  it('never writes over a store it could not read', async () => {
    const { storage } = memory()
    storage.getItem.mockImplementation(() => {
      throw new Error('storage is off')
    })
    const lookups = createLookups({ storage, clock })

    await lookups.record(entry())

    expect(lookups.getSnapshot().persistent).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('reports a refused write through the flag and the promise, and recovers', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('the disk is full')
    })

    const refused = await lookups.record(entry()).then(
      () => null,
      (cause: unknown) => cause,
    )

    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toMatch(/the disk is full/u)
    expect(lookups.getSnapshot().persistent).toBe(false)

    await lookups.record(entry({ spelled: 'gam' }))

    expect(lookups.getSnapshot().persistent).toBe(true)
  })

  /* After a failed write the memory is ahead of the disk, so a retry that
     changes nothing must still write — or what it acked never lands. */
  it('still writes a no-change retry after a failed write', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('refused')
    })
    await lookups.record(entry()).catch(() => {})
    storage.setItem.mockClear()

    await lookups.record(entry({ gloss: '' }))

    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  /* A LOAD THAT FAILED IS SHOWN AS NOTHING, not as whatever the failed read
     left behind — the reader's history is unknown, and the view must not
     invent any. */
  it('shows an empty history over a store it could not read', () => {
    const { storage } = memory()
    storage.getItem.mockImplementation(() => {
      throw new Error('storage is off')
    })

    expect(createLookups({ storage, clock }).getSnapshot().all).toEqual([])
  })

  /* The default clock stamps with a real HLC — the stamp a merge would read. */
  it('stamps a record with a real clock when none is given', async () => {
    const lookups = createLookups({ storage: memory().storage })

    await lookups.record(entry())

    expect(isHlc(lookups.stored()[0]?.updatedAt)).toBe(true)
  })

  /* A SUBSCRIBER THAT THROWS IS REPORTED UNDER THIS STORE'S NAME — `notifyAll`
     names the store so the line is worth reading. */
  it('names itself when a subscriber throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lookups = createLookups({ storage: memory().storage, clock })
    lookups.subscribe(() => {
      throw new Error('a broken panel')
    })

    await lookups.record(entry())

    expect(error).toHaveBeenCalledWith('Paper: a lookups subscriber threw while being notified', expect.any(Error))
    error.mockRestore()
  })

  /* ONE NOTIFICATION PER LOOKUP. A write that lands on a store already saving
     changes nothing a subscriber reads, so it must not tell them twice. */
  it('tells a subscriber once for a lookup that saved', async () => {
    const lookups = createLookups({ storage: memory().storage, clock })
    const heard = vi.fn()
    lookups.subscribe(heard)

    await lookups.record(entry())

    expect(heard).toHaveBeenCalledTimes(1)
  })

  /* And a SECOND refusal in a row changes nothing either: the flag is already
     down. Three notifications — the lookup, the flag going down, the lookup. */
  it('tells a subscriber the flag went down once, however many writes are refused', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })
    storage.setItem.mockImplementation(() => {
      throw new Error('the disk is full')
    })
    const heard = vi.fn()
    lookups.subscribe(heard)

    await lookups.record(entry()).catch(() => {})
    await lookups.record(entry({ spelled: 'gam' })).catch(() => {})

    expect(heard).toHaveBeenCalledTimes(3)
  })

  /* A WRITE THAT LANDS PAYS OFF THE DEBT a refused one left: after it, a change
     that changes nothing is nothing again, and writes nothing. */
  it('writes nothing for a no-change record once a later write has landed', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('refused')
    })
    await lookups.record(entry()).catch(() => {})
    await lookups.record(entry({ spelled: 'gam' }))
    storage.setItem.mockClear()

    await lookups.record(entry({ gloss: '' }))

    expect(storage.setItem).not.toHaveBeenCalled()
  })

  /* Long enough for every microtask a write chains to have run. */
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  /* UNREADABLE BYTES ARE A LOAD FAILURE, not an empty history — found by the
     2026-09-13 audit. The read answered [] for them, so the store came up
     healthy and the next lookup wrote "nothing plus this" over the reader's
     history. The bytes stay where they were for whatever can recover them. */
  it.each([
    ['not JSON', '[{"term":"wharves",'],
    ['not a list', '{"term":"wharves"}'],
  ])('never writes over stored history that is %s', async (_name, raw) => {
    const { storage, map } = memory({ [LOOKUPS_STORAGE_KEY]: raw })
    const lookups = createLookups({ storage, clock })

    await lookups.record(entry())

    expect(lookups.getSnapshot().persistent).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(map.get(LOOKUPS_STORAGE_KEY)).toBe(raw)
  })

  /* AN OLDER WRITE FINISHING MUST NOT CLEAR A NEWER REFUSAL. Two lookups a
     moment apart: the first had written and was still flushing when the second
     was refused, and the first then finished — putting `persistent` back up,
     and calling the debt paid, over a lookup that never reached the disk. */
  it('keeps a later refusal standing when an earlier write finishes after it', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })
    let finish = (): void => {}
    storage.flush.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )

    const first = lookups.record(entry())
    await tick()
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('the disk is full')
    })
    const second = lookups.record(entry({ spelled: 'gam' })).catch((cause: unknown) => cause)
    await tick()
    finish()
    await first

    expect(await second).toBeInstanceOf(Error)
    expect(lookups.getSnapshot().persistent).toBe(false)

    storage.setItem.mockClear()
    await lookups.record(entry({ gloss: '' }))

    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  /* A REPEATED REMOVAL WAITS FOR THE ONE IT REPEATS. It changed nothing, so it
     resolved at once — while that removal was still flushing and about to be
     refused. The reader was told a word was gone that was still on disk. */
  it('does not settle a repeated removal before the removal it repeats', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })
    await lookups.record(entry())
    let refuse = (_cause: Error): void => {}
    storage.flush.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject
        }),
    )
    storage.flush.mockImplementationOnce(async () => {
      throw new Error('still full')
    })

    const first = lookups.remove('wharves').catch((cause: unknown) => cause)
    await tick()
    let settled = false
    const second = lookups
      .remove('wharves')
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true
      })
    await tick()

    expect(settled).toBe(false)

    refuse(new Error('the disk is full'))

    expect(await first).toBeInstanceOf(Error)
    expect(await second).toBeInstanceOf(Error)
    expect(lookups.getSnapshot().persistent).toBe(false)
  })

  /* A BURST IS ONE WRITE, which this store's header promised and a flush after
     every lookup broke: three lookups in one tick wrote the whole file three
     times. Through the real `openFileStore`, whose coalescing is the claim. */
  it('writes a burst of lookups to disk once', async () => {
    const write = vi.fn(async (_path: string, _text: string) => {})
    const storage = await openFileStore({ fs: { read: async () => null, write } })
    const lookups = createLookups({ storage, clock })

    await Promise.all([
      lookups.record(entry()),
      lookups.record(entry({ spelled: 'gam' })),
      lookups.record(entry({ spelled: 'gally' })),
    ])
    await tick()

    expect(write).toHaveBeenCalledTimes(1)
    expect(parseLookups(storage.getItem(LOOKUPS_STORAGE_KEY)).map((one) => one.term).sort()).toEqual(['gally', 'gam', 'wharves'])
  })

  /* A RETRY THAT CHANGES NOTHING TELLS NOBODY SO. The flag coming back up is
     news; the list a subscriber reads is the one they already have. */
  it('tells a subscriber only that the flag came back up when a no-change retry lands', async () => {
    const { storage } = memory()
    const lookups = createLookups({ storage, clock })
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('refused')
    })
    await lookups.record(entry()).catch(() => {})
    const heard = vi.fn()
    lookups.subscribe(heard)

    await lookups.record(entry({ gloss: '' }))

    expect(heard).toHaveBeenCalledTimes(1)
    expect(lookups.getSnapshot().persistent).toBe(true)
  })
})

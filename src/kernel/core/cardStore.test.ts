import { describe, expect, it, vi } from 'vitest'
import { CARDS_STORAGE_KEY, type Card, type NewCard } from './cards'
import { createCard, createCards } from './cardStore'
import { hlcOf, type Hlc } from './hlc'
import type { MutationRecorder, MutationToken } from './ports'
import { writeQueue } from './writeQueue'

/**
 * cardStore's crash-safety around the shared write queue (finding #30).
 *
 * A card write's bytes must be serialised INSIDE its own queued task, so a
 * later edit enqueued while an earlier task still holds the queue (a remote
 * apply waiting on its journal begin) cannot leak its state into the earlier
 * task's bracket — which a crash would then leave durable but recorded under
 * the wrong origin.
 */

const testClock = () => {
  let t = 0
  return (): Hlc => hlcOf(++t)
}

/** A storage double that logs every serialised value the store received. */
const loggingStorage = () => {
  const writes: string[] = []
  return {
    writes,
    getItem: () => null,
    setItem: (_key: string, value: string) => void writes.push(value),
  }
}

/** A recorder whose FIRST `begin` blocks until released — the held bracket. */
const gatedRecorder = () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let begins = 0
  const recorder: MutationRecorder = {
    begin: async (book, what) => {
      if (++begins === 1) await gate
      return { book, what } as MutationToken
    },
    commit: async () => {},
  }
  return { recorder, release: () => release() }
}

describe('cardStore serialises each write inside its own queued task (#30)', () => {
  it("a later edit does not leak into an earlier still-open bracket's bytes", async () => {
    const storage = loggingStorage()
    const { recorder, release } = gatedRecorder()
    const cards = createCards({ storage, recorder, queue: writeQueue(), clock: testClock() })

    const card = (id: string): Card => ({
      id,
      bookId: 'book:a',
      kind: 'Excerpt',
      body: id,
      answer: '',
      source: '',
      cfi: null,
      createdAt: id === 'A' ? 1 : 2,
    })
    const a = card('A')
    const b = card('B')

    // Both enqueued while the first bracket's begin is held. The first task's
    // setItem must not see B: it was enqueued after, on the same queue key.
    const first = cards.add(a)
    const second = cards.add(b)
    release()
    await Promise.all([first, second])

    const firstBracketBytes = JSON.parse(storage.writes[0]!) as { id: string }[]
    expect(firstBracketBytes.map((card) => card.id)).toEqual(['A'])
    // And the second bracket persisted both, in queue order.
    const secondBracketBytes = JSON.parse(storage.writes[1]!) as { id: string }[]
    expect(secondBracketBytes.map((card) => card.id).sort()).toEqual(['A', 'B'])
  })
})

describe('stored() — the canonical rows a replicator reads (WI-10.4)', () => {
  it('answers the whole held list, tombstones included, where the snapshot filters to live', async () => {
    const cards = createCards({ storage: null, clock: testClock() })
    const row: Card = { id: 'c1', bookId: 'book:a', kind: 'Excerpt', body: 'x', answer: '', source: '', cfi: null, createdAt: 1 }
    await cards.add(row)
    await cards.remove('c1')
    expect(cards.getSnapshot().all).toEqual([])
    const held = cards.stored()
    expect(held.map((card) => card.id)).toEqual(['c1'])
    expect(held[0]?.deletedAt).toBeTruthy()
  })

  it('reflects a write the moment the mutation resolves — the authority between flushes', async () => {
    const storage = loggingStorage()
    const cards = createCards({ storage, clock: testClock() })
    const row: Card = { id: 'c2', bookId: 'book:a', kind: 'Excerpt', body: 'y', answer: '', source: '', cfi: null, createdAt: 2 }
    await cards.add(row)
    expect(cards.stored().map((card) => card.id)).toEqual(['c2'])
  })
})

/* UNREADABLE BYTES ARE A LOAD FAILURE, NOT AN EMPTY COLLECTION — found by the
   2026-09-13 audit. `parseCards` answered [] for them, so the store came up
   healthy and empty, and the next card made wrote "no cards plus this one"
   over every card the reader had. This file's own comment already said a
   failed load is not an empty collection; only a load that THREW took that
   path. The bytes stay where they were. */
describe('a load that cannot read the stored cards', () => {
  it.each([
    ['not JSON', '[{"id":"c1",'],
    ['not a list', '{"id":"c1"}'],
  ])('never writes over stored cards that are %s', async (_name, raw) => {
    const held = new Map([[CARDS_STORAGE_KEY, raw]])
    const writes: string[] = []
    const storage = {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(value)
        held.set(key, value)
      },
    }
    const cards = createCards({ storage, queue: writeQueue(), clock: testClock() })
    expect(cards.getSnapshot().persistent, 'said from the first snapshot').toBe(false)

    const row: Card = { id: 'c3', bookId: 'book:a', kind: 'Excerpt', body: 'z', answer: '', source: '', cfi: null, createdAt: 3 }
    await cards.add(row)

    expect(cards.getSnapshot().all.map((card) => card.id), 'kept for the session').toEqual(['c3'])
    expect(cards.getSnapshot().persistent).toBe(false)
    expect(writes).toEqual([])
    expect(held.get(CARDS_STORAGE_KEY)).toBe(raw)
  })

  /* EVERY DOOR, not only `add`: the load failure is one flag, and each
     mutation reaches the write through it. Unreadable bytes and a read that
     throws are the two ways in. */
  it.each([
    ['stored cards that will not parse', () => '[{"id":"c1",'],
    [
      'a storage that throws on read',
      () => {
        throw new Error('revoked')
      },
    ],
  ])('writes nothing over %s, whichever mutation comes next', async (_name, read) => {
    const writes: string[] = []
    const storage = { getItem: read, setItem: (_key: string, value: string) => void writes.push(value) }
    const cards = createCards({ storage, queue: writeQueue(), clock: testClock() })
    const told: boolean[] = []
    cards.subscribe(() => told.push(cards.getSnapshot().persistent))

    await cards.add(row('n1'))
    await cards.addMany([row('n2'), row('n3')])
    await cards.remove('n2')
    await cards.apply((prev) => prev.filter((card) => card.id !== 'n3'))
    await cards.rekey('book:a', 'book:b')

    expect(writes).toEqual([])
    expect(cards.getSnapshot()).toEqual({ all: [row('n1', { bookId: 'book:b' })], persistent: false })
    expect(told).toEqual([false, false, false, false, false])
  })
})

/** A card with every field but the ones a case is about. */
const row = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  bookId: 'book:a',
  kind: 'Excerpt',
  body: id,
  answer: '',
  source: '',
  cfi: null,
  createdAt: 1,
  ...over,
})

/** A storage double holding one value, which can be made to refuse writes. */
const flakyStorage = (initial: string | null = null) => {
  let held = initial
  let refusal: Error | null = null
  const writes: string[] = []
  return {
    writes,
    refuse: (error: Error | null) => {
      refusal = error
    },
    getItem: (key: string) => (key === CARDS_STORAGE_KEY ? held : null),
    setItem: (_key: string, value: string) => {
      if (refusal) throw refusal
      writes.push(value)
      held = value
    },
  }
}

const ids = (bytes: string | undefined): string[] => (JSON.parse(bytes ?? 'null') as Card[]).map((card) => card.id)

describe('createCard', () => {
  it('mints the draft with an id of its own and the time it was made', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    try {
      const draft: NewCard = { bookId: 'book:a', kind: 'Idea', body: 'b', answer: '', source: 'Ch. 1', cfi: null }
      const one = createCard(draft)
      const two = createCard(draft)
      expect(one).toEqual({ ...draft, id: one.id, createdAt: 5_000 })
      expect(one.id).not.toBe('')
      expect(one.id).not.toBe(two.id)
    } finally {
      now.mockRestore()
    }
  })
})

describe('what the first snapshot says about saving', () => {
  it.each([
    [true, 'storage that read', () => flakyStorage(JSON.stringify([row('c1')]))],
    [false, 'no storage at all', () => null],
    [false, 'stored cards that will not parse', () => flakyStorage('not json')],
  ])('says persistent is %s over %s', (persistent, _name, storage) => {
    const cards = createCards({ storage: storage(), clock: testClock() })
    expect(cards.getSnapshot().persistent).toBe(persistent)
  })
})

describe('what a write tells, and whom', () => {
  it('records every card write under one key, whatever book the card is from', async () => {
    const begun: [string, string][] = []
    const recorder: MutationRecorder = {
      begin: async (book, what) => {
        begun.push([book, what])
        return { book, what } as MutationToken
      },
      commit: async () => {},
    }
    const cards = createCards({ storage: flakyStorage(), recorder, clock: testClock() })
    await cards.add(row('c1', { bookId: 'book:a' }))
    await cards.add(row('c2', { bookId: 'book:b' }))
    expect(begun).toEqual([
      ['', 'cards'],
      ['', 'cards'],
    ])
  })

  it('tells a subscriber once per change, and stops when it unsubscribes', async () => {
    const cards = createCards({ storage: flakyStorage(), clock: testClock() })
    let told = 0
    const stop = cards.subscribe(() => void told++)
    await cards.add(row('c1'))
    expect(told).toBe(1)
    stop()
    await cards.add(row('c2'))
    expect(told).toBe(1)
  })

  it('keeps telling the rest, and still saves, when one subscriber throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const storage = flakyStorage()
      const cards = createCards({ storage, clock: testClock() })
      const boom = new Error('boom')
      cards.subscribe(() => {
        throw boom
      })
      let told = 0
      cards.subscribe(() => void told++)
      await cards.add(row('c1'))
      expect(told).toBe(1)
      expect(ids(storage.writes[0])).toEqual(['c1'])
      expect(logged).toHaveBeenCalledWith('Paper: a cards subscriber threw while being notified', boom)
    } finally {
      logged.mockRestore()
    }
  })

  it('rejects with the refusal and says so once, then says so again when a write lands', async () => {
    const storage = flakyStorage()
    const cards = createCards({ storage, clock: testClock() })
    const told: boolean[] = []
    cards.subscribe(() => told.push(cards.getSnapshot().persistent))

    const refusal = new Error('quota exceeded')
    storage.refuse(refusal)
    const cause = await cards.add(row('c1')).then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBe(refusal)
    expect(cards.getSnapshot().persistent).toBe(false)
    // A second refusal is no news: the change is told, the state is not.
    await cards.add(row('c2')).catch(() => {})
    expect(told).toEqual([true, false, false])

    storage.refuse(null)
    await cards.add(row('c3'))
    expect(cards.getSnapshot().persistent).toBe(true)
    expect(told).toEqual([true, false, false, false, true])
    expect(storage.writes.map(ids)).toEqual([['c3', 'c2', 'c1']])
  })
})

describe('a mutation that changes nothing', () => {
  it('writes nothing and tells nobody while the disk holds what memory does', async () => {
    const storage = flakyStorage(JSON.stringify([row('c1')]))
    const cards = createCards({ storage, clock: testClock() })
    let told = 0
    cards.subscribe(() => void told++)
    await cards.apply((prev) => prev)
    // `rekey` runs on every open, so a rekey with nothing to move is the common case.
    await cards.rekey('book:elsewhere', 'book:b')
    expect(storage.writes).toEqual([])

    await cards.add(row('c2'))
    await cards.apply((prev) => prev)
    expect(storage.writes).toHaveLength(1)
    expect(told).toBe(1)
  })

  it('still writes the held list after a write that did not land', async () => {
    /* A retried merge that returns its input by identity is acked — so the
       rows it acks must reach storage, not only memory. */
    const storage = flakyStorage()
    const cards = createCards({ storage, clock: testClock() })
    storage.refuse(new Error('disk full'))
    await cards.add(row('c1')).catch(() => {})
    storage.refuse(null)
    await cards.apply((prev) => prev)
    expect(storage.writes.map(ids)).toEqual([['c1']])
    expect(cards.getSnapshot().persistent).toBe(true)
  })
})

describe('the other doors', () => {
  it('adds several cards in one write, in the order a run of adds leaves', async () => {
    const one = flakyStorage()
    const sequential = createCards({ storage: one, clock: testClock() })
    for (const card of [row('c1'), row('c2'), row('c3')]) await sequential.add(card)
    const many = flakyStorage()
    const batched = createCards({ storage: many, clock: testClock() })
    await batched.addMany([row('c1'), row('c2'), row('c3')])
    expect(many.writes).toHaveLength(1)
    expect(many.writes[0]).toBe(one.writes.at(-1))
    expect(batched.getSnapshot().all).toEqual(sequential.getSnapshot().all)
  })

  it('writes nothing for an empty addMany, even with a failed write outstanding', async () => {
    const storage = flakyStorage()
    const cards = createCards({ storage, clock: testClock() })
    storage.refuse(new Error('disk full'))
    await cards.add(row('c1')).catch(() => {})
    storage.refuse(null)
    let told = 0
    cards.subscribe(() => void told++)
    await cards.addMany([])
    expect(storage.writes).toEqual([])
    expect(told).toBe(0)
  })

  it('hands a mutation the tombstones too, and saves what it returns', async () => {
    const storage = flakyStorage()
    const cards = createCards({ storage, clock: testClock() })
    await cards.add(row('c1'))
    await cards.remove('c1')
    let seen: readonly Card[] = []
    await cards.apply((prev) => {
      seen = prev
      return [...prev, row('c2')]
    })
    expect(seen.map((card) => card.deletedAt !== undefined)).toEqual([true])
    expect(ids(storage.writes.at(-1))).toEqual(['c1', 'c2'])
    expect(cards.getSnapshot().all.map((card) => card.id)).toEqual(['c2'])
  })

  it('moves every card from a superseded book id onto the current one, and saves it', async () => {
    const storage = flakyStorage(JSON.stringify([row('c1', { bookId: 'old' }), row('c2', { bookId: 'other' })]))
    const cards = createCards({ storage, clock: testClock() })
    await cards.rekey('old', 'new')
    expect(cards.getSnapshot().all.map((card) => [card.id, card.bookId])).toEqual([
      ['c1', 'new'],
      ['c2', 'other'],
    ])
    expect(storage.writes).toHaveLength(1)
  })

  it('stamps a removal from the wall clock when no clock is given', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(7_000)
    try {
      const cards = createCards({ storage: null })
      await cards.add(row('c1'))
      await cards.remove('c1')
      expect(cards.stored()[0]?.deletedAt).toBe(hlcOf(7_000))
    } finally {
      now.mockRestore()
    }
  })
})

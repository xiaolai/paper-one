import { describe, expect, it } from 'vitest'
import type { Card } from './cards'
import { createCards } from './cardStore'
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

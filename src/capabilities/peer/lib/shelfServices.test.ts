import { describe, expect, it } from 'vitest'
import type { ShelfPort } from '../../../kernel'
import { FORBIDDEN, refusalCode, seedBook, serveTable } from './serviceTable.testkit'

/**
 * `shelf.*` OVER THE REAL ROUTER — this device, its identity and its health.
 *
 * Every existing test drove these with NO port bound, so only the refusals and
 * the null-filled status were covered: the successful path of `shelf.sync` and
 * `shelf.verify` — the two administrative verbs — had never run at all, and
 * neither had the cancellation `shelf.verify` exists to honour.
 */

/** A port that records what it was asked and can be made to fail. */
function fakeShelf(over: Partial<ShelfPort> = {}): ShelfPort & { verified: (AbortSignal | undefined)[] } {
  const verified: (AbortSignal | undefined)[] = []
  return {
    verified,
    facts: async () => ({ role: 'shelf', endpointId: 'ep-1', journalSeq: 42, epoch: 'e-1' }),
    sync: async () => ({ started: true }),
    verify: async (signal?: AbortSignal) => {
      verified.push(signal)
      return { ok: true, checked: 3, repaired: 0 }
    },
    ...over,
  } as ShelfPort & { verified: (AbortSignal | undefined)[] }
}

describe('shelf.status', () => {
  it('answers the port’s facts alongside the counts it owns', async () => {
    const shelf = serveTable({ books: [seedBook('one'), seedBook('two')], shelf: fakeShelf() })
    expect(await shelf.client.call('shelf.status', null)).toMatchObject({
      role: 'shelf',
      endpointId: 'ep-1',
      books: 2,
      journalSeq: 42,
      epoch: 'e-1',
    })
  })

  it('answers with nulls rather than refusing when no port is bound', async () => {
    /* `sizes: null` — no size port, which is what this case is about. The
       harness binds a real one by default now, because `content.locate`
       answering `size: null` everywhere made half that service unassertable. */
    const shelf = serveTable({ books: [seedBook('one')], sizes: null })
    expect(await shelf.client.call('shelf.status', null)).toMatchObject({
      role: null,
      endpointId: null,
      books: 1,
      journalSeq: null,
      epoch: null,
      bytes: null,
    })
  })

  /**
   * "NOBODY COULD LOOK" IS NOT "THERE ARE NONE".
   *
   * The app opens the window on an empty snapshot when the index will not
   * load — not opening at all would be worse — and the kernel was never told,
   * so `shelf.status` reported `books: 0`. That is the service a peer reads to
   * decide whether this device is healthy, and a satchel seeing zero has every
   * reason to conclude the shelf was emptied.
   */
  it('answers null books when the shelf could not be read, not zero', async () => {
    const unread = serveTable({ books: [], shelfRead: false, shelf: fakeShelf() })
    expect(await unread.client.call('shelf.status', null)).toMatchObject({ books: null })

    /* A shelf that WAS read and holds nothing still answers zero — the two
     * are different answers, which is the whole point. */
    const empty = serveTable({ books: [], shelf: fakeShelf() })
    expect(await empty.client.call('shelf.status', null)).toMatchObject({ books: 0 })
  })

  /**
   * THE CARD COUNT IS NOT HERE, and its absence is an authorization boundary.
   *
   * `shelf.status` is granted by `shelf:read`; card metadata is protected by
   * the independent `card:read`. Reporting the count handed a peer trusted
   * only with this device's health a number about a surface it was
   * deliberately not granted — and, asked repeatedly, told it how that number
   * moves, which is the reader's study habits.
   */
  it('tells a peer nothing about cards, which are a different grant', async () => {
    const shelf = serveTable({ grants: ['shelf:read'], shelf: fakeShelf() })
    const status = await shelf.client.call('shelf.status', null)
    expect(Object.keys(status as object)).not.toContain('cards')
    /* And that peer genuinely cannot reach cards by the front door either. */
    expect(refusalCode(await shelf.client.call('card.add', { text: 'x' }).catch((e: unknown) => e))).toBe(FORBIDDEN)
  })
})

describe('shelf.sync and shelf.verify', () => {
  it('dispatch to the bound port and answer what it returned', async () => {
    const shelf = serveTable({ grants: ['shelf:*'], shelf: fakeShelf() })
    expect(await shelf.client.call('shelf.sync', null)).toEqual({ started: true })
    expect(await shelf.client.call('shelf.verify', null)).toEqual({ ok: true, checked: 3, repaired: 0 })
  })

  /**
   * THE SIGNAL REACHES THE PORT.
   *
   * Verification scans the whole library. Without the signal a timeout, a
   * cancel frame, a disconnect or a revoked grant left the pass running to
   * completion over thousands of books with nobody waiting for the answer.
   */
  it('hand shelf.verify a live signal, so a cancelled call can stop the scan', async () => {
    const port = fakeShelf()
    const shelf = serveTable({ grants: ['shelf:*'], shelf: port })
    await shelf.client.call('shelf.verify', null)
    expect(port.verified).toHaveLength(1)
    expect(port.verified[0]).toBeInstanceOf(AbortSignal)
    expect(port.verified[0]?.aborted).toBe(false)
  })

  it('refuse rather than answer when no port is bound', async () => {
    const shelf = serveTable({ grants: ['shelf:*'] })
    for (const name of ['shelf.sync', 'shelf.verify']) {
      const failure = await shelf.client.call(name, null).catch((e: unknown) => e)
      expect(refusalCode(failure), name).toBe('unsupported')
      /* NOT a partial answer: a sync that did not happen must not say
       * "started", and a verify that ran over nothing must not say "ok". */
      expect(String(failure)).toMatch(/sync capability/)
    }
  })

  /* A PORT THAT THROWS IS NOT A PORT THAT ANSWERED. The failure crosses as a
   * refusal rather than as a plausible-looking result. */
  it('carry a port failure out rather than inventing an answer', async () => {
    const shelf = serveTable({
      grants: ['shelf:*'],
      shelf: fakeShelf({
        sync: async () => {
          throw new Error('the peer is gone')
        },
      }),
    })
    const failure = await shelf.client.call('shelf.sync', null).catch((e: unknown) => e)
    expect(refusalCode(failure)).not.toEqual(expect.objectContaining({ started: true }))
    expect(String(failure)).toMatch(/peer is gone|internal/)
  })

  it('are forbidden without the grant, before the handler runs', async () => {
    const shelf = serveTable({ grants: ['book:*'], shelf: fakeShelf() })
    for (const name of ['shelf.status', 'shelf.sync', 'shelf.verify']) {
      expect(refusalCode(await shelf.client.call(name, null).catch((e: unknown) => e)), name).toBe(FORBIDDEN)
    }
    expect(shelf.ran).toEqual([])
  })
})

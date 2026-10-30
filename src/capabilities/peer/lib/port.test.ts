import { describe, expect, it } from 'vitest'
import type { ServiceContribution } from '../../../kernel'
import { ServiceCallError } from './envelope'
import { fakeBlobHash, linkedWires, type FakeWire } from './fakeWire.testkit'
import { grantCovers } from './grants'
import { BlobFetchError, createPeerPort } from './port'
import type { BlobRequest, TransferProgress, Unsubscribe, WirePeer } from './wire'
import { refusalOf } from '../../../kernel/testkit'

/**
 * The port over the fake wire: the same envelope router/client the app runs,
 * on an in-memory link. What is proven here is the plumbing the sync
 * protocol stands on — call/answer across two wires, grant refusal before a
 * handler runs, blob fetch resolving on DONE and not on start, and a severed
 * link rejecting rather than hanging.
 */

const echo: ServiceContribution = {
  name: 'sync.echo',
  grant: 'sync:pull',
  handler: async (req) => ({ echoed: req }),
}

/** One turn of the event loop: everything already queued, and nothing timed. */
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Enough turns for the fake wire to carry a request and its answer both ways. */
const flush = async (): Promise<void> => {
  for (let taken = 0; taken < 6; taken += 1) await turn()
}

type Settled =
  | { readonly state: 'pending' }
  | { readonly state: 'resolved'; readonly value: unknown }
  | { readonly state: 'refused'; readonly thrown: unknown }

/**
 * Holds a promise from the moment it is made, and answers what it has DONE
 * once everything already queued has run.
 *
 * ⚠️ **AWAITING A PROMISE IS NOT HOW A MUTANT THAT NEVER SETTLES ONE IS
 * CAUGHT.** A sweep of this file on 2026-09-15 reported twenty-seven mutants as
 * wall-clock TIMEOUTS rather than kills — a `fetchBlob` left pending, a close
 * never heard — and a timeout says only that the clock ran out, which it said
 * again on the re-run. Asked this way each one fails an assertion in
 * milliseconds instead: `pending` is an answer, and nothing here waits on a
 * deadline to reach it.
 *
 * Taken at the call rather than at the assertion for a second reason: a
 * refusal that lands while the test is driving something else is an unhandled
 * rejection if nothing is holding it yet.
 */
const watching = (promise: Promise<unknown>): (() => Promise<Settled>) => {
  let outcome: Settled = { state: 'pending' }
  void promise.then(
    (value: unknown) => void (outcome = { state: 'resolved', value }),
    (thrown: unknown) => void (outcome = { state: 'refused', thrown }),
  )
  return async () => {
    for (let taken = 0; taken < 12 && outcome.state === 'pending'; taken += 1) await turn()
    return outcome
  }
}

/** What a promise has done by now, for one that is awaited where it is made. */
const settledness = (promise: Promise<unknown>): Promise<Settled> => watching(promise)()

/**
 * The value a promise has ALREADY rejected with — `refusalOf`'s assertions
 * without its wait, and one more: that the value is an `Error`, which every
 * road out of this port owes its caller.
 */
const refusedNow = async (promise: Promise<unknown>): Promise<Error & { readonly kind?: string }> => {
  const outcome = await settledness(promise)
  if (outcome.state !== 'refused') {
    throw new Error(`refusedNow: expected a refusal by now, and the promise was ${outcome.state}`)
  }
  if (!(outcome.thrown instanceof Error)) {
    throw new Error(`refusedNow: expected the refusal to be an Error, got ${String(outcome.thrown)}`)
  }
  return outcome.thrown as Error & { readonly kind?: string }
}

/**
 * The answer a call has ALREADY given. A call that cannot be answered waits out
 * the envelope's own thirty seconds, which is a mutant reported as a timeout
 * rather than as the kill it is.
 */
const answerTo = async (call: Promise<unknown>): Promise<unknown> => {
  const outcome = await settledness(call)
  if (outcome.state === 'resolved') return outcome.value
  throw new Error(
    outcome.state === 'pending'
      ? 'answerTo: the call was still waiting when everything queued had run'
      : `answerTo: the call was refused — ${String(outcome.thrown)}`,
  )
}

/** Everything a stream yielded, as one value to assert on. */
const drained = async (stream: AsyncIterable<unknown>): Promise<unknown[]> => {
  const seen: unknown[] = []
  for await (const item of stream) seen.push(item)
  return seen
}

/**
 * Takes this wire's reads under the test's own control.
 *
 * The inbox is spliced when `sessionRecv` is CALLED, exactly as the plugin
 * splices it; what a held read keeps back is only the answer reaching the port.
 * `mostLive` is what the drain's one-at-a-time rule is measured by — two reads
 * of one session in flight together race two splices, and frame order is the
 * envelope's ground.
 */
const holdReads = (wire: FakeWire) => {
  const real = wire.sessionRecv.bind(wire)
  const gates: ((thrown?: unknown) => void)[] = []
  const held = { reads: 0, live: 0, mostLive: 0, bySession: new Map<number, number>(), holding: false }
  Object.assign(wire, {
    sessionRecv: (sessionId: number, max?: number) => {
      held.reads += 1
      held.live += 1
      held.mostLive = Math.max(held.mostLive, held.live)
      held.bySession.set(sessionId, (held.bySession.get(sessionId) ?? 0) + 1)
      const spliced = real(sessionId, max)
      const answered = held.holding
        ? new Promise<void>((resolve, reject) => {
            gates.push((thrown) => (thrown === undefined ? resolve() : reject(thrown)))
          })
        : Promise.resolve()
      return answered.then(
        () => {
          held.live -= 1
          return spliced
        },
        (thrown: unknown) => {
          held.live -= 1
          throw thrown
        },
      )
    },
  })
  return {
    held,
    hold: () => void (held.holding = true),
    /** Later reads answer at once again; the ones already held stay held. */
    free: () => void (held.holding = false),
    /** The read taken longest ago answers with what it spliced. */
    release: () => void gates.shift()?.(),
    /** The read taken longest ago fails, as a stream that went away does. */
    fail: (thrown: unknown) => void gates.shift()?.(thrown),
  }
}

/**
 * Counts the listeners a port takes and gives back, and the listings it asks
 * for.
 *
 * ⚠️ **SHADOWED ON THE INSTANCE, NOT COPIED ONTO A STAND-IN**, for the reason
 * the router test below gives and this one learned again: a copy gets its own
 * READINESS, so `serve()` marks the copy ready and every dial at the wire the
 * link actually holds is refused `not-ready`, with nothing saying why.
 */
const counting = (wire: FakeWire) => {
  const held = { taken: 0, released: 0, listed: 0 }
  const watch =
    <T>(real: (fn: T) => Unsubscribe) =>
    (fn: T): Unsubscribe => {
      held.taken += 1
      const off = real(fn)
      return () => {
        held.released += 1
        off()
      }
    }
  const listPeers = wire.listPeers.bind(wire)
  Object.assign(wire, {
    onSessionOpen: watch(wire.onSessionOpen.bind(wire)),
    onSessionFrames: watch(wire.onSessionFrames.bind(wire)),
    onSessionClosed: watch(wire.onSessionClosed.bind(wire)),
    listPeers: () => {
      held.listed += 1
      return listPeers()
    },
  })
  return held
}

/** Counts the transfer listeners a port takes and gives back. */
const countingTransfers = (wire: FakeWire) => {
  const held = { taken: 0, released: 0 }
  const real = wire.onTransfer.bind(wire)
  Object.assign(wire, {
    onTransfer: (fn: (event: TransferProgress) => void): Unsubscribe => {
      held.taken += 1
      const off = real(fn)
      return () => {
        held.released += 1
        off()
      }
    },
  })
  return held
}

describe('grantCovers', () => {
  it('matches exact grants and the prefix wildcard, and nothing wider', () => {
    expect(grantCovers(['sync:push'], 'sync:push')).toBe(true)
    expect(grantCovers(['sync:*'], 'sync:push')).toBe(true)
    expect(grantCovers(['sync:*'], 'sync')).toBe(false)
    expect(grantCovers(['*'], 'sync:push')).toBe(false)
    expect(grantCovers(['syncfoo:*'], 'sync:push')).toBe(false)
    expect(grantCovers([], 'sync:push')).toBe(false)
  })
})

describe('the port over two linked fake wires', () => {
  it('answers a call across the link', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const satchelPort = createPeerPort(satchel)
    await shelfPort.serve([echo])
    const channel = await satchelPort.connect(shelf.id)
    const answer = await channel.call('sync.echo', { n: 1 })
    expect(answer).toEqual({ echoed: { n: 1 } })
    await channel.close()
  })

  it('refuses before the handler when the grant is missing', async () => {
    const { shelf, satchel } = linkedWires()
    await shelf.setGrants(satchel.id, []) // paired, granted nothing
    const shelfPort = createPeerPort(shelf)
    const satchelPort = createPeerPort(satchel)
    let ran = 0
    await shelfPort.serve([{ ...echo, handler: async () => void (ran += 1) }])
    const channel = await satchelPort.connect(shelf.id)
    await expect(channel.call('sync.echo', null)).rejects.toMatchObject({
      name: 'ServiceCallError',
      error: { code: 'forbidden' },
    })
    expect(ran).toBe(0)
  })

  it('a connect to a peer that is not ready is refused, typed', async () => {
    const { shelf, satchel } = linkedWires()
    const satchelPort = createPeerPort(satchel)
    // No serve() on the shelf — peer_ready never called.
    await expect(satchelPort.connect(shelf.id)).rejects.toMatchObject({ kind: 'sessionRefused' })
  })

  it('fetchBlob resolves on done, rejects typed on a missing blob and on a bad hash', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const satchelPort = createPeerPort(satchel)
    await shelfPort.serve([echo])
    await satchelPort.connect(shelf.id)

    const bytes = new TextEncoder().encode('the book bytes')
    shelf.blobs.set('bk1/content.epub', bytes)
    const hash = await fakeBlobHash(bytes)

    const stages: string[] = []
    const transfers = countingTransfers(satchel)
    expect(
      await settledness(
        satchelPort.fetchBlob(
          { peerId: shelf.id, folder: 'bk1', name: 'content.epub', expectedSize: bytes.length, expectedHash: hash },
          (event) => void stages.push(event.state),
        ),
      ),
    ).toEqual({ state: 'resolved', value: undefined })
    expect(satchel.blobs.get('bk1/content.epub')).toEqual(bytes)
    expect(stages).toEqual(['running', 'done'])

    expect(
      (
        await refusedNow(
          satchelPort.fetchBlob({ peerId: shelf.id, folder: 'bk1', name: 'cover.jpg', expectedSize: 1, expectedHash: hash }),
        )
      ).message,
    ).toBe('blob fetch failed: blobRefused')
    expect(
      (
        await refusedNow(
          satchelPort.fetchBlob({
            peerId: shelf.id,
            folder: 'bk1',
            name: 'content.epub',
            expectedSize: bytes.length,
            expectedHash: '0'.repeat(64),
          }),
        )
      ).message,
    ).toBe('blob fetch failed: blobHashMismatch')
    /* ⚠️ **A FETCH THAT IS OVER STOPS LISTENING**, whichever way it ended. The
       listener is the transfer's only reader, and one left behind judges the
       next transfer's events against a promise that has already settled. */
    expect(transfers).toEqual({ taken: 3, released: 3 })
  })

  it('narrowing a peer\'s grants mid-session refuses the next call on the OPEN session (H1)', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const satchelPort = createPeerPort(satchel)
    await shelfPort.serve([echo]) // echo needs sync:pull; the satchel starts with sync:*
    const channel = await satchelPort.connect(shelf.id)
    expect(await channel.call('sync.echo', { n: 1 })).toEqual({ echoed: { n: 1 } })
    // Revoke through THIS port; the router's cache must refresh and the open
    // session must feel it — the next call is forbidden, not answered stale.
    await shelfPort.setGrants(satchel.id, [])
    await expect(channel.call('sync.echo', { n: 2 })).rejects.toMatchObject({
      name: 'ServiceCallError',
      error: { code: 'forbidden' },
    })
    await channel.close()
  })

  it('a session dropped by the link rejects in-flight calls and reports closed (M7)', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const satchelPort = createPeerPort(satchel)
    let release: () => void = () => {}
    await shelfPort.serve([{ name: 'sync.slow', grant: 'sync:pull', handler: () => new Promise((resolve) => (release = () => resolve(null))) }])
    const channel = await satchelPort.connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    const inflight = watching(channel.call('sync.slow', null))
    await new Promise((resolve) => setTimeout(resolve, 0))
    satchel.setOnline(false) // severs the link, closing every session with `lost`
    const outcome = await inflight()
    expect(outcome.state, 'the call was left waiting out its own timeout on a link that had gone').toBe('refused')
    expect((outcome as { thrown: unknown }).thrown).toBeInstanceOf(ServiceCallError)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toEqual(['lost'])
    release()
  })

  it('forgetting the peer mid-session closes the channel and rejects what was in flight', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const satchelPort = createPeerPort(satchel)
    let release: () => void = () => {}
    const slow: ServiceContribution = {
      name: 'sync.slow',
      grant: 'sync:pull',
      handler: () =>
        new Promise((resolve) => {
          release = () => resolve(null)
        }),
    }
    await shelfPort.serve([slow])
    const channel = await satchelPort.connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    const inFlight = watching(channel.call('sync.slow', null))
    // Let the request reach the shelf before the revocation.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await shelfPort.forgetPeer(satchel.id)
    const outcome = await inFlight()
    expect(outcome.state, 'the call was left waiting out its own timeout on a session that had gone').toBe('refused')
    expect((outcome as { thrown: unknown }).thrown).toBeInstanceOf(ServiceCallError)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toEqual(['revoked'])
    release()
  })

  it('binds a pairing confirmation to the attempt id — a mismatch is refused, the right one confirms (M9)', async () => {
    const { shelf, satchel } = linkedWires()
    const offer = await shelf.pairBegin('Shelf')
    let attemptId = ''
    shelf.onPairingPending((event) => (attemptId = event.attemptId))
    await satchel.pairFromUri(offer.url, 'Phone')
    expect(attemptId).not.toBe('')
    // A confirmation bound to a DIFFERENT (e.g. pre-played) attempt is refused,
    // and must not consume the pending one.
    expect((await refusalOf(shelf.pairConfirm(true, ['sync:*'], 'att-someone-else'))).message, 'refused for the BINDING, not for some other reason').toBe('confirmation does not match the pending pairing attempt')
    // The attempt the human is actually looking at confirms.
    const peer = await shelf.pairConfirm(true, ['sync:*'], attemptId)
    expect(peer).not.toBeNull()
  })
})

describe('audit-fix round 1 — the port and the wire’s listeners', () => {
  it('does not dial until every listener has attached, and a registration that failed refuses the dial', async () => {
    /* `listen` registers asynchronously while the wire's subscriptions are
       synchronous; a session that opened into an unattached listener was a
       peer that looked silent. */
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    await shelfPort.serve([])
    const order: string[] = []
    let attach!: () => void
    const attached = new Promise<void>((resolve) => {
      attach = resolve
    })
    const slow: typeof satchel = Object.assign(Object.create(Object.getPrototypeOf(satchel)), satchel, {
      whenListening: async () => {
        order.push('whenListening')
        await attached
      },
      connect: async (peerId: string, hello?: unknown) => {
        order.push('connect')
        return satchel.connect(peerId, hello)
      },
    })
    const dialing = createPeerPort(slow).connect(shelf.id)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(order).toEqual(['whenListening'])
    attach()
    const channel = await dialing
    expect(order).toEqual(['whenListening', 'connect'])
    await channel.close()

    const broken: typeof satchel = Object.assign(Object.create(Object.getPrototypeOf(satchel)), satchel, {
      whenListening: async () => {
        throw new Error('listen refused: event system gone')
      },
    })
    await expect(createPeerPort(broken).connect(shelf.id)).rejects.toThrow(/listen refused/)
  })

  it('replays a close that happened during the dial to a listener registered afterwards', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([])
    /* The peer closes the session the moment it is dialed — before the
       caller has the channel, and before it could have subscribed. */
    const flighty: typeof satchel = Object.assign(Object.create(Object.getPrototypeOf(satchel)), satchel, {
      connect: async (peerId: string, hello?: unknown) => {
        const id = await satchel.connect(peerId, hello)
        await satchel.close(id)
        return id
      },
    })
    const channel = await createPeerPort(flighty).connect(shelf.id)
    const reasons: string[] = []
    channel.onClosed((reason) => reasons.push(reason))
    expect(reasons).toHaveLength(1)
  })
})

describe('a router that hung up on its own', () => {
  /**
   * ⚠️ **THE PORT COULD NOT HEAR THE ROUTER HANG UP.**
   *
   * The envelope disconnects a connection by itself in two cases the port
   * does not raise: the outbound byte budget overflowing, and a `send` that
   * fails in a way the port's own `.catch` never sees — a SYNCHRONOUS throw
   * returns no promise for that `.catch` to attach to. The native session
   * then stayed open with the router behind it dead: every later frame was
   * drained into a connection answered by nobody, and the peer waited on a
   * request that could never be refused. The webhost pump was caught by the
   * same defect (the 2026-08-28 audit, #61); `onDisconnect` is what both
   * sides now listen to.
   */
  it('closes the native session, so the peer is refused rather than left waiting', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const channel = await createPeerPort(satchel).connect(shelf.id)
    /* Shadowed on the instance rather than copied onto a stand-in: the wire's
       readiness, sessions and listeners all have to stay the ones the ports
       are already holding. */
    ;(shelf as unknown as { send: () => never }).send = () => {
      throw new Error('the session went away under the answer')
    }

    const closedOnShelf: number[] = []
    shelf.onSessionClosed((event) => void closedOnShelf.push(event.sessionId))

    const outcome = await Promise.race([
      channel.call('sync.echo', { n: 1 }).then(
        () => 'answered',
        () => 'refused',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 50)),
    ])
    expect(outcome, 'the peer was left waiting on a router that had already hung up').toBe('refused')
    expect(closedOnShelf, 'the native session outlived the router it belonged to').toHaveLength(1)
  })
})

describe('a download that failed named nothing', () => {
  /**
   * ⚠️ **THE KIND WAS KNOWN AT THE REJECTION AND SPENT ON THE MESSAGE.**
   *
   * `sync/lib/status.ts` chooses the reader's sentence from a thrown value's
   * `kind` FIELD — `blobRefused` → `revoked`, `blobHashMismatch` → `content`,
   * which is *"“Title”’s file couldn’t be verified"*. This port rejected with
   * a plain `Error` carrying the kind as PROSE, so `refusalKind` found no
   * field and answered `unknown`: every failed download reached the reader as
   * "Sync failed" while the sentences written for these failures could not be
   * reached from here at all. Found by audit, 2026-09-14.
   *
   * Asserted on the SHAPE here rather than through `refusalKind` — `peer` may
   * not import `sync` — and end to end in `sync/index.test.ts`, which drives
   * a real failed download to the sentence.
   */
  const request = (over: Partial<BlobRequest> = {}): BlobRequest => ({
    peerId: 'shelf',
    folder: 'bk1',
    name: 'content.epub',
    expectedSize: 1,
    expectedHash: '0'.repeat(64),
    ...over,
  })

  it('carries the plugin’s own kind, beside the sentence it already said', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const satchelPort = createPeerPort(satchel)
    await shelfPort.serve([echo])
    await satchelPort.connect(shelf.id)
    const bytes = new TextEncoder().encode('the book bytes')
    shelf.blobs.set('bk1/content.epub', bytes)

    // A blob the shelf will not serve: `blobRefused`, which is `revoked`.
    const ungranted = await refusedNow(
      satchelPort.fetchBlob(request({ peerId: shelf.id, name: 'cover.jpg', expectedHash: await fakeBlobHash(bytes) })),
    )
    expect(ungranted).toBeInstanceOf(BlobFetchError)
    expect(ungranted.kind, 'the field the reader’s sentence is chosen by').toBe('blobRefused')
    expect(ungranted.message).toBe('blob fetch failed: blobRefused')
    expect(ungranted.name).toBe('BlobFetchError')

    // Bytes that do not verify: `blobHashMismatch`, which is `content`.
    const unverified = await refusedNow(satchelPort.fetchBlob(request({ peerId: shelf.id, expectedSize: bytes.length })))
    expect(unverified.kind).toBe('blobHashMismatch')
    expect(unverified.message).toBe('blob fetch failed: blobHashMismatch')
  })

  /** A wire whose transfers the test fires by hand, one id at a time. */
  const byHand = (satchel: FakeWire, transferId: number) => {
    let fire: (event: TransferProgress) => void = () => {}
    let released = 0
    const wire: FakeWire = Object.assign(Object.create(Object.getPrototypeOf(satchel)), satchel, {
      onTransfer: (fn: (event: TransferProgress) => void) => {
        fire = fn
        return () => void (released += 1)
      },
      blobFetch: async () => transferId,
    })
    return { wire, fire: (event: TransferProgress) => fire(event), listener: () => ({ released }) }
  }

  it('says unknown, as a kind and not only as a word, for a failure the plugin did not name', async () => {
    const { satchel } = linkedWires()
    const plugin = byHand(satchel, 7)
    const refused = watching(createPeerPort(plugin.wire).fetchBlob(request()))
    /* Before the transfer id is known — the port buffers what arrives early
       and judges it once `blobFetch` has answered. */
    plugin.fire({ transferId: 7, folder: 'bk1', received: 0, total: 1, state: 'failed' })

    const outcome = await refused()
    expect(outcome.state).toBe('refused')
    const thrown = (outcome as { thrown: Error & { kind?: string } }).thrown
    expect(thrown).toBeInstanceOf(BlobFetchError)
    expect(thrown.kind).toBe('unknown')
    expect(thrown.message).toBe('blob fetch failed: unknown')
    expect(plugin.listener().released, 'a fetch that failed left its listener on the wire').toBe(1)
  })

  it('settles on its own transfer, and only when that transfer is over', async () => {
    const { satchel } = linkedWires()
    const plugin = byHand(satchel, 7)
    const seen: string[] = []
    const fetched = watching(createPeerPort(plugin.wire).fetchBlob(request(), (event) => void seen.push(event.state)))
    await flush()

    /* Another transfer's failure is not this one's — the plugin reports every
       transfer this device has running on one event. */
    plugin.fire({ transferId: 8, folder: 'bk1', received: 0, total: 1, state: 'failed', error: 'blobRefused' })
    expect((await fetched()).state, 'another transfer’s failure settled this fetch').toBe('pending')

    /* And a transfer that has only STARTED is not one that is over: the bytes
       are not on disk, and a caller told otherwise reads a file that is not
       there yet. */
    plugin.fire({ transferId: 7, folder: 'bk1', received: 0, total: 1, state: 'running' })
    expect((await fetched()).state, 'a transfer that had only started answered as though it had finished').toBe('pending')

    plugin.fire({ transferId: 7, folder: 'bk1', received: 1, total: 1, state: 'done' })

    expect(await fetched()).toEqual({ state: 'resolved', value: undefined })
    expect(seen, 'the observer was handed an event belonging to another transfer').toEqual(['running', 'done'])
    expect(plugin.listener().released, 'a fetch that finished left its listener on the wire').toBe(1)
  })

  /**
   * THE OTHER ROAD OUT OF `fetchBlob`, and the same defect on it: a fetch the
   * plugin refuses BEFORE it starts — no session, a transfer already running
   * for that folder — rejects the `blobFetch` call itself. Tauri's `invoke`
   * rejects with the SERIALISED Rust error, a plain `{kind, message}` and
   * never an `Error` instance, and that kind was dropped in the conversion.
   */
  it('keeps the kind when the plugin refuses the fetch outright', async () => {
    const { satchel } = linkedWires()
    const transfers = countingTransfers(satchel)
    const refusing: typeof satchel = Object.assign(Object.create(Object.getPrototypeOf(satchel)), satchel, {
      blobFetch: () => Promise.reject({ kind: 'noSession', message: 'no open session with that peer' }),
    })

    const refused = await refusedNow(createPeerPort(refusing).fetchBlob(request()))

    expect(refused).toBeInstanceOf(BlobFetchError)
    expect(refused.kind).toBe('noSession')
    expect(refused.message, 'the plugin’s own sentence, not a second one about it').toBe('no open session with that peer')
    expect(transfers, 'a fetch the plugin refused before it started left its listener on the wire').toEqual({
      taken: 1,
      released: 1,
    })
  })

  it('passes an ordinary Error through whole, and keeps what a kindless refusal said', async () => {
    const { satchel } = linkedWires()
    const stand = (blobFetch: () => Promise<number>): typeof satchel =>
      Object.assign(Object.create(Object.getPrototypeOf(satchel)), satchel, { blobFetch })

    /* An `Error` — a listener registration that failed — has no kind and is
       handed on as it is, so its own words and its stack survive. */
    const broken = new Error('listen refused: event system gone')
    expect(await refusedNow(createPeerPort(stand(() => Promise.reject(broken))).fetchBlob(request()))).toBe(broken)

    /* No kind, but something to say: said, rather than dumped as an object. */
    const mute = await refusedNow(
      createPeerPort(stand(() => Promise.reject({ message: 'the plugin is gone' }))).fetchBlob(request()),
    )
    expect(mute).toBeInstanceOf(Error)
    expect(mute).not.toBeInstanceOf(BlobFetchError)
    expect(mute.message).toBe('the plugin is gone')

    /* Nothing to say at all: the value itself, never `[object Object]` for
       something that is not an object. */
    const bare = await refusedNow(createPeerPort(stand(() => Promise.reject('the plugin is gone'))).fetchBlob(request()))
    expect(bare.message).toBe('the plugin is gone')
    const nothing = await refusedNow(createPeerPort(stand(() => Promise.reject(null))).fetchBlob(request()))
    expect(nothing.message).toBe('null')
  })
})

describe('a serve() that fails part-way through its subscriptions', () => {
  it('rolls back the subscriptions it had already taken', async () => {
    /* THE LEAK THAT SURVIVED INSIDE ITS OWN FIX. The three registrations were
       ARGUMENTS to one `offs.push(...)`, and arguments evaluate before the
       call: a throw from the second discarded the first's unsubscribe along
       with the argument list, so the rollback iterated an EMPTY array and the
       listener stayed on the wire for the life of the process. */
    const { shelf, satchel } = linkedWires()
    let taken = 0
    let released = 0
    let listed = 0
    const listPeers = shelf.listPeers.bind(shelf)
    const brittle: typeof shelf = Object.assign(Object.create(Object.getPrototypeOf(shelf)), shelf, {
      listPeers: () => {
        listed += 1
        return listPeers()
      },
      onSessionOpen: (fn: Parameters<typeof shelf.onSessionOpen>[0]) => {
        taken += 1
        const off = shelf.onSessionOpen(fn)
        return () => {
          released += 1
          off()
        }
      },
      /* The SECOND registration — the one whose throw skips the push. */
      onSessionFrames: () => {
        throw new Error('listen refused: event system gone')
      },
    })
    const port = createPeerPort(brittle)
    await expect(port.serve([])).rejects.toThrow(/listen refused/)
    expect(taken, 'the first subscription was taken').toBe(1)
    expect(released, 'and rolled back when the second threw').toBe(1)

    /* The port-wide flag went with it: a `serve()` that rejected is not a
       server, so the next attempt must reach the wire rather than be refused
       as "already active" — and it must roll back the same way. */
    await expect(port.serve([])).rejects.toThrow(/listen refused/)
    expect(taken).toBe(2)
    expect(released).toBe(2)

    /* And the grant watcher went with them. An edit through this port must not
       re-list peers on behalf of a server that never started — the same thing
       a teardown owes, on the road a rollback takes. */
    const listedBefore = listed
    await port.setGrants(satchel.id, [])
    expect(listed, 'a serve() that rolled back left its grant watcher on the port').toBe(listedBefore)
  })
})

/**
 * ⚠️ **EVERY ROAD OUT OF A SESSION GOING WRONG REACHED NO TEST AT ALL.**
 *
 * A read that fails, a write that rejects, bytes that are not a frame, a
 * server torn down — each is written here, commented at length, and was
 * measured by nothing: a mutation sweep of this file on 2026-09-15 found
 * thirty mutants across them that no covering test reached, so the port could
 * have stopped closing sessions, stopped reporting closes, or gone on serving
 * a peer it had hung up on, and every test would still have passed.
 *
 * Each one below is a way a real peer goes away, and what is owed when it does.
 */
describe('the transport breaking under the port', () => {
  /** What a call did within `ms` — answered, refused, or neither. */
  const raced = (call: Promise<unknown>, ms: number): Promise<string> =>
    Promise.race([
      call.then(
        () => 'answered',
        () => 'refused',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), ms)),
    ])

  /** Arms this wire's reads to fail; the returned function breaks them. */
  const breakReads = (wire: FakeWire): (() => void) => {
    const real = wire.sessionRecv.bind(wire)
    let breaking = false
    Object.assign(wire, {
      sessionRecv: (id: number) =>
        breaking ? Promise.reject({ kind: 'streamRead', message: 'the stream went away under us' }) : real(id),
    })
    return () => void (breaking = true)
  }

  it('refuses a second serve() on one port, by name', async () => {
    const { shelf } = linkedWires()
    const port = createPeerPort(shelf)
    await port.serve([echo])
    expect((await refusalOf(port.serve([echo]))).message).toBe('peer port: serve() is already active — one server per port')
  })

  it('a serve() torn down gives back its listeners, its grant watcher and the port', async () => {
    const { shelf, satchel } = linkedWires()
    const held = counting(shelf)
    const port = createPeerPort(shelf)
    const stop = await port.serve([echo])
    expect(held.taken, 'session-open, session-frames and session-closed').toBe(3)
    const channel = await createPeerPort(satchel).connect(shelf.id)
    expect(await channel.call('sync.echo', { n: 1 })).toEqual({ echoed: { n: 1 } })
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    const listedBefore = held.listed

    stop()

    expect(held.released, 'every listener it had taken').toBe(3)
    /* THE SESSION IS THE PEER'S, not the server's: a shelf that stops serving
       must not hang up on a reader mid-page. */
    expect(closed, 'the peer’s session was closed under it').toEqual([])
    /* The grant watcher went too — an edit through this port no longer
       re-lists peers on behalf of a server that has stopped. */
    await port.setGrants(satchel.id, [])
    expect(held.listed, 'a stopped server was still refreshing its cache').toBe(listedBefore)
    /* And the port is free for the next server. */
    await port.serve([echo])
  })

  it('does not answer a request that was in flight when its server stopped', async () => {
    const { shelf, satchel } = linkedWires()
    const port = createPeerPort(shelf)
    let release: () => void = () => {}
    const stop = await port.serve([
      {
        name: 'sync.slow',
        grant: 'sync:pull',
        handler: () =>
          new Promise((resolve) => {
            release = () => resolve({ late: true })
          }),
      },
    ])
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    const inFlight = channel.call('sync.slow', null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    stop()
    release()

    /* Not answered — the connection the handler was speaking through went
       with the server. And not REFUSED either: the session is still the
       peer's, so nothing was closed under it. */
    expect(await raced(inFlight, 30), 'a server that stopped answered on its way out').toBe('waiting')
    expect(closed).toEqual([])
  })

  it('a stale teardown does not release the port a newer server holds', async () => {
    const { shelf, satchel } = linkedWires()
    const port = createPeerPort(shelf)
    const stale = await port.serve([echo])
    stale()
    await port.serve([echo])

    stale() // the stopped server's handle, called a second time

    expect((await refusalOf(port.serve([echo]))).message).toBe('peer port: serve() is already active — one server per port')
    const channel = await createPeerPort(satchel).connect(shelf.id)
    expect(await channel.call('sync.echo', { n: 1 }), 'the newer server stopped answering').toEqual({ echoed: { n: 1 } })
  })

  it('a serve() whose readiness fails leaves nothing serving', async () => {
    const { shelf } = linkedWires()
    const held = counting(shelf)
    const ready = shelf.ready.bind(shelf)
    let refusing = true
    Object.assign(shelf, { ready: () => (refusing ? Promise.reject(new Error('the plugin is not listening')) : ready()) })
    const port = createPeerPort(shelf)

    expect((await refusalOf(port.serve([echo]))).message).toBe('the plugin is not listening')

    expect(held.released, 'the listeners it had already taken').toBe(3)
    /* `serve()` rejecting means NOTHING is serving, so the port is free. */
    refusing = false
    await port.serve([echo])
  })

  it('a write that rejects takes the session down with the connection it belonged to', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closedOnShelf: number[] = []
    shelf.onSessionClosed((event) => void closedOnShelf.push(event.sessionId))
    /* A REJECTION, where the test above sends a synchronous THROW: those go
       different ways out, and only this one reaches the port's own `.catch`. */
    ;(shelf as unknown as { send: () => Promise<never> }).send = () =>
      Promise.reject(new Error('the session went away under the answer'))

    expect(await raced(channel.call('sync.echo', { n: 1 }), 50), 'the peer waited on a write that had already failed').toBe(
      'refused',
    )
    expect(closedOnShelf, 'the native session outlived the connection it served').toHaveLength(1)
  })

  it('a session whose frames will not read is closed and reported lost', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const breakSatchelReads = breakReads(satchel)
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    const closedOnShelf: number[] = []
    shelf.onSessionClosed((event) => void closedOnShelf.push(event.sessionId))

    breakSatchelReads()

    expect(await raced(channel.call('sync.echo', { n: 1 }), 50)).toBe('refused')
    expect(closed, 'the reader is told, by name, and told once').toEqual(['lost'])
    expect(closedOnShelf, 'the native session went with the channel').toHaveLength(1)
  })

  it('a shelf whose frames will not read drops its own end and leaves the session to the peer', async () => {
    const { shelf, satchel } = linkedWires()
    const breakShelfReads = breakReads(shelf)
    await createPeerPort(shelf).serve([echo])
    const channel = await createPeerPort(satchel).connect(shelf.id)
    expect(await channel.call('sync.echo', { n: 1 })).toEqual({ echoed: { n: 1 } })
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))

    breakShelfReads()

    expect(await raced(channel.call('sync.echo', { n: 2 }), 30), 'the shelf answered from a connection it had dropped').toBe(
      'waiting',
    )
    expect(closed, 'the shelf hung up on the peer rather than only on itself').toEqual([])
  })

  it('a shelf that cannot read a session from the moment it opens leaves the peer’s end alone', async () => {
    /* The FIRST drain, the one `serve()` starts when the session opens, rather
       than the one a later frame starts — different call sites, and only this
       one decides whether the peer's session is closed under it. */
    const { shelf, satchel } = linkedWires()
    const breakShelfReads = breakReads(shelf)
    await createPeerPort(shelf).serve([echo])
    breakShelfReads()

    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(await raced(channel.call('sync.echo', { n: 1 }), 30), 'a shelf that cannot read answered anyway').toBe('waiting')
    expect(closed, 'the shelf closed the peer’s session over a fault of its own').toEqual([])
  })

  it('a read that fails mid-session takes the answer the shelf was still writing with it', async () => {
    const { shelf, satchel } = linkedWires()
    const breakShelfReads = breakReads(shelf)
    let release: () => void = () => {}
    await createPeerPort(shelf).serve([
      {
        name: 'sync.slow',
        grant: 'sync:pull',
        handler: () =>
          new Promise((resolve) => {
            release = () => resolve({ late: true })
          }),
      },
      echo,
    ])
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const inFlight = channel.call('sync.slow', null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    breakShelfReads()
    // The frame whose read fails — it never reaches a handler.
    void channel.call('sync.echo', { n: 1 }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()

    /* The connection the slow handler was speaking through went with the read
       that failed, so its answer is not written to a session this shelf can no
       longer hold up its end of. */
    expect(await raced(inFlight, 30), 'a shelf answered through a connection it had dropped').toBe('waiting')
  })

  it('a read that fails while the shelf is still accepting the session cuts its answer too', async () => {
    /* THE DRAIN `serve()` STARTS AT SESSION OPEN, which is a different call
       site from the one a later frame starts — and the only way to put a
       request in flight on it is the window the port's own comment names:
       frames that landed before the connection existed sit in the inbox and
       are read by that first drain. The listing is held open to make the
       window certain rather than a race. */
    const { shelf, satchel } = linkedWires()
    const breakShelfReads = breakReads(shelf)
    let letListingFinish: () => void = () => {}
    const listing = new Promise<void>((resolve) => {
      letListingFinish = resolve
    })
    const listPeers = shelf.listPeers.bind(shelf)
    let holding = false
    Object.assign(shelf, {
      listPeers: async () => {
        if (holding) await listing
        return listPeers()
      },
    })
    let release: () => void = () => {}
    await createPeerPort(shelf).serve([
      {
        name: 'sync.slow',
        grant: 'sync:pull',
        /* Broken from inside the handler, so the failure lands on that drain's
           NEXT read, with this answer still owed. */
        handler: () => {
          breakShelfReads()
          return new Promise((resolve) => {
            release = () => resolve({ late: true })
          })
        },
      },
    ])
    holding = true

    const channel = await createPeerPort(satchel).connect(shelf.id)
    const inFlight = channel.call('sync.slow', null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    letListingFinish()
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()

    expect(await raced(inFlight, 30), 'a shelf answered through a connection it had dropped').toBe('waiting')
  })

  it('a session whose grants cannot be read is closed, not served ungoverned', async () => {
    const { shelf, satchel } = linkedWires()
    const listPeers = shelf.listPeers.bind(shelf)
    let listing = true
    Object.assign(shelf, { listPeers: () => (listing ? listPeers() : Promise.reject(new Error('the plugin is gone'))) })
    await createPeerPort(shelf).serve([echo])
    listing = false

    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(closed, 'a session whose grants could not be read was left open and answering').toHaveLength(1)
  })

  it('bytes that are not a frame close the session rather than being read past', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    let shelfSession = -1
    shelf.onSessionOpen((event) => void (shelfSession = event.sessionId))
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    const closedOnShelf: number[] = []
    shelf.onSessionClosed((event) => void closedOnShelf.push(event.sessionId))

    await shelf.send(shelfSession, new TextEncoder().encode('this is not an envelope frame'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(closed, 'the transport is broken under us and the reader is owed the word').toEqual(['lost'])
    expect(closedOnShelf, 'the session was read past rather than closed').toHaveLength(1)
  })

  it('a write that rejects on the dialling side loses the channel and refuses the call', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    ;(satchel as unknown as { send: () => Promise<never> }).send = () =>
      Promise.reject(new Error('the session went away under the request'))

    expect(await raced(channel.call('sync.echo', { n: 1 }), 50)).toBe('refused')
    expect(closed, 'a channel that can no longer write is still a channel, as far as the reader knew').toEqual(['lost'])
  })
})

/**
 * ⚠️ **WHAT THE PORT ONLY PASSES ON WAS MEASURED BY NOTHING.** A sweep on
 * 2026-09-15 replaced nine of its methods with `() => undefined` — the role,
 * the data root, the offer's cancel, two subscriptions, a channel's `stream`
 * and `close`, an `onClosed` unsubscribe, `hashFile` — and every test passed.
 * A pass-through is still a promise to somebody, and these are the promises.
 */
describe('what the port hands straight to the wire', () => {
  it('answers with the wire’s own role, root and digest', async () => {
    const { shelf } = linkedWires()
    const port = createPeerPort(shelf)
    const bytes = new TextEncoder().encode('the book bytes')
    shelf.blobs.set('bk1/content.epub', bytes)

    expect(await port.localRole()).toBe('shelf')
    expect(await port.dataRoot()).toBe(`/fake/${shelf.id}`)
    expect(await port.hashFile('bk1', 'content.epub')).toEqual({
      blake3: await fakeBlobHash(bytes),
      size: bytes.length,
    })
  })

  it('cancels the standing offer, so the code on screen stops working', async () => {
    const { shelf, satchel } = linkedWires()
    const port = createPeerPort(shelf)
    const offer = await port.pairBegin('Shelf')

    await port.pairCancel()

    expect((await refusalOf(satchel.pairFromUri(offer.url, 'Phone'))).message).toBe('no such offer')
  })

  it('subscribes the caller to sessions opening and to transfers', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const opened: number[] = []
    shelfPort.onSessionOpen((event) => void opened.push(event.sessionId))
    await shelfPort.serve([echo])
    const satchelPort = createPeerPort(satchel)
    const stages: string[] = []
    satchelPort.onTransfer((event) => void stages.push(event.state))
    await satchelPort.connect(shelf.id)
    const bytes = new TextEncoder().encode('the book bytes')
    shelf.blobs.set('bk1/content.epub', bytes)

    await answerTo(
      satchelPort.fetchBlob({
        peerId: shelf.id,
        folder: 'bk1',
        name: 'content.epub',
        expectedSize: bytes.length,
        expectedHash: await fakeBlobHash(bytes),
      }),
    )

    expect(opened, 'the session the satchel dialled').toHaveLength(1)
    expect(stages).toEqual(['running', 'done'])
  })

  it('carries a stream across the link, in the order it was yielded', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([
      {
        name: 'sync.pages',
        grant: 'sync:pull',
        handler: async function* () {
          yield { page: 1 }
          yield { page: 2 }
          yield { page: 3 }
        },
      },
    ])
    const channel = await createPeerPort(satchel).connect(shelf.id)

    expect(await answerTo(drained(channel.stream('sync.pages', null)))).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }])
  })

  it('closes the session the channel belongs to, and stops telling a listener that unsubscribed', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closedOnShelf: number[] = []
    shelf.onSessionClosed((event) => void closedOnShelf.push(event.sessionId))
    const heard: string[] = []
    const off = channel.onClosed((reason) => void heard.push(reason))
    const kept: string[] = []
    channel.onClosed((reason) => void kept.push(reason))

    off()
    await channel.close()
    await flush()

    expect(closedOnShelf, 'the peer was left holding a session the reader had closed').toHaveLength(1)
    expect(kept).toEqual(['closed'])
    expect(heard, 'a listener that gave back its unsubscribe was told anyway').toEqual([])
  })
})

/**
 * ⚠️ **THE DRAIN'S WHOLE STATE MACHINE WAS MEASURED BY NOTHING.** The rerun
 * flag, the one-at-a-time rule and the abort were all written with a reason
 * beside them, and a sweep on 2026-09-15 could take every one of them away —
 * fourteen mutants across sixteen lines — with the suite still green. Each
 * test here is one of those reasons, read back through the wire: what the
 * plugin is asked to read, when, and what stops it.
 */
describe('one drain of a session at a time', () => {
  it('reads a session once at a time, however many events ask it to', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const reads = holdReads(satchel)
    const channel = await createPeerPort(satchel).connect(shelf.id)
    await flush()

    reads.hold()
    const first = channel.call('sync.echo', { n: 1 })
    await flush()
    const second = channel.call('sync.echo', { n: 2 })
    await flush()

    /* Two reads of one session in flight together race two splices, and the
       frames come back in whichever order they answer. */
    expect(reads.held.mostLive, 'a second drain read the session the first was reading').toBe(1)

    reads.free()
    reads.release()
    expect(await settledness(first)).toEqual({ state: 'resolved', value: { echoed: { n: 1 } } })
    expect(await settledness(second)).toEqual({ state: 'resolved', value: { echoed: { n: 2 } } })
  })

  it('picks up a frame that landed while it was between reads', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const reads = holdReads(satchel)
    reads.hold()
    const channel = await createPeerPort(satchel).connect(shelf.id)

    /* The dial's own first read is held over an EMPTY inbox: the answer lands
       after the plugin spliced, so nothing but the rerun flag will go back for
       it — the edge event it raised was spent on a drain already running. */
    const answer = channel.call('sync.echo', { n: 1 })
    await flush()
    reads.free()
    reads.release()

    expect(await settledness(answer)).toEqual({ state: 'resolved', value: { echoed: { n: 1 } } })
  })

  it('stops reading a session whose frame broke the transport under it', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    let shelfSession = -1
    shelf.onSessionOpen((event) => void (shelfSession = event.sessionId))
    const reads = holdReads(satchel)
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    await flush()

    const readsSoFar = reads.held.reads
    await shelf.send(shelfSession, new TextEncoder().encode('this is not an envelope frame'))
    await flush()

    expect(closed, 'the reader is owed the word').toEqual(['lost'])
    expect(reads.held.reads, 'the port read on past the frame that lost it the session').toBe(readsSoFar + 1)
  })

  it('stops reading a session its peer has closed, on the side that was serving it', async () => {
    /* The shelf's own drain, dropped from the other end — `dropConnection`'s
       abort rather than the channel's, and a different call site. */
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const reads = holdReads(shelf)
    const channel = await createPeerPort(satchel).connect(shelf.id)
    await flush()

    reads.hold()
    const answered = watching(channel.call('sync.echo', { n: 1 }))
    await flush()
    const readsSoFar = reads.held.reads
    await channel.close()
    await flush()
    reads.free()
    reads.release()
    await flush()

    expect(reads.held.reads, 'the shelf read on from a session its peer had closed').toBe(readsSoFar)
    expect((await answered()).state).toBe('refused')
  })

  it('tells the reader once when two roads out of the session run together', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const reads = holdReads(satchel)
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const closed: string[] = []
    channel.onClosed((reason) => void closed.push(reason))
    await flush()

    reads.hold()
    const answered = watching(channel.call('sync.echo', { n: 1 }))
    await flush()
    // Road one: the session closes.
    await channel.close()
    await flush()
    // Road two: the read that was in flight fails, on a session already gone.
    reads.fail({ kind: 'streamRead', message: 'the stream went away under us' })
    await flush()

    expect(closed, 'one channel closed, and the reader was told twice').toEqual(['closed'])
    expect((await answered()).state, 'the call was left waiting on a channel that had gone').toBe('refused')
  })
})

/**
 * ⚠️ **A NARROWING THAT ONLY WORKS WHEN THE NEXT LISTING SUCCEEDS IS NOT A
 * NARROWING.** `setGrants` writes the committed grants into the router's cache
 * by hand BEFORE the listing that would have brought them, precisely so a
 * listing that fails cannot leave an open session judged by grants the store no
 * longer holds — and a sweep on 2026-09-15 could delete that whole block, the
 * recheck inside it, and the newest-wins guard the cache is published under,
 * with every test still green. H1 above only ever measured the happy road.
 */
describe('a grant edit reaches the session already open', () => {
  const slowly = (): { service: ServiceContribution; release: () => void } => {
    let release: () => void = () => {}
    return {
      service: {
        name: 'sync.slow',
        grant: 'sync:pull',
        handler: () =>
          new Promise((resolve) => {
            release = () => resolve({ late: true })
          }),
      },
      release: () => release(),
    }
  }

  it('narrows a session already open even when the listing that follows cannot be read', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const slow = slowly()
    await shelfPort.serve([slow.service, echo])
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const answered = watching(channel.call('sync.slow', null))
    await flush()

    /* From here the shelf cannot list its peers at all: only what the edit
       itself puts in the cache can refuse anything. */
    Object.assign(shelf, { listPeers: () => Promise.reject(new Error('the plugin is gone')) })

    // Narrowed, and still granted: neither the request running nor the next one.
    expect((await refusalOf(shelfPort.setGrants(satchel.id, ['sync:pull']))).message).toBe('the plugin is gone')
    expect((await answered()).state, 'a grant it still holds refused the request already running').toBe('pending')
    expect(await answerTo(channel.call('sync.echo', { n: 1 }))).toEqual({ echoed: { n: 1 } })

    // Narrowed past it: the request already running is refused, by name.
    expect((await refusalOf(shelfPort.setGrants(satchel.id, ['sync:push']))).message).toBe('the plugin is gone')
    expect(await answered()).toMatchObject({
      state: 'refused',
      thrown: { name: 'ServiceCallError', error: { code: 'forbidden', message: 'grant revoked' } },
    })
    slow.release()
  })

  it('refuses a peer the listing does not name, and an edit does not smuggle one in', async () => {
    const { shelf, satchel } = linkedWires()
    let listing: 'empty' | 'broken' = 'empty'
    Object.assign(shelf, {
      listPeers: () => (listing === 'empty' ? Promise.resolve([]) : Promise.reject(new Error('the plugin is gone'))),
    })
    const shelfPort = createPeerPort(shelf)
    await shelfPort.serve([echo])
    const channel = await createPeerPort(satchel).connect(shelf.id)

    /* Not in the cache at all — which is not the same as granted, and the
       default for a peer the router has never heard of is refusal. */
    expect(await refusedNow(channel.call('sync.echo', { n: 1 }))).toMatchObject({ error: { code: 'forbidden' } })

    listing = 'broken'
    expect((await refusalOf(shelfPort.setGrants(satchel.id, ['sync:*']))).message).toBe('the plugin is gone')

    expect(
      await refusedNow(channel.call('sync.echo', { n: 2 })),
      'an edit put a peer no listing ever named into the cache',
    ).toMatchObject({ error: { code: 'forbidden' } })
  })

  it('an older listing landing last does not restore the grants a newer one narrowed', async () => {
    const { shelf, satchel } = linkedWires()
    const [row] = await shelf.listPeers()
    const wide = [{ ...(row as WirePeer), grants: ['sync:*'] }]
    const narrow = [{ ...(row as WirePeer), grants: [] }]
    const answers: ((rows: readonly WirePeer[]) => void)[] = []
    Object.assign(shelf, {
      listPeers: () => new Promise<readonly WirePeer[]>((resolve) => void answers.push(resolve)),
    })
    const shelfPort = createPeerPort(shelf)
    const serving = shelfPort.serve([echo])
    await flush()
    answers.shift()?.(wide) // the refresh `serve()` itself waits for
    await serving
    const channel = await createPeerPort(satchel).connect(shelf.id)
    await flush()
    answers.shift()?.(wide) // and the one the session opening asks for
    await flush()
    expect(await answerTo(channel.call('sync.echo', { n: 1 }))).toEqual({ echoed: { n: 1 } })

    /* Two edits whose listings overlap: the OLDER is still in flight when the
       newer lands, and it carries what the store held before either. */
    const first = shelfPort.setGrants(satchel.id, ['sync:*'])
    await flush()
    const second = shelfPort.setGrants(satchel.id, [])
    await flush()
    const older = answers.shift()
    const newer = answers.shift()
    newer?.(narrow)
    await flush()
    older?.(wide)
    await Promise.all([first, second])

    expect(
      await refusedNow(channel.call('sync.echo', { n: 2 })),
      'a listing taken before the narrowing re-authorised the peer it had narrowed',
    ).toMatchObject({ error: { code: 'forbidden' } })
  })

  it('a listing that lands rechecks the sessions already open, whoever made the edit', async () => {
    const { shelf, satchel } = linkedWires()
    const shelfPort = createPeerPort(shelf)
    const slow = slowly()
    await shelfPort.serve([slow.service])
    const satchelPort = createPeerPort(satchel)
    const channel = await satchelPort.connect(shelf.id)
    const answered = watching(channel.call('sync.slow', null))
    await flush()

    /* The edit does NOT go through this port — another writer narrowed the
       grants, so nothing tells the router until a listing lands. */
    await shelf.setGrants(satchel.id, [])
    await satchelPort.connect(shelf.id)
    await flush()

    expect(await answered(), 'the request went on running for a peer whose grant had gone').toMatchObject({
      state: 'refused',
      thrown: { name: 'ServiceCallError', error: { code: 'forbidden', message: 'grant revoked' } },
    })
    slow.release()
  })
})

/**
 * ⚠️ **THE THREE GUARDS `serve()` PUTS ROUND A SESSION WERE MEASURED BY
 * NOTHING** — the one that leaves this device's OWN dials alone, the one that
 * refuses to register a connection for a server that has stopped, and the one
 * that drops its end when the peer hangs up. Each was a surviving mutant on
 * 2026-09-15, and each is a way a shelf goes on serving somebody it should not.
 */
describe('what a shelf takes on, and what it leaves alone', () => {
  it('does not serve a session this device dialled as if a stranger had dialled in', async () => {
    /* One device doing both — a satchel that answers as well as asks. Its
       server hears the session it DIALLED open, with `initiator` set, and
       everything that arrives on that session is its own client's answers. A
       server that takes it on reads the peer's grants for it, registers a
       router connection nobody authorised, and drains into that router the
       frames the client is waiting for: the reader's own request never
       answers, and the peer is answered on a connection that was never an
       inbound one. */
    const { shelf, satchel } = linkedWires()
    const listings = { dialled: 0, dialling: 0 }
    const listShelf = shelf.listPeers.bind(shelf)
    const listSatchel = satchel.listPeers.bind(satchel)
    Object.assign(shelf, {
      listPeers: () => {
        listings.dialled += 1
        return listShelf()
      },
    })
    Object.assign(satchel, {
      listPeers: () => {
        listings.dialling += 1
        return listSatchel()
      },
    })
    await createPeerPort(shelf).serve([echo])
    const port = createPeerPort(satchel)
    await port.serve([echo])
    const before = { ...listings }

    await port.connect(shelf.id)
    await flush()

    /* The control, on the same event and the same code: the side that was
       DIALLED does take the session on, and reads its grants to do it. */
    expect(listings.dialled, 'the dialled side left an inbound session unserved').toBe(before.dialled + 1)
    expect(listings.dialling, 'the dialling side served the session it had opened itself').toBe(before.dialling)
  })

  it('does not serve a session that opened while it was stopping', async () => {
    const { shelf, satchel } = linkedWires()
    const port = createPeerPort(shelf)
    let letListingFinish: () => void = () => {}
    const listPeers = shelf.listPeers.bind(shelf)
    let holding = false
    Object.assign(shelf, {
      listPeers: async () => {
        if (holding) {
          await new Promise<void>((resolve) => {
            letListingFinish = resolve
          })
        }
        return listPeers()
      },
    })
    const stop = await port.serve([echo])
    holding = true

    /* The session opens, and its grants are still being read when the server
       goes away. Registering it then would hand a connection to a server that
       no longer exists — and nothing would ever take it back. The request is
       made while the listing is held, so it is sitting in the inbox that first
       drain would read. */
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const answered = watching(channel.call('sync.echo', { n: 1 }))
    await flush()
    stop()
    letListingFinish()
    await flush()

    expect((await answered()).state, 'a server that had stopped answered anyway').toBe('pending')
  })

  it('drops its end when the peer closes, and does not close a session it was just told is gone', async () => {
    const { shelf, satchel } = linkedWires()
    const port = createPeerPort(shelf)
    let signal: AbortSignal | null = null
    let release: () => void = () => {}
    await port.serve([
      {
        name: 'sync.slow',
        grant: 'sync:pull',
        handler: (_req, ctx) => {
          signal = ctx.signal
          return new Promise((resolve) => {
            release = () => resolve({ late: true })
          })
        },
      },
    ])
    const closes: number[] = []
    const close = shelf.close.bind(shelf)
    Object.assign(shelf, {
      close: (sessionId: number) => {
        closes.push(sessionId)
        return close(sessionId)
      },
    })
    const channel = await createPeerPort(satchel).connect(shelf.id)
    const answered = watching(channel.call('sync.slow', null))
    await flush()

    await channel.close()
    await flush()

    expect((signal as AbortSignal | null)?.aborted, 'the handler ran on for a peer that had gone').toBe(true)
    expect(closes, 'the shelf closed a session the plugin had just told it was closed').toEqual([])
    expect((await answered()).state).toBe('refused')
    release()
  })
})

/**
 * ⚠️ **ONE DEVICE CAN HOLD TWO CHANNELS, AND EVERY GUARD THAT KEEPS THEM APART
 * WAS A SURVIVING MUTANT.** The close listener's session match, the frame
 * listener's, and the replay of a close that raced the dial: with any of them
 * gone one channel answers for another's session — a reader told a book they
 * are still reading has closed, or a channel torn down over somebody else's
 * hang-up. Every test in this file used one channel until 2026-09-16.
 */
describe('two channels on one device', () => {
  it('hears only its own session, whatever the other one does', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const port = createPeerPort(satchel)
    const first = await port.connect(shelf.id)
    const second = await port.connect(shelf.id)
    const firstClosed: string[] = []
    first.onClosed((reason) => void firstClosed.push(reason))
    const reads = holdReads(satchel)
    await flush()
    const readsOfFirst = reads.held.bySession.get(first.sessionId) ?? 0

    expect(await answerTo(second.call('sync.echo', { n: 1 }))).toEqual({ echoed: { n: 1 } })
    await flush()

    expect(
      reads.held.bySession.get(first.sessionId) ?? 0,
      'a frame that belonged to the other session made this one read',
    ).toBe(readsOfFirst)

    await second.close()
    await flush()

    expect(firstClosed, 'a channel heard another session’s close as its own').toEqual([])
    expect(await answerTo(first.call('sync.echo', { n: 2 }))).toEqual({ echoed: { n: 2 } })
  })

  it('does not take a close that raced the dial as its own', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const first = await createPeerPort(satchel).connect(shelf.id)
    /* The FIRST session closes while the second is being dialled, so its close
       lands on a listener that does not yet know which session is its own and
       buffers it. Replayed against the wrong id, it closes a channel the
       caller has not even been handed yet. */
    const racing: typeof satchel = Object.assign(Object.create(Object.getPrototypeOf(satchel)), satchel, {
      connect: async (peerId: string, hello?: unknown) => {
        const id = await satchel.connect(peerId, hello)
        await satchel.close(first.sessionId)
        return id
      },
    })

    const second = await createPeerPort(racing).connect(shelf.id)
    const closed: string[] = []
    second.onClosed((reason) => void closed.push(reason))

    expect(closed, 'a close that belonged to another session was replayed onto this one').toEqual([])
    expect(await answerTo(second.call('sync.echo', { n: 1 }))).toEqual({ echoed: { n: 1 } })
  })

  it('gives back the two listeners a channel took, when it closes and when the dial fails', async () => {
    const { shelf, satchel } = linkedWires()
    await createPeerPort(shelf).serve([echo])
    const held = counting(satchel)
    const channel = await createPeerPort(satchel).connect(shelf.id)
    expect(held.taken, 'session-closed and session-frames').toBe(2)

    await channel.close()
    await flush()

    expect(held.released, 'a channel that closed left its listeners on the wire').toBe(2)

    /* And a dial that never got as far as a session: the registrations it had
       already taken are given back before it rejects. */
    const broken: typeof satchel = Object.assign(Object.create(Object.getPrototypeOf(satchel)), satchel, {
      whenListening: () => Promise.reject(new Error('listen refused: event system gone')),
    })
    expect((await refusalOf(createPeerPort(broken).connect(shelf.id))).message).toBe('listen refused: event system gone')

    expect(held.released, 'a dial that failed left its listeners on the wire').toBe(4)
  })
})

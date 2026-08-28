import { describe, expect, it } from 'vitest'
import type { ServiceContribution } from '../../../kernel'
import { ServiceCallError } from './envelope'
import { fakeBlobHash, linkedWires } from './fakeWire.testkit'
import { grantCovers } from './grants'
import { createPeerPort } from './port'

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
    await satchelPort.fetchBlob(
      { peerId: shelf.id, folder: 'bk1', name: 'content.epub', expectedSize: bytes.length, expectedHash: hash },
      (event) => void stages.push(event.state),
    )
    expect(satchel.blobs.get('bk1/content.epub')).toEqual(bytes)
    expect(stages).toEqual(['running', 'done'])

    await expect(
      satchelPort.fetchBlob({ peerId: shelf.id, folder: 'bk1', name: 'cover.jpg', expectedSize: 1, expectedHash: hash }),
    ).rejects.toThrow(/blobRefused/)
    await expect(
      satchelPort.fetchBlob({ peerId: shelf.id, folder: 'bk1', name: 'content.epub', expectedSize: bytes.length, expectedHash: '0'.repeat(64) }),
    ).rejects.toThrow(/blobHashMismatch/)
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
    const inflight = channel.call('sync.slow', null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    satchel.setOnline(false) // severs the link, closing every session with `lost`
    await expect(inflight).rejects.toBeInstanceOf(ServiceCallError)
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
    const inFlight = channel.call('sync.slow', null)
    // Let the request reach the shelf before the revocation.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await shelfPort.forgetPeer(satchel.id)
    await expect(inFlight).rejects.toBeInstanceOf(ServiceCallError)
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
    await expect(shelf.pairConfirm(true, ['sync:*'], 'att-someone-else')).rejects.toThrow()
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

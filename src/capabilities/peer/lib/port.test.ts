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
})

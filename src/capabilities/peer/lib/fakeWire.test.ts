import { describe, expect, it } from 'vitest'
import { linkedWires } from './fakeWire.testkit'

/* The fake stands in for `PeerState` across every suite above it, so what the
   switch does there has to hold here, or those suites prove a shutdown that
   nothing performed. `state.rs`'s `switch` tests pin the same answers in Rust. */
describe('the fake wire and the P2P switch', () => {
  const connected = async () => {
    const { shelf, satchel } = linkedWires()
    await shelf.ready()
    await satchel.ready()
    const session = await satchel.connect(shelf.id)
    return { shelf, satchel, session }
  }

  it('closes the sessions on both ends when it goes off', async () => {
    const { shelf, satchel } = await connected()
    const mine: string[] = []
    const theirs: string[] = []
    satchel.onSessionClosed((closed) => mine.push(closed.reason))
    shelf.onSessionClosed((closed) => theirs.push(closed.reason))
    await satchel.setP2p(false)
    expect(mine).toEqual(['closed'])
    expect(theirs).toEqual(['closed'])
  })

  it('refuses the transport while off, and as closed after going on again in the same run', async () => {
    const { shelf, satchel, session } = await connected()
    await satchel.setP2p(false)
    await expect(satchel.send(session, new Uint8Array([1]))).rejects.toMatchObject({ kind: 'p2pOff' })
    await expect(satchel.connect(shelf.id)).rejects.toMatchObject({ kind: 'p2pOff' })
    await satchel.setP2p(true)
    await expect(satchel.send(session, new Uint8Array([1]))).rejects.toMatchObject({ kind: 'peerClosed' })
    await expect(satchel.connect(shelf.id)).rejects.toMatchObject({ kind: 'peerClosed' })
    await expect(satchel.status()).rejects.toMatchObject({ kind: 'peerClosed' })
    await expect(satchel.shareResolve('a'.repeat(64), 'bytes')).rejects.toMatchObject({ kind: 'peerClosed' })
  })

  it('answers what it did to the transport, and going on again does not undo the close', async () => {
    const { satchel } = linkedWires()
    await expect(satchel.setP2p(true)).resolves.toEqual({ closed: false, recordError: null })
    await expect(satchel.setP2p(false)).resolves.toEqual({ closed: true, recordError: null })
    await expect(satchel.setP2p(true)).resolves.toEqual({ closed: true, recordError: null })
  })

  it('comes back at the next launch if the switch says on', async () => {
    const { shelf, satchel } = await connected()
    await satchel.setP2p(false)
    await satchel.setP2p(true)
    satchel.restart()
    await expect(satchel.connect(shelf.id)).resolves.toEqual(expect.any(Number))
  })

  it('stays refused at the next launch if the switch says off', async () => {
    const { shelf, satchel } = await connected()
    await satchel.setP2p(false)
    satchel.restart()
    await expect(satchel.connect(shelf.id)).rejects.toMatchObject({ kind: 'p2pOff' })
  })

  it('looks unreachable from the far side once it has gone off', async () => {
    const { shelf, satchel } = await connected()
    await satchel.setP2p(false)
    await expect(shelf.connect(satchel.id)).rejects.toMatchObject({ kind: 'iroh' })
  })

  /* The real offer lives in the endpoint that closed: nobody can reach it, and
     going on again in the same run does not bring it back. */
  describe('a pairing offer', () => {
    const offered = async () => {
      const { shelf, satchel } = linkedWires()
      await shelf.ready()
      await satchel.ready()
      const pending: { readonly attemptId: string }[] = []
      shelf.onPairingPending((event) => pending.push(event))
      const offer = await shelf.pairBegin()
      return { shelf, satchel, offer, pending }
    }

    it('cannot be claimed once its shelf has gone off', async () => {
      const { shelf, satchel, offer, pending } = await offered()
      await shelf.setP2p(false)
      await expect(satchel.pairFromUri(offer.url)).rejects.toMatchObject({ kind: 'iroh' })
      expect(pending).toEqual([])
    })

    it('cannot be claimed when its shelf goes on again in the same run', async () => {
      const { shelf, satchel, offer, pending } = await offered()
      await shelf.setP2p(false)
      await shelf.setP2p(true)
      await expect(satchel.pairFromUri(offer.url)).rejects.toMatchObject({ kind: 'iroh' })
      expect(pending).toEqual([])
    })

    it('does not survive the restart that reopens the transport', async () => {
      const { shelf, satchel, offer } = await offered()
      await shelf.setP2p(false)
      await shelf.setP2p(true)
      shelf.restart()
      await expect(satchel.pairFromUri(offer.url)).rejects.toMatchObject({ kind: 'noPendingPairing' })
    })

    it('leaves nothing to confirm when the shelf goes off mid-comparison', async () => {
      const { shelf, satchel, offer, pending } = await offered()
      await satchel.pairFromUri(offer.url)
      await shelf.setP2p(false)
      await shelf.setP2p(true)
      shelf.restart()
      await expect(shelf.pairConfirm(true, undefined, pending[0]!.attemptId)).rejects.toMatchObject({ kind: 'noPendingPairing' })
    })
  })
})

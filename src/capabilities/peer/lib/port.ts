import type { ServiceContribution } from '../../../kernel'
import { createClient, createRouter, type CallOptions, type RouterConnection } from './envelope'
import { grantCovers } from './grants'
import type {
  BlobRequest,
  HashResult,
  PairOffer,
  PairStart,
  PairingPending,
  PairingResult,
  PeerRole,
  PeerStatus,
  PeerWire,
  SessionOpen,
  TransferProgress,
  Unsubscribe,
  WirePeer,
} from './wire'

/**
 * The PORT — what the peer capability offers the capabilities that
 * `require` it. A typed surface over the wire plus the envelope: the shelf
 * side `serve`s a router of service contributions across every incoming
 * session; the satchel side `connect`s and gets a `Channel`, which is the
 * envelope `Client` bound to that one session. Blobs and the peers/pairing
 * surface pass through, typed.
 *
 * GRANTS are checked before dispatch from a CACHE of `peers.json`,
 * refreshed on every incoming session and on every grant edit made through
 * this port. The plugin is the authority — it refuses a revoked peer's next
 * frame by closing the session (`revoked`), so the cache is defence in
 * depth, not the wall — but a check that awaited IPC per frame would put an
 * async hole inside the router's dispatch, and the session-scoped refresh
 * closes the gap to "changed mid-session by another writer", which the
 * plugin already covers.
 */

export interface Channel {
  readonly sessionId: number
  readonly peerId: string
  /** The envelope client's `call`, on this session. */
  call(service: string, body: unknown, options?: CallOptions): Promise<unknown>
  /** The envelope client's `stream`, on this session. */
  stream(service: string, body: unknown, options?: CallOptions): AsyncIterable<unknown>
  close(): Promise<void>
  onClosed(fn: (reason: string) => void): Unsubscribe
}

export interface PeerPort {
  status(): Promise<PeerStatus>
  localRole(): Promise<PeerRole>
  dataRoot(): Promise<string>
  /** The plugin's durability primitive — the sync journal's fsync hook. */
  fsync(path: string): Promise<void>

  listPeers(): Promise<readonly WirePeer[]>
  forgetPeer(id: string): Promise<void>
  setGrants(id: string, grants: readonly string[]): Promise<void>

  pairBegin(name?: string): Promise<PairOffer>
  pairCancel(): Promise<void>
  pairConfirm(accept: boolean, grants?: readonly string[]): Promise<WirePeer | null>
  pairFromUri(uri: string, name?: string, grants?: readonly string[]): Promise<PairStart>

  onPairingPending(fn: (event: PairingPending) => void): Unsubscribe
  onPairingResult(fn: (event: PairingResult) => void): Unsubscribe
  onSessionOpen(fn: (event: SessionOpen) => void): Unsubscribe
  onTransfer(fn: (event: TransferProgress) => void): Unsubscribe

  /**
   * Shelf side: answer `services` on every incoming session, grants checked
   * before dispatch, and tell the plugin the webview is listening
   * (`peer_ready`). Resolves once serving; the return tears it down.
   */
  serve(services: Iterable<ServiceContribution>): Promise<Unsubscribe>
  /** Satchel side: dial a paired peer and get the envelope client on it. */
  connect(peerId: string): Promise<Channel>

  /** A blob from a peer, resolved when the transfer is DONE — not merely
   *  started. Rejects with the transfer's typed error string. */
  fetchBlob(request: BlobRequest, onProgress?: (event: TransferProgress) => void): Promise<void>
  /** BLAKE3 + size of a blob in THIS device's data root. */
  hashFile(folder: string, name: string): Promise<HashResult>
}

export function createPeerPort(wire: PeerWire): PeerPort {
  /* One drain per session at a time, with a rerun flag: two overlapping
   * drains would interleave their delivery order across awaits, and frame
   * order is the envelope's ground. */
  const drains = new Map<number, { running: boolean; again: boolean }>()
  const drainInto = async (sessionId: number, deliver: (bytes: Uint8Array) => void): Promise<void> => {
    let state = drains.get(sessionId)
    if (!state) {
      state = { running: false, again: false }
      drains.set(sessionId, state)
    }
    if (state.running) {
      state.again = true
      return
    }
    state.running = true
    try {
      do {
        state.again = false
        for (;;) {
          const frames = await wire.sessionRecv(sessionId)
          if (frames.length === 0) break
          for (const frame of frames) deliver(frame)
        }
      } while (state.again)
    } finally {
      state.running = false
    }
  }

  return {
    status: () => wire.status(),
    localRole: () => wire.localRole(),
    dataRoot: () => wire.dataRoot(),
    fsync: (path) => wire.fsync(path),

    listPeers: () => wire.listPeers(),
    forgetPeer: (id) => wire.forgetPeer(id),
    setGrants: (id, grants) => wire.setGrants(id, grants),

    pairBegin: (name) => wire.pairBegin(name),
    pairCancel: () => wire.pairCancel(),
    pairConfirm: (accept, grants) => wire.pairConfirm(accept, grants),
    pairFromUri: (uri, name, grants) => wire.pairFromUri(uri, name, grants),

    onPairingPending: (fn) => wire.onPairingPending(fn),
    onPairingResult: (fn) => wire.onPairingResult(fn),
    onSessionOpen: (fn) => wire.onSessionOpen(fn),
    onTransfer: (fn) => wire.onTransfer(fn),

    async serve(services) {
      let peers = new Map<string, WirePeer>()
      const refresh = async () => {
        peers = new Map((await wire.listPeers()).map((peer) => [peer.id, peer] as const))
      }
      const router = createRouter({
        services,
        hasGrant: (peer, grant) => {
          const held = peers.get(peer)
          return held ? grantCovers(held.grants, grant) : false
        },
      })
      const connections = new Map<number, RouterConnection>()
      const offs: Unsubscribe[] = [
        wire.onSessionOpen((event) => {
          if (event.initiator) return
          void (async () => {
            await refresh()
            const conn = router.connect(event.peerId, (bytes) => void wire.send(event.sessionId, bytes).catch(() => {}))
            connections.set(event.sessionId, conn)
            /* Frames that landed before the connection existed are in the
             * inbox and raised their one edge event already — drain now. */
            await drainInto(event.sessionId, (bytes) => conn.receive(bytes))
          })()
        }),
        wire.onSessionFrames((event) => {
          const conn = connections.get(event.sessionId)
          if (conn) void drainInto(event.sessionId, (bytes) => conn.receive(bytes))
        }),
        wire.onSessionClosed((event) => {
          const conn = connections.get(event.sessionId)
          if (!conn) return
          connections.delete(event.sessionId)
          conn.disconnect()
        }),
      ]
      await refresh()
      await wire.ready()
      return () => {
        for (const off of offs) off()
        for (const conn of connections.values()) conn.disconnect()
        connections.clear()
      }
    },

    async connect(peerId) {
      const sessionId = await wire.connect(peerId, null)
      const client = createClient({ send: (bytes) => void wire.send(sessionId, bytes).catch(() => {}) })
      const closedFns = new Set<(reason: string) => void>()
      const deliver = (bytes: Uint8Array) => {
        try {
          client.receive(bytes)
        } catch {
          /* Bytes that are not a frame mean the transport is broken under
           * us; every pending call rejects `disconnected` and the session
           * is closed rather than read further. */
          client.disconnect()
          void wire.close(sessionId).catch(() => {})
        }
      }
      const offFrames = wire.onSessionFrames((event) => {
        if (event.sessionId === sessionId) void drainInto(sessionId, deliver)
      })
      const offClosed = wire.onSessionClosed((event) => {
        if (event.sessionId !== sessionId) return
        offFrames()
        offClosed()
        client.disconnect()
        for (const fn of [...closedFns]) fn(event.reason)
      })
      // Anything that raced the subscription.
      void drainInto(sessionId, deliver)
      return {
        sessionId,
        peerId,
        call: (service, body, options) => client.call(service, body, options),
        stream: (service, body, options) => client.stream(service, body, options),
        close: () => wire.close(sessionId),
        onClosed: (fn) => {
          closedFns.add(fn)
          return () => void closedFns.delete(fn)
        },
      }
    },

    fetchBlob(request, onProgress) {
      return new Promise<void>((resolve, reject) => {
        let transferId: number | null = null
        const early: TransferProgress[] = []
        let off: Unsubscribe = () => {}
        const judge = (event: TransferProgress) => {
          if (transferId === null || event.transferId !== transferId) return
          onProgress?.(event)
          if (event.state === 'done') {
            off()
            resolve()
          } else if (event.state === 'failed') {
            off()
            reject(new Error(`blob fetch failed: ${event.error ?? 'unknown'}`))
          }
        }
        off = wire.onTransfer((event) => {
          if (transferId === null) early.push(event)
          else judge(event)
        })
        wire.blobFetch(request).then(
          (id) => {
            transferId = id
            for (const event of early.splice(0)) judge(event)
          },
          (thrown) => {
            off()
            reject(thrown instanceof Error ? thrown : new Error(String((thrown as { message?: string })?.message ?? thrown)))
          },
        )
      })
    },

    hashFile: (folder, name) => wire.hashFile(folder, name),
  }
}

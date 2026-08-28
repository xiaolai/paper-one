import type { ServiceContribution } from '../../../kernel'
import { createClient, createRouter, type CallOptions, type Client, type RouterConnection } from './envelope'
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
  SessionClosed,
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
 * GRANTS are checked before dispatch from a CACHE of `peers.json`, refreshed
 * on every incoming session AND on every grant edit made through this port —
 * and, because the router re-asks the cache on every continuation frame, a
 * narrowing reaches an OPEN session: `setGrants` refreshes the cache and then
 * has the router re-check its in-flight requests, aborting any whose grant is
 * gone. The plugin is the authority — it refuses a revoked peer's next frame
 * by closing the session (`revoked`), so the cache is defence in depth, not
 * the wall — but a check that awaited IPC per frame would put an async hole
 * inside the router's dispatch, which the live cache avoids.
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
  /**
   * Record which side this device is, for the NEXT launch.
   *
   * Not a live switch — `role.rs` is read once when the node starts and `sync`
   * binds it at its own start. A phone ignores it: the build target wins
   * outright there.
   */
  setLocalRole(role: PeerRole): Promise<void>
  dataRoot(): Promise<string>

  listPeers(): Promise<readonly WirePeer[]>
  forgetPeer(id: string): Promise<void>
  setGrants(id: string, grants: readonly string[]): Promise<void>

  pairBegin(name?: string): Promise<PairOffer>
  pairCancel(): Promise<void>
  pairConfirm(accept: boolean, grants: readonly string[] | undefined, attemptId: string): Promise<WirePeer | null>
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
   * order is the envelope's ground. Each drain is ABORTABLE (a session that
   * closes stops its loop at once) and reports a `sessionRecv` REJECTION to
   * `onError` instead of leaking an unhandled rejection; its state is deleted
   * when the session closes, so the map does not grow without bound. */
  const drains = new Map<number, { running: boolean; again: boolean; aborted: boolean }>()
  const drainInto = async (
    sessionId: number,
    deliver: (bytes: Uint8Array) => void,
    onError: (thrown: unknown) => void,
  ): Promise<void> => {
    let state = drains.get(sessionId)
    if (!state) {
      state = { running: false, again: false, aborted: false }
      drains.set(sessionId, state)
    }
    if (state.aborted) return
    if (state.running) {
      state.again = true
      return
    }
    state.running = true
    try {
      do {
        state.again = false
        for (;;) {
          if (state.aborted) return
          let frames: readonly Uint8Array[]
          try {
            frames = await wire.sessionRecv(sessionId)
          } catch (thrown) {
            state.aborted = true
            onError(thrown)
            return
          }
          if (frames.length === 0) break
          for (const frame of frames) {
            if (state.aborted) return
            deliver(frame)
          }
        }
      } while (state.again)
    } finally {
      state.running = false
    }
  }
  const abortDrain = (sessionId: number): void => {
    const state = drains.get(sessionId)
    if (state) state.aborted = true
    drains.delete(sessionId)
  }

  /* Callbacks a live `serve()` registers so a grant edit through this port can
   * refresh its cache and have its router re-check open sessions. */
  const grantWatchers = new Set<(peerId: string, grants?: readonly string[]) => Promise<void> | void>()
  /* One live server per port: two would install competing listeners and
   * race each other draining the same session inboxes. */
  let servingActive = false

  return {
    status: () => wire.status(),
    localRole: () => wire.localRole(),
    setLocalRole: (role) => wire.setLocalRole(role),
    dataRoot: () => wire.dataRoot(),

    listPeers: () => wire.listPeers(),
    forgetPeer: (id) => wire.forgetPeer(id),
    async setGrants(id, grants) {
      await wire.setGrants(id, grants)
      // The edit is committed; each watcher applies THESE grants to its
      // cache synchronously before its own (fallible) full refresh, so a
      // listing that fails cannot leave an open session judged by the wider
      // grants the store no longer holds.
      for (const watcher of [...grantWatchers]) await watcher(id, grants)
    },

    pairBegin: (name) => wire.pairBegin(name),
    pairCancel: () => wire.pairCancel(),
    pairConfirm: (accept, grants, attemptId) => wire.pairConfirm(accept, grants, attemptId),
    pairFromUri: (uri, name, grants) => wire.pairFromUri(uri, name, grants),

    onPairingPending: (fn) => wire.onPairingPending(fn),
    onPairingResult: (fn) => wire.onPairingResult(fn),
    onSessionOpen: (fn) => wire.onSessionOpen(fn),
    onTransfer: (fn) => wire.onTransfer(fn),

    async serve(services) {
      if (servingActive) throw new Error('peer port: serve() is already active — one server per port')
      servingActive = true
      let serving = true
      let peers = new Map<string, WirePeer>()
      /* Newest wins: refreshes overlap (a session opening while grants
       * change), and an OLDER listing landing last would resurrect grants a
       * newer one had just narrowed — re-authorising revoked requests. */
      let peersGeneration = 0
      const refresh = async () => {
        const mine = ++peersGeneration
        const listed = new Map((await wire.listPeers()).map((peer) => [peer.id, peer] as const))
        if (mine !== peersGeneration) return
        peers = listed
        /* Every PUBLISHED listing rechecks the live connections: a caller
         * whose own refresh was superseded (a newer one is in flight) must
         * not judge grants against the cache its discarded listing left
         * behind — the recheck rides the listing that actually lands, so a
         * revocation bites as soon as the newest state does. */
        for (const conn of connections.values()) conn.recheckGrants()
      }
      const router = createRouter({
        services,
        hasGrant: (peer, grant) => {
          const held = peers.get(peer)
          return held ? grantCovers(held.grants, grant) : false
        },
      })
      const connections = new Map<number, RouterConnection>()

      /* Tear one session's connection down once: stop its drain, drop it from
       * the map, and disconnect the router side. `closeNative` also closes the
       * transport session — for a send failure, where the router should stop
       * writing to a peer it can no longer reach; not for a close event, where
       * the session is already gone. Idempotent. */
      const dropConnection = (sessionId: number, closeNative: boolean): void => {
        abortDrain(sessionId)
        const conn = connections.get(sessionId)
        if (conn) {
          connections.delete(sessionId)
          conn.disconnect()
        }
        if (closeNative) void wire.close(sessionId).catch(() => {})
      }

      const onGrantsChanged = async (peerId: string, grants?: readonly string[]): Promise<void> => {
        /* The COMMITTED grants land first, synchronously — the refresh that
         * follows can fail, and failing WIDE would keep an open session
         * authorized by grants the store no longer holds. The recheck for
         * everything else happens inside whichever refresh publishes. */
        if (grants !== undefined) {
          const held = peers.get(peerId)
          if (held) {
            peers.set(peerId, { ...held, grants: [...grants] })
            for (const conn of connections.values()) if (conn.peer === peerId) conn.recheckGrants()
          }
        }
        await refresh()
      }
      grantWatchers.add(onGrantsChanged)

      /* FROM HERE, EVERYTHING ROLLS BACK. The watcher above and every
         subscription below are registered before the `try` that used to
         start at `refresh()` — so a subscription that threw synchronously
         left the earlier ones and the watcher installed, with `servingActive`
         stuck true and nothing serving. The registrations are now inside the
         same rollback the refresh and readiness have.

         ONE PUSH PER SUBSCRIPTION, and that is the load-bearing part: the
         three used to be ARGUMENTS to a single `offs.push(...)`, and
         arguments evaluate before the call. A throw from the second left the
         first's unsubscribe in an argument list that was never delivered, so
         the catch below rolled back an EMPTY array — the leak survived
         inside its own fix. Each handle is registered for rollback the
         moment it exists. */
      const offs: Unsubscribe[] = []
      try {
        offs.push(
          wire.onSessionOpen((event) => {
            if (event.initiator) return
            void (async () => {
              try {
                await refresh()
                /* Torn down while the refresh was in flight: registering now
                 * would hand a connection to a server that no longer exists,
                 * and it would serve forever. */
                if (!serving) return
                const conn = router.connect(event.peerId, (bytes) =>
                  /* Return the send promise so the envelope serialises and
                   * awaits it; a failure tears the connection AND the session
                   * down rather than being swallowed, then re-throws so the
                   * envelope's own chain also disconnects. */
                  wire.send(event.sessionId, bytes).catch((thrown) => {
                    dropConnection(event.sessionId, true)
                    throw thrown
                  }),
                )
                connections.set(event.sessionId, conn)
                /* THE ROUTER HANGS UP ON ITS OWN, and nothing here could see
                 * it. A rejected write is handled above; the OUTBOUND BUDGET
                 * overflowing is not — a peer that stopped reading fills it,
                 * the router disconnects, and the native session stayed open
                 * with every later frame drained into a connection answered
                 * by nobody, so the peer's requests hung for ever and its
                 * inbox went on being served. The webhost pump was caught by
                 * the same defect in the 2026-08-28 audit (#61) and this is
                 * the same remedy: the session goes the way the drain path
                 * takes it. Identity-checked, so a session id the plugin has
                 * since reused is left alone; `dropConnection` deletes before
                 * it disconnects, so the teardown road does not re-enter. */
                conn.onDisconnect(() => {
                  if (connections.get(event.sessionId) === conn) dropConnection(event.sessionId, true)
                })
                /* Frames that landed before the connection existed are in the
                 * inbox and raised their one edge event already — drain now. */
                await drainInto(
                  event.sessionId,
                  (bytes) => conn.receive(bytes),
                  () => dropConnection(event.sessionId, false),
                )
              } catch {
                dropConnection(event.sessionId, true)
              }
            })()
          }),
        )
        offs.push(
          wire.onSessionFrames((event) => {
            const conn = connections.get(event.sessionId)
            if (conn) void drainInto(event.sessionId, (bytes) => conn.receive(bytes), () => dropConnection(event.sessionId, false))
          }),
        )
        offs.push(
          wire.onSessionClosed((event) => {
            dropConnection(event.sessionId, false)
          }),
        )
      } catch (thrown) {
        grantWatchers.delete(onGrantsChanged)
        for (const off of offs) off()
        servingActive = false
        throw thrown
      }
      const teardown = () => {
        /* Idempotent AND ownership-scoped: a stale second call must not
         * release the port-wide flag a NEWER server now holds. */
        if (!serving) return
        serving = false
        servingActive = false
        grantWatchers.delete(onGrantsChanged)
        for (const off of offs) off()
        for (const sessionId of [...connections.keys()]) dropConnection(sessionId, false)
      }
      try {
        await refresh()
        /* Every listener above must be ATTACHED before the plugin starts
           emitting — `listen` registers asynchronously, and a session that
           opened into an unattached listener was a peer that looked silent. */
        await wire.whenListening?.()
        await wire.ready()
      } catch (thrown) {
        /* A serve that fails must not leave its listeners and grant watcher
         * registered — `serve()` rejecting means NOTHING is serving. */
        teardown()
        throw thrown
      }
      return teardown
    },

    async connect(peerId) {
      const closedFns = new Set<(reason: string) => void>()
      /** Why this channel closed, once it has — replayed to a late `onClosed`. */
      let closedReason: string | null = null
      let sessionId: number | null = null
      let client: Client | null = null
      let torn = false
      /* A close that lands during the dial window (before we know our session
       * id) is buffered and replayed once the id is known — see below. */
      const buffered: SessionClosed[] = []

      const tearDown = (reason: string): void => {
        if (torn) return
        torn = true
        closedReason = reason
        if (sessionId !== null) abortDrain(sessionId)
        offFrames()
        offClosed()
        client?.disconnect()
        for (const fn of [...closedFns]) {
          /* Isolated: teardown often runs from a fire-and-forget drain, so a
           * throwing callback would both silence LATER callbacks and become
           * an unhandled rejection. */
          try {
            fn(reason)
          } catch {
            /* The subscriber's problem; the close is still delivered on. */
          }
        }
      }

      const deliver = (bytes: Uint8Array) => {
        try {
          client?.receive(bytes)
        } catch {
          /* Bytes that are not a frame mean the transport is broken under
           * us; every pending call rejects `disconnected` and the session
           * is closed rather than read further. */
          if (sessionId !== null) void wire.close(sessionId).catch(() => {})
          tearDown('lost')
        }
      }

      /* Subscribe to session-close BEFORE dialing, so a peer that closes right
       * after the handshake cannot slip its close in before the listener
       * exists (which would leave later sends failing silently and callers
       * waiting out their 30 s timeout). Until the id is known, a close is
       * buffered; matched or discarded once it is. */
      /* ONE ROAD OUT, for the transport breaking under us: close the native
         session (best-effort) and tear the channel down as `lost`. Three
         sites spelled this pair out and could drift apart. */
      const lose = (): void => {
        if (sessionId !== null) void wire.close(sessionId).catch(() => {})
        tearDown('lost')
      }
      let offClosed: Unsubscribe = () => {}
      let offFrames: Unsubscribe = () => {}
      try {
        offClosed = wire.onSessionClosed((event) => {
          if (sessionId === null) {
            buffered.push(event)
            return
          }
          if (event.sessionId !== sessionId) return
          tearDown(event.reason)
        })
        offFrames = wire.onSessionFrames((event) => {
          if (sessionId !== null && event.sessionId === sessionId) {
            void drainInto(sessionId, deliver, lose)
          }
        })
        /* Attached before the dial — see `serve`; the buffer above covers the
           id-unknown window, this covers the not-yet-attached one. */
        await wire.whenListening?.()
        sessionId = await wire.connect(peerId, null)
      } catch (thrown) {
        /* A registration or the dial threw: nothing registered survives. */
        offFrames()
        offClosed()
        throw thrown
      }
      client = createClient({
        send: (bytes) =>
          wire.send(sessionId as number, bytes).catch((thrown) => {
            lose()
            throw thrown
          }),
      })

      // Replay a close that raced the dial, then drain anything that raced the
      // subscription.
      for (const event of buffered) if (event.sessionId === sessionId) tearDown(event.reason)
      const id = sessionId
      void drainInto(id, deliver, lose)
      return {
        sessionId: id,
        peerId,
        call: (service, body, options) => (client as Client).call(service, body, options),
        stream: (service, body, options) => (client as Client).stream(service, body, options),
        close: () => wire.close(id),
        onClosed: (fn) => {
          /* A CLOSE THAT ALREADY HAPPENED IS REPLAYED. The peer can close
             during the dial — the buffer above tears this channel down before
             the caller has it — and a listener registered afterwards used to
             wait for a notification that had already gone by. */
          if (closedReason !== null) {
            fn(closedReason)
            return () => {}
          }
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
          try {
            onProgress?.(event)
          } catch {
            /* Progress is advisory; a throwing observer must not skip the
             * terminal handling below and leave this promise pending — and
             * its listener registered — forever. */
          }
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

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
   *  started. Rejects with a `BlobFetchError` carrying the plugin's own kind,
   *  which is what chooses the sentence the reader is shown. */
  fetchBlob(request: BlobRequest, onProgress?: (event: TransferProgress) => void): Promise<void>
  /** BLAKE3 + size of a blob in THIS device's data root. */
  hashFile(folder: string, name: string): Promise<HashResult>
}

/**
 * A blob fetch that failed, in the shape the reader's sentence is chosen by.
 *
 * ⚠️ **THE KIND WAS KNOWN AT THE REJECTION AND SPENT ON THE MESSAGE.**
 * `sync/lib/status.ts` classifies a thrown value by its `kind` FIELD —
 * `blobRefused` → `revoked`, `blobHashMismatch` → `content`, which is
 * *"“Title”’s file couldn’t be verified"* — and this rejected with a plain
 * `Error` carrying that kind as PROSE. So `refusalKind` found no field,
 * answered `unknown`, and every failed download reached the reader as "Sync
 * failed" while the sentences written for these failures could not be reached
 * from any device. An `Error` still, as `ServiceCallError` is, so a caller
 * reading only the message loses nothing. Found by audit, 2026-09-14.
 */
export class BlobFetchError extends Error {
  /** The plugin's own `Error::kind()`, as `sync` reads it. */
  readonly kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.name = 'BlobFetchError'
    this.kind = kind
  }
}

/**
 * The OTHER road out of `fetchBlob`, by the same rule: a fetch the plugin
 * refuses before it starts — `noSession`, `transferBusy` — rejects the
 * `blobFetch` call itself rather than reaching a terminal transfer event.
 * Tauri's `invoke` rejects with the SERIALISED Rust error, a plain
 * `{kind, message}` and never an `Error` instance, so that kind was dropped
 * in the conversion to one exactly as a failed transfer's was. An `Error`
 * is passed on whole, stack and all, because it has no kind to carry.
 */
function asRefusal(thrown: unknown): unknown {
  if (thrown instanceof Error) return thrown
  /* `Object` BOXES, so `null`, `undefined` and a bare string each answer the
     two reads below without a guard of their own — and a guard that reaches
     the same answer by another road is a branch no test can tell apart.
     `String(thrown)` is still the value itself, which is what a refusal
     carrying no message of its own has to say. */
  const named = Object(thrown) as { kind?: unknown; message?: unknown }
  const said = typeof named.message === 'string' ? named.message : String(thrown)
  return typeof named.kind === 'string' ? new BlobFetchError(named.kind, said) : new Error(said)
}

export function createPeerPort(wire: PeerWire): PeerPort {
  /* One drain per session at a time, with a rerun flag: two overlapping
   * drains would interleave their delivery order across awaits, and frame
   * order is the envelope's ground. Each drain is ABORTABLE (a session that
   * closes stops its loop at once) and reports a `sessionRecv` REJECTION to
   * `onError` instead of leaking an unhandled rejection; its state is deleted
   * when the session closes, so the map does not grow without bound.
   *
   * ⚠️ **`aborted` IS SET IN ONE PLACE AND READ IN ONE PLACE**, and until
   * 2026-09-16 it was set in two and read in three. A failed read set it
   * before calling `onError`, and a fresh drain refused to start on a state
   * carrying it — but every `onError` this port passes ends in `abortDrain`,
   * which DELETES the state, so no later `drains.get` could return one with
   * the flag set. Both halves stood as surviving mutants on 2026-09-15 and
   * neither could be killed, because neither could happen. `abortDrain` sets
   * it; the loop below reads it. */
  const drains = new Map<number, { running: boolean; again: boolean; aborted: boolean }>()
  const drainInto = async (
    sessionId: number,
    deliver: (bytes: Uint8Array) => void,
    onError: (thrown: unknown) => void,
  ): Promise<void> => {
    let state = drains.get(sessionId)
    if (!state) {
      // Stryker disable next-line ObjectLiteral: every field starts falsy and is assigned before anything reads it, so an empty object is this one.
      state = {
        running: false,
        // Stryker disable next-line BooleanLiteral: the do-loop's first statement assigns `again`, and nothing can interleave before it.
        again: false,
        aborted: false,
      }
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
          if (state.aborted) return
          let frames: readonly Uint8Array[]
          try {
            frames = await wire.sessionRecv(sessionId)
          } catch (thrown) {
            onError(thrown)
            return
          }
          if (frames.length === 0) break
          /* ⚠️ **NO ABORT CHECK BETWEEN THE FRAMES OF ONE BATCH**, though there
             was one until 2026-09-16. It could not be observed and could not be
             wrong: whatever aborts a drain has already hung up on the consumer
             this delivers to — `tearDown` disconnects the client,
             `dropConnection` the router connection — and both answer `receive`
             after that with an immediate return. The check that matters is the
             one above, which stops the port READING a session it has lost, and
             a test counts the reads. */
          for (const frame of frames) deliver(frame)
        }
      } while (state.again)
    } finally {
      state.running = false
    }
  }
  const abortDrain = (sessionId: number): void => {
    const state = drains.get(sessionId)
    if (state) state.aborted = true
    // Stryker disable next-line CallExpression: the entry's only reader is the live drain, which holds the state itself; dropping it keeps the map bounded and nothing can observe the difference.
    drains.delete(sessionId)
  }

  /* Callbacks a live `serve()` registers so a grant edit through this port can
   * refresh its cache and have its router re-check open sessions.
   *
   * ⚠️ **THE GRANTS ARE NOT OPTIONAL**, and this parameter was until
   * 2026-09-16. `setGrants` is the only thing that ever calls a watcher and it
   * always has them, so the `grants !== undefined` a watcher opened with was a
   * branch nothing could enter — and therefore a mutant nothing could kill. */
  const grantWatchers = new Set<(peerId: string, grants: readonly string[]) => Promise<void> | void>()
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
        // Stryker disable next-line UpdateOperator: the guard below asks only whether the counter MOVED since this refresh took its mark, which any strictly monotone step answers alike.
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

      const onGrantsChanged = async (peerId: string, grants: readonly string[]): Promise<void> => {
        /* The COMMITTED grants land first, synchronously — the refresh that
         * follows can fail, and failing WIDE would keep an open session
         * authorized by grants the store no longer holds. The recheck for
         * everything else happens inside whichever refresh publishes. */
        const held = peers.get(peerId)
        if (held) {
          peers.set(peerId, { ...held, grants: [...grants] })
          /* EVERY open connection, not this peer's alone. A recheck asks the
             live cache, so for a peer whose grants did not move it is a no-op
             — which is what made the `conn.peer === peerId` filter a branch
             whose two sides no test could tell apart. `refresh` below rechecks
             the same way, and always did. */
          for (const conn of connections.values()) conn.recheckGrants()
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
      // Stryker disable next-line ArrayDeclaration: the replay below matches each buffered event's session id, so anything this started with is dropped there rather than acted on.
      const buffered: SessionClosed[] = []

      const tearDown = (reason: string): void => {
        if (torn) return
        torn = true
        closedReason = reason
        /* `as number` for the reason `send` below gives, and it is the same
           reason: every road into this one runs after the dial has answered —
           the close listener checks the id, `lose` comes from a drain or a
           write, and the replay below is after the assignment. The
           `!== null` both this and `lose` carried until 2026-09-16 was a
           branch with one live side, so a mutant taking the guard away could
           not be told from the code it replaced. */
        abortDrain(sessionId as number)
        offFrames()
        offClosed()
        // Stryker disable next-line OptionalChaining: nothing can tear a channel down before the dial answers, and the client is created in the same synchronous step the id is — defence, not a branch.
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

      /* ONE ROAD OUT, for the transport breaking under us: close the native
         session (best-effort) and tear the channel down as `lost`. Three
         sites spelled this pair out and could drift apart.

         ⚠️ **AND ONE OF THE THREE STILL DID** until 2026-09-15: `deliver`'s
         catch carried its own copy of the pair, word for word, under a comment
         claiming they had been collapsed into this. Nothing had drifted yet —
         a mutation sweep is what found it, because the copy's `sessionId`
         guard is a second branch no test can tell from this one. */
      const lose = (): void => {
        void wire.close(sessionId as number).catch(() => {})
        tearDown('lost')
      }

      const deliver = (bytes: Uint8Array) => {
        try {
          // Stryker disable next-line OptionalChaining: a drain only ever starts once the id is known, and the client is created in the same synchronous step — see `tearDown`.
          client?.receive(bytes)
        } catch {
          /* Bytes that are not a frame mean the transport is broken under
           * us; every pending call rejects `disconnected` and the session
           * is closed rather than read further. */
          lose()
        }
      }

      /* Subscribe to session-close BEFORE dialing, so a peer that closes right
       * after the handshake cannot slip its close in before the listener
       * exists (which would leave later sends failing silently and callers
       * waiting out their 30 s timeout). Until the id is known, a close is
       * buffered; matched or discarded once it is. */
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
          /* The id match is the whole guard. `SessionFrames.session_id` is a
             `u64` in the plugin's own event struct — not an `Option`, unlike
             the `attempt_id` and `error` declared beside it — so an event's id
             is never null, and during the dial window this local is, which no
             number equals. The `sessionId !== null &&` that stood here until
             2026-09-16 was a conjunct the other operand had already decided,
             so a mutant taking it away could not be told from the code it
             replaced. */
          if (event.sessionId === sessionId) {
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
        // Stryker disable next-line ArrayDeclaration: `judge` matches each buffered event's transfer id, so anything this started with is dropped there rather than acted on.
        const early: TransferProgress[] = []
        let off: Unsubscribe = () => {}
        const judge = (event: TransferProgress) => {
          /* The id match alone, for the reason the frame listener above gives:
             `TransferProgress.transfer_id` is a `u64` and never null, so while
             this one is — before `blobFetch` has answered — no event's id can
             equal it, and the comparison declines every event on its own. The
             `transferId === null ||` that stood here until 2026-09-16 decided
             nothing the second operand had not. */
          if (event.transferId !== transferId) return
          try {
            // Stryker disable next-line OptionalChaining: with no observer the call below throws into the catch that is already here for one that throws, and the terminal handling runs either way — measured.
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
            /* THE KIND RIDES THE REJECTION — see `BlobFetchError`. `event.error`
             * is the plugin's own `Error::kind()`, and the sentence below is
             * the diagnostic's, never the reader's. */
            const kind = event.error ?? 'unknown'
            reject(new BlobFetchError(kind, `blob fetch failed: ${kind}`))
          }
        }
        off = wire.onTransfer((event) => {
          if (transferId === null) early.push(event)
          else judge(event)
        })
        /* ⚠️ **THE LISTENER IS SUBSCRIBED SYNCHRONOUSLY AND ATTACHED LATER.**
           `subscription` returns at once and Tauri's `listen` resolves its
           registration in a later turn, so starting the transfer immediately
           opened a window in which the plugin could finish — or fail — before
           anything was attached to hear it. A missed terminal event leaves
           this promise pending for ever, which reaches the reader as a
           download that never finishes and never errors. `whenListening` is
           the wire's own answer to that and two other callers already await
           it; this one did not. Found by audit.

           Optional, because the fake wire has no registration to wait for. */
        void Promise.resolve(wire.whenListening?.())
          .then(() => wire.blobFetch(request))
          .then(
          (id) => {
            transferId = id
            for (const event of early.splice(0)) judge(event)
          },
          (thrown) => {
            off()
            reject(asRefusal(thrown))
          },
        )
      })
    },

    hashFile: (folder, name) => wire.hashFile(folder, name),
  }
}

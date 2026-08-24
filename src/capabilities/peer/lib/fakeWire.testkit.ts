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
  SessionFrames,
  SessionOpen,
  TransferProgress,
  Unsubscribe,
  WirePeer,
} from './wire'

/**
 * The in-memory `PeerWire` pair — two fake wires linked as shelf and
 * satchel, delivering frames both ways, with the grants and roles a test
 * sets. What the plugin does over QUIC this does over two Maps: sessions
 * with per-side ids and edge-triggered `session-frames`, blob fetches served
 * from the other side's blob store (or a hook into the test's fake
 * filesystem), a pairing handshake just real enough for the Devices model.
 *
 * A testkit, not a simulation: it reproduces the CONTRACT (delivery order,
 * edge-triggered events, grant refusal before a byte, hash verification),
 * not the transport. The hash is SHA-256 where the plugin's is BLAKE3 —
 * both 64 hex, computed by `fakeBlobHash` on BOTH ends, so a mismatch test
 * means what it means and nothing depends on which algorithm it was.
 */

interface Session {
  readonly id: number
  readonly peerId: string
  readonly inbox: Uint8Array[]
  open: boolean
  /** The same session as the other side numbers it. */
  twin: { wire: FakeWireImpl; id: number } | null
}

type Listeners = {
  'pairing-pending': Set<(e: PairingPending) => void>
  'pairing-result': Set<(e: PairingResult) => void>
  'session-open': Set<(e: SessionOpen) => void>
  'session-closed': Set<(e: SessionClosed) => void>
  'session-frames': Set<(e: SessionFrames) => void>
  transfer: Set<(e: TransferProgress) => void>
}

export interface FakeWireOptions {
  readonly role: PeerRole
  readonly endpointId: string
  readonly name?: string
}

export interface FakeWire extends PeerWire {
  readonly id: string
  /** The role the node is RUNNING as. */
  readonly roleOf: PeerRole
  /** What `setLocalRole` stored, in force only after `restart()`. */
  readonly pendingRole: PeerRole | null
  /** The next launch: the stored role becomes the running one. */
  restart(): void
  /** This device's served blobs: `<folder>/<name>` → bytes. */
  readonly blobs: Map<string, Uint8Array>
  /** Where a fetched blob ALSO lands — wire it to the test's fake fs so
   *  `refreshContent` sees the file the transfer produced. */
  landBlob: ((folder: string, name: string, bytes: Uint8Array) => Promise<void>) | null
  /** What this device serves, when not the blob map. Return null for absent. */
  serveBlob: ((folder: string, name: string) => Uint8Array | null) | null
  /** Pair by fiat: a peer record, defaults filled in. */
  addPeer(peer: Partial<WirePeer> & { id: string; role: PeerRole }): void
  /** Sever or restore the link. Severing closes every session with `lost`. */
  setOnline(online: boolean): void
}

const peerError = (kind: string, message: string) => ({ kind, message })

/** SHA-256 hex — the testkit's stand-in for the plugin's BLAKE3. 64 hex,
 *  computed identically on both ends of a fake transfer. */
export async function fakeBlobHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

class FakeWireImpl implements FakeWire {
  readonly id: string
  /* Mutable on the fake alone, so `setLocalRole` can be observed in a test
     without modelling a relaunch. The wire's own interface keeps it readonly. */
  roleOf: PeerRole
  /** Set by `setLocalRole`, in force only after `restart()`. */
  pendingRole: PeerRole | null = null
  readonly blobs = new Map<string, Uint8Array>()
  landBlob: FakeWire['landBlob'] = null
  serveBlob: FakeWire['serveBlob'] = null

  private readonly name: string
  /** Every wire this one can reach, by endpoint id — a star has one shelf
   *  linked to many satchels. */
  private readonly links = new Map<string, FakeWireImpl>()
  private online = true
  private isReady = false
  private readonly peers = new Map<string, WirePeer>()
  private readonly sessions = new Map<number, Session>()
  private nextSession = 1
  private nextTransfer = 1
  private offer: { secret: string; offer: PairOffer } | null = null
  private pending: { satchel: FakeWireImpl; name: string; grants: readonly string[]; attemptId: string } | null = null
  private readonly listeners: Listeners = {
    'pairing-pending': new Set(),
    'pairing-result': new Set(),
    'session-open': new Set(),
    'session-closed': new Set(),
    'session-frames': new Set(),
    transfer: new Set(),
  }

  constructor({ role, endpointId, name }: FakeWireOptions) {
    this.roleOf = role
    this.id = endpointId
    this.name = name ?? `Fake ${role}`
  }

  /* ------------------------------------------------------------- plumbing */

  link(other: FakeWireImpl): void {
    this.links.set(other.id, other)
  }

  private emit<K extends keyof Listeners>(event: K, payload: Parameters<Parameters<Listeners[K]['add']>[0]>[0]): void {
    queueMicrotask(() => {
      for (const fn of [...this.listeners[event]]) (fn as (p: unknown) => void)(payload)
    })
  }

  private on<K extends keyof Listeners>(event: K, fn: Parameters<Listeners[K]['add']>[0]): Unsubscribe {
    this.listeners[event].add(fn as never)
    return () => void this.listeners[event].delete(fn as never)
  }

  addPeer(peer: Partial<WirePeer> & { id: string; role: PeerRole }): void {
    this.peers.set(peer.id, {
      name: 'Fake peer',
      platform: 'test',
      grants: [],
      pairedAt: 0,
      lastSeenAt: 0,
      lastAddrs: [],
      ...peer,
    })
  }

  setOnline(online: boolean): void {
    this.online = online
    if (online) return
    for (const session of this.sessions.values()) {
      if (session.open) this.closeSession(session, 'lost')
    }
  }

  private closeSession(session: Session, reason: string): void {
    if (!session.open) return
    session.open = false
    this.emit('session-closed', { sessionId: session.id, reason })
    const twin = session.twin
    if (twin) {
      const theirs = twin.wire.sessions.get(twin.id)
      if (theirs) twin.wire.closeSession(theirs, reason)
    }
  }

  /* ------------------------------------------------------------- commands */

  async status(): Promise<PeerStatus> {
    return { pluginVersion: 'fake', endpointId: this.id, role: this.roleOf, ready: this.isReady }
  }

  async localRole(): Promise<PeerRole> {
    return this.roleOf
  }

  /**
   * STORED FOR THE NEXT LAUNCH, exactly as the plugin does — `status()` keeps
   * reporting the RUNNING role until `restart()`.
   *
   * The fake used to apply it at once, with a comment calling the difference
   * deliberate. It is not survivable: `refresh()` publishes `status().role`,
   * so a test could set a role, refresh, watch `snapshot.role` flip, and pass
   * — proving a live switch the real plugin does not perform, which is the
   * one thing a fake must never be able to do. `restart()` is the seam a test
   * uses when it genuinely wants the next launch.
   */
  async setLocalRole(role: PeerRole): Promise<void> {
    this.pendingRole = role
  }

  /** The next launch: what `setLocalRole` stored becomes what runs. */
  restart(): void {
    if (this.pendingRole !== null) {
      this.roleOf = this.pendingRole
      this.pendingRole = null
    }
  }

  async dataRoot(): Promise<string> {
    return `/fake/${this.id}`
  }

  async fsync(): Promise<void> {}

  async listPeers(): Promise<readonly WirePeer[]> {
    return [...this.peers.values()]
  }

  async forgetPeer(id: string): Promise<void> {
    this.peers.delete(id)
    for (const session of this.sessions.values()) {
      if (session.peerId === id) this.closeSession(session, 'revoked')
    }
  }

  async setGrants(id: string, grants: readonly string[]): Promise<void> {
    const held = this.peers.get(id)
    if (!held) throw peerError('peerUnknown', `no peer ${id}`)
    this.peers.set(id, { ...held, grants: [...grants] })
  }

  async hasGrant(id: string, grant: string): Promise<boolean> {
    const held = this.peers.get(id)
    return held ? grantCovers(held.grants, grant) : false
  }

  async pairBegin(name?: string): Promise<PairOffer> {
    const secret = `s${Math.random().toString(36).slice(2)}`
    const offer: PairOffer = {
      url: `paper://pair?v=1&id=${this.id}&s=${secret}`,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      expiresAt: Date.now() + 5 * 60_000,
    }
    this.offer = { secret, offer }
    void name
    return offer
  }

  async pairCancel(): Promise<void> {
    this.offer = null
    this.pending = null
  }

  async pairConfirm(accept: boolean, grants: readonly string[] | undefined, attemptId: string): Promise<WirePeer | null> {
    const pending = this.pending
    if (!pending) throw peerError('noPendingPairing', 'nothing to confirm')
    /* Mirror the Rust: the attempt id must match the pending one, so a
     * confirmation bound to a different (pre-played) attempt is refused
     * without consuming this one. The id is REQUIRED — an earlier version
     * allowed it to be absent and this comment still described that path
     * after the parameter became mandatory. */
    if (attemptId !== pending.attemptId) {
      throw peerError('noPendingPairing', 'confirmation does not match the pending pairing attempt')
    }
    this.pending = null
    this.offer = null
    const satchel = pending.satchel
    if (!accept) {
      const refusal: PairingResult = { ok: false, id: this.id, reason: 'refused' }
      satchel.emit('pairing-result', refusal)
      this.emit('pairing-result', { ok: false, id: satchel.id, reason: 'refused' })
      return null
    }
    const record: WirePeer = {
      id: satchel.id,
      name: pending.name,
      platform: 'test',
      role: 'satchel',
      grants: [...(grants ?? [])],
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastAddrs: [],
    }
    this.peers.set(satchel.id, record)
    satchel.peers.set(this.id, {
      id: this.id,
      name: this.name,
      platform: 'test',
      role: 'shelf',
      grants: [...pending.grants],
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastAddrs: [],
    })
    satchel.emit('pairing-result', { ok: true, id: this.id, name: this.name, platform: 'test', role: 'shelf' })
    this.emit('pairing-result', { ok: true, id: satchel.id, name: pending.name, platform: 'test', role: 'satchel' })
    return record
  }

  async pairFromUri(uri: string, name?: string, grants?: readonly string[]): Promise<PairStart> {
    const parsed = /^paper:\/\/pair\?v=1&id=([^&]+)&s=([^&]+)$/.exec(uri)
    if (!parsed) throw peerError('pairUriInvalid', `not a pairing URI: ${uri}`)
    const shelf = this.links.get(parsed[1] as string)
    if (!shelf || !this.online) throw peerError('iroh', 'shelf unreachable')
    if (!shelf.offer || shelf.offer.secret !== parsed[2]) throw peerError('noPendingPairing', 'no such offer')
    const sas = '000000'
    const attemptId = `att-${this.id}`
    shelf.pending = { satchel: this, name: name ?? this.name, grants: grants ?? [], attemptId }
    shelf.emit('pairing-pending', { id: this.id, name: name ?? this.name, platform: 'test', sas, attemptId })
    return { sas }
  }

  async ready(): Promise<void> {
    this.isReady = true
  }

  async connect(peerId: string, hello?: unknown): Promise<number> {
    const remote = this.links.get(peerId)
    if (!this.peers.has(peerId)) throw peerError('peerUnknown', `no peer ${peerId}`)
    if (!remote || !this.online || !remote.online) throw peerError('iroh', 'peer unreachable')
    if (!remote.peers.has(this.id)) throw peerError('sessionRefused', 'unknown-peer')
    if (!remote.isReady) throw peerError('sessionRefused', 'not-ready')
    const mine: Session = { id: this.nextSession++, peerId, inbox: [], open: true, twin: null }
    const theirs: Session = { id: remote.nextSession++, peerId: this.id, inbox: [], open: true, twin: null }
    mine.twin = { wire: remote, id: theirs.id }
    theirs.twin = { wire: this, id: mine.id }
    this.sessions.set(mine.id, mine)
    remote.sessions.set(theirs.id, theirs)
    this.emit('session-open', { sessionId: mine.id, peerId, role: remote.roleOf, initiator: true, hello: hello ?? null })
    remote.emit('session-open', { sessionId: theirs.id, peerId: this.id, role: this.roleOf, initiator: false, hello: hello ?? null })
    return mine.id
  }

  async send(sessionId: number, bytes: Uint8Array): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.open) throw peerError('sessionUnknown', `no session ${sessionId}`)
    const twin = session.twin
    if (!twin || !this.online) throw peerError('iroh', 'link down')
    const theirs = twin.wire.sessions.get(twin.id)
    if (!theirs || !theirs.open) throw peerError('sessionUnknown', 'closed on the other end')
    const wasEmpty = theirs.inbox.length === 0
    theirs.inbox.push(bytes.slice())
    // EDGE-TRIGGERED, like the plugin: one event per empty→non-empty.
    if (wasEmpty) twin.wire.emit('session-frames', { sessionId: theirs.id, count: theirs.inbox.length })
  }

  async sessionRecv(sessionId: number, max = 64): Promise<readonly Uint8Array[]> {
    const session = this.sessions.get(sessionId)
    if (!session) throw peerError('sessionUnknown', `no session ${sessionId}`)
    return session.inbox.splice(0, max)
  }

  async close(sessionId: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.closeSession(session, 'closed')
  }

  async blobFetch(request: BlobRequest): Promise<number> {
    const transferId = this.nextTransfer++
    const progress = (state: TransferProgress['state'], received: number, total: number, error?: string) =>
      this.emit('transfer', {
        transferId,
        folder: request.folder,
        received,
        total,
        state,
        ...(error === undefined ? {} : { error }),
      })
    const remote = this.links.get(request.peerId)
    const task = async (): Promise<void> => {
      const hasSession = [...this.sessions.values()].some((s) => s.open && s.peerId === request.peerId)
      if (!remote || !hasSession) throw peerError('noSession', 'no open session with that peer')
      if (!(await remote.hasGrant(this.id, 'blob:read'))) throw peerError('blobRefused', 'ungranted')
      const key = `${request.folder}/${request.name}`
      const bytes = remote.serveBlob ? remote.serveBlob(request.folder, request.name) : (remote.blobs.get(key) ?? null)
      if (bytes === null) throw peerError('blobRefused', 'not-found')
      progress('running', 0, bytes.length)
      /* SIZE AND DIGEST, exactly as `blobs.rs` does — its check is
         `size != expected_size || hash != expected`, one refusal for both.
         The fake verified only the digest, so a caller that passed a size the
         bytes do not have was accepted here and refused by the real plugin:
         the TypeScript suites could not catch stale or dishonest size
         metadata, which is precisely the class the check exists for. */
      if (bytes.length !== request.expectedSize) {
        throw peerError('blobHashMismatch', `expected ${request.expectedSize} bytes, got ${bytes.length}`)
      }
      if ((await fakeBlobHash(bytes)) !== request.expectedHash) throw peerError('blobHashMismatch', 'digest differs')
      this.blobs.set(key, bytes)
      if (this.landBlob) await this.landBlob(request.folder, request.name, bytes)
      progress('done', bytes.length, bytes.length)
    }
    void task().catch((thrown: { kind?: string; message?: string }) => {
      progress('failed', 0, request.expectedSize, thrown?.kind ?? 'iroh')
    })
    return transferId
  }

  async hashFile(folder: string, name: string): Promise<HashResult> {
    const key = `${folder}/${name}`
    const bytes = this.serveBlob ? this.serveBlob(folder, name) : (this.blobs.get(key) ?? null)
    if (bytes === null) throw peerError('folderGone', `no ${key}`)
    return { blake3: await fakeBlobHash(bytes), size: bytes.length }
  }

  /* ------------------------------------------------------------ listeners */

  onPairingPending(fn: (e: PairingPending) => void): Unsubscribe {
    return this.on('pairing-pending', fn)
  }
  onPairingResult(fn: (e: PairingResult) => void): Unsubscribe {
    return this.on('pairing-result', fn)
  }
  onSessionOpen(fn: (e: SessionOpen) => void): Unsubscribe {
    return this.on('session-open', fn)
  }
  onSessionClosed(fn: (e: SessionClosed) => void): Unsubscribe {
    return this.on('session-closed', fn)
  }
  onSessionFrames(fn: (e: SessionFrames) => void): Unsubscribe {
    return this.on('session-frames', fn)
  }
  onTransfer(fn: (e: TransferProgress) => void): Unsubscribe {
    return this.on('transfer', fn)
  }
}

export function fakeWire(options: FakeWireOptions): FakeWire {
  return new FakeWireImpl(options)
}

/** Two fakes joined as one link. Pair them yourself, or use `linkedWires`. */
export function linkWires(a: FakeWire, b: FakeWire): void {
  ;(a as FakeWireImpl).link(b as FakeWireImpl)
  ;(b as FakeWireImpl).link(a as FakeWireImpl)
}

/**
 * The common fixture: a shelf and a satchel, linked and already paired both
 * ways with `sync:*` and `blob:*` — the grants pairing one's own device
 * writes (§2.2). Tests that want narrower grants call `setGrants`.
 */
export function linkedWires(): { shelf: FakeWire; satchel: FakeWire } {
  const shelf = fakeWire({ role: 'shelf', endpointId: 'shelf-endpoint-0000000000000000' })
  const satchel = fakeWire({ role: 'satchel', endpointId: 'satchel-endpoint-00000000000000' })
  linkWires(shelf, satchel)
  shelf.addPeer({ id: satchel.id, role: 'satchel', grants: ['sync:*', 'blob:*'], name: 'Fake satchel' })
  satchel.addPeer({ id: shelf.id, role: 'shelf', grants: ['sync:*', 'blob:*'], name: 'Fake shelf' })
  return { shelf, satchel }
}

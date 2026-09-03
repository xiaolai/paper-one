import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * The wire — the peer capability's ONE window onto the Tauri plugin.
 *
 * `PeerWire` is a typed face over every command `tauri-plugin-peer` exposes
 * and every event it emits (`dev-docs/plans/phase-07-peer-plugin.md`, "Contract
 * with the webview"). `tauriWire()` is the real one; `fakeWire.testkit.ts`
 * is the in-memory pair the protocol tests run on. Everything above this
 * file — the port, the ledger, the panes — speaks `PeerWire` and cannot
 * tell the two apart, which is what makes the sync protocol testable with
 * no plugin and no network.
 *
 * THIS FILE IS THE ONLY CAPABILITY MODULE ALLOWED TO IMPORT @tauri-apps/api
 * (`.dependency-cruiser.cjs`, `no-tauri-api-outside-peer-wire`; the selftest
 * pins both directions). Everything the plugin cannot answer — books,
 * journals, merges — is somebody else's, reached through the kernel.
 */

/* ------------------------------------------------------------- the shapes */

export type PeerRole = 'shelf' | 'satchel'

/** What `peer_status` returns. */
export interface PeerStatus {
  readonly pluginVersion: string
  readonly endpointId: string
  readonly role: PeerRole
  readonly ready: boolean
}

/** One paired device, as `peer/peers.json` holds it. */
export interface WirePeer {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly role: PeerRole
  readonly grants: readonly string[]
  readonly pairedAt: number
  readonly lastSeenAt: number
  readonly lastAddrs: readonly string[]
}

/**
 * What a pairing is FOR — mirrors Rust's `PairKind`.
 *
 * `device` is a reader's own two machines. `circle` is two PEOPLE, where the
 * six digits stop being a formality: between your laptop and your phone a
 * mismatch means a typo, and between two people it means an interceptor.
 */
export type PairKind = 'device' | 'circle'

export interface PairOffer {
  /** CARRIES THE SECRET (it is what the other device scans) — sensitive,
   *  never logged; diagnostics' redaction covers `url` keys. */
  readonly url: string
  /** The QR, as SVG markup — rendered in Rust rather than by a JS QR
   *  library, but it ENCODES the same secret the url carries: treat both
   *  as sensitive. */
  readonly svg: string
  readonly expiresAt: number
}

export interface PairStart {
  /** The 6-digit SAS to show while the other side's human decides. */
  readonly sas: string
}

export interface PairingPending {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly sas: string
  /** The unguessable id of THIS pairing attempt. Echoed back to
   *  `pairConfirm` so a confirmation is bound to the attempt the human saw,
   *  not to whatever a pre-played QR has since started (Rust M9). */
  readonly attemptId: string
  /** What this attempt is for — see `PairingResult.kind`. */
  readonly kind: PairKind
}

export interface PairingResult {
  readonly ok: boolean
  /**
   * What the attempt was for.
   *
   * ⚠️ **TWO SURFACES SUBSCRIBE TO ONE STREAM AND CONFIRM WITH DIFFERENT
   * GRANTS.** Devices answers with a reader's own-device grants; the circle
   * panel answers with `circle:read`. Unlabelled, Devices could answer a
   * CIRCLE request — handing another person the permissions meant for the
   * reader's own phone — and the circle panel could answer a device request,
   * filing the reader's own phone with circle access only. Each consumer now
   * ignores the other's events.
   */
  readonly kind: PairKind
  /** Which attempt this is the result of; absent on the joining side. */
  readonly attemptId?: string
  readonly id: string
  readonly name?: string
  readonly platform?: string
  readonly role?: PeerRole
  readonly reason?: string
}

export interface SessionOpen {
  readonly sessionId: number
  readonly peerId: string
  readonly role: PeerRole
  readonly initiator: boolean
  readonly hello: unknown
}

export interface SessionClosed {
  readonly sessionId: number
  readonly reason: string
}

export interface SessionFrames {
  readonly sessionId: number
  readonly count: number
}

export type TransferState = 'running' | 'done' | 'failed'

export interface TransferProgress {
  readonly transferId: number
  /**
   * The blob folder — which book's bytes these are.
   *
   * `blobFolderOf(bookId)` derives the same string, so the caller that asked
   * for a download matches its own request FORWARD, by computing the folder it
   * expects rather than trying to invert `safeId`. The event carried a bare
   * counter before this, which is why the only surface that ever read it could
   * say "Transfer 1, done" and nothing a reader could act on.
   */
  readonly folder: string
  readonly received: number
  readonly total: number
  readonly state: TransferState
  readonly error?: string
}

/** What `peer_blob_fetch` takes: a blob by folder and closed name, verified. */
export interface BlobRequest {
  readonly peerId: string
  readonly folder: string
  readonly name: string
  readonly expectedSize: number
  /** BLAKE3, hex. */
  readonly expectedHash: string
}

export interface HashResult {
  readonly blake3: string
  readonly size: number
}

export type Unsubscribe = () => void

/* ---------------------------------------------------------------- the wire */

/** One method per plugin command, one listener per plugin event. */
export interface PeerWire {
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
  hasGrant(id: string, grant: string): Promise<boolean>

  /**
   * Offer a pairing.
   *
   * ⚠️ **`kind` DECIDES WHO MAY JOIN, and it was never sent.** The Rust
   * `peer_pair_begin` has taken a `PairKind` since circle pairing landed;
   * omitting it here meant every offer was a DEVICE offer, so a circle
   * pairing could not be started from the app at all — the door was built and
   * had no handle. `'device'` stays the default, which is what an offer with
   * no kind has always meant.
   */
  pairBegin(name?: string, kind?: PairKind): Promise<PairOffer>
  pairCancel(): Promise<void>
  /** `attemptId` is REQUIRED — the binding that stops a stale or pre-played
   *  confirmation approving whichever attempt happens to be pending. */
  pairConfirm(accept: boolean, grants: readonly string[] | undefined, attemptId: string): Promise<WirePeer | null>
  pairFromUri(uri: string, name?: string, grants?: readonly string[]): Promise<PairStart>

  ready(): Promise<void>
  connect(peerId: string, hello?: unknown): Promise<number>
  send(sessionId: number, bytes: Uint8Array): Promise<void>
  sessionRecv(sessionId: number, max?: number): Promise<readonly Uint8Array[]>
  close(sessionId: number): Promise<void>

  blobFetch(request: BlobRequest): Promise<number>
  hashFile(folder: string, name: string): Promise<HashResult>

  onPairingPending(fn: (event: PairingPending) => void): Unsubscribe
  onPairingResult(fn: (event: PairingResult) => void): Unsubscribe
  onSessionOpen(fn: (event: SessionOpen) => void): Unsubscribe
  onSessionClosed(fn: (event: SessionClosed) => void): Unsubscribe
  /**
   * Resolves once every subscription made so far has attached; rejects with
   * the first registration that failed. Optional: an in-memory wire attaches
   * synchronously and needs none. The port awaits it before `connect` and
   * `ready`, the two calls after which the plugin starts emitting.
   */
  whenListening?(): Promise<void>
  onSessionFrames(fn: (event: SessionFrames) => void): Unsubscribe
  onTransfer(fn: (event: TransferProgress) => void): Unsubscribe

  /* ── the person identity and the circle roster (WI-22.B1/B3) ──────────
   *
   * ⚠️ **HERE RATHER THAN IN A WIRE OF `circle`'S OWN, because these are the
   * PEER plugin's commands.** `no-tauri-api-outside-peer-wire` says why in as
   * many words — *"One file per plugin, so the set of command names is
   * auditable in one place"* — and a second file invoking `plugin:peer|…`
   * would make that sentence false while the rule still passed on a
   * technicality. `circle` reaches these through `personPort()`, the way
   * `companion` reaches `inferencePort()`. */

  /** Read-only. Minting from a status call would delete the laziness the
   *  whole custody design rests on. */
  personStatus(devices: number, circle: number): Promise<PersonStatus>
  personEnsure(): Promise<string>
  /** `null` when this device holds no root — a leaf, or no identity. */
  personPhrase(): Promise<string | null>
  personRestore(words: string): Promise<string>
  personForget(): Promise<void>
  circlePeople(): Promise<readonly KnownPerson[]>
  circleRemember(person: string, displayName: string): Promise<void>
  circleForget(person: string): Promise<void>
  /**
   * Introduce this device over the circle door, and report the verdict.
   *
   * ⚠️ **`false` IS AN ANSWER, NOT A FAILURE.** That person does not know this
   * reader yet. It resolves rather than rejecting so a surface cannot show it
   * as "something went wrong" — and WHICH check refused is deliberately not
   * available, because telling a caller that would let them probe a stranger's
   * circle one dial at a time.
   */
  circleIntroduce(device: string, addrs?: readonly string[]): Promise<boolean>
  /**
   * Revoke one of THIS person's own devices — a laptop lost, a phone sold.
   *
   * ⚠️ **NOT `circleForget`, WHICH DROPS SOMEBODY ELSE.** This says a device of
   * the reader's own is finished: the roster stops vouching for it, the
   * revocation is stated so peers holding an older roster stop too, and it
   * loses its trust on this machine. Friends are told on the next round.
   *
   * A device cannot revoke itself — giving up the device you are holding is
   * `personForget`.
   */
  circleRevoke(device: string): Promise<void>
  /**
   * Sign a page with THIS DEVICE's endpoint key.
   *
   * ⚠️ **PAGES AND NOTHING ELSE, AND THE CONFINEMENT IS IN RUST.** The same key
   * authenticates every QUIC connection this device makes, so a binding that
   * signed arbitrary bytes would let a caller mint something a peer reads as a
   * different protocol. `identity::sign_page` refuses anything whose bytes are
   * not `paper.circle.<version>.page\n…` — the shape `signedBytes` produces.
   *
   * A delegation and a roster are signed by the PERSON root, which lives in the
   * OS keychain and has no binding here at all.
   */
  pageSign(message: string): Promise<string>
  /**
   * What this device puts on a page — its person, delegation and roster.
   *
   * `null` for a reader who has never shared, which is the ordinary state and
   * not a failure. Renews the delegation when it is due: a publisher whose
   * credentials expired is one whose pages every friend silently refuses.
   */
  circleMine(): Promise<PagePublisher | null>
}

/** The device's publishing identity, as `peer_circle_mine` reports it. */
export interface PagePublisher {
  readonly person: string
  readonly device: string
  /** As Rust serialised it; the page layer canonicalises before use. */
  readonly delegation: {
    readonly person: string
    readonly device: string
    readonly notBefore: number
    readonly notAfter: number
    readonly roster: number
    readonly sig: string
  }
  /** Device ids the roster vouches for — ids only, never address hints. */
  readonly roster: readonly string[]
  readonly revocations: number
}

/** What a device may do with the person identity. */
export type DeviceRole = 'home' | 'leaf'

/** A roster version — `(epoch, hlc)`, never a counter. */
export interface Version {
  readonly epoch: number
  readonly hlc: number
}

export interface KnownPerson {
  readonly person: string
  /** What the reader calls them. Display only; never matched on. */
  readonly displayName: string
  readonly roster: Version
  readonly revoked: readonly string[]
}

/**
 * The standing custody state — `identity.md` §"The window closes silently".
 *
 * ⚠️ **`atRisk` IS COMPUTED IN RUST, NOT HERE.** Every surface that shows the
 * marker would otherwise re-derive the condition, and three copies of "is this
 * reader at risk" is how one of them ends up saying no while the others say yes.
 */
export interface PersonStatus {
  /** `null` for a reader who has never shared. Not a warning. */
  readonly personId: string | null
  readonly hasIdentity: boolean
  /** Whether THIS device can still show the phrase. */
  readonly canShowPhrase: boolean
  readonly role: DeviceRole | null
  readonly devices: number
  readonly circle: number
  readonly atRisk: boolean
}

const command = (name: string) => `plugin:peer|${name}`

/**
 * Every subscription made so far has ATTACHED — or one of them failed, and
 * this rejects with that failure.
 *
 * `listen` registers asynchronously while the wire's subscriptions are
 * synchronous, so a caller could subscribe, then `connect`, and have the
 * plugin emit the session's first close or frames into a listener the
 * event system had not attached yet — lost, and every symptom looks like
 * the other device being silent. The port awaits this before the calls
 * that make events happen. A failed registration used to be a console line
 * and a caller that carried on without its events; it is the rejection
 * here, at the call that would have depended on them.
 */
async function whenListening(): Promise<void> {
  await Promise.allSettled([...attaching])
  if (firstRegistrationFailure !== null) throw firstRegistrationFailure
}

/**
 * `listen` resolves its unlisten asynchronously; the wire's subscriptions are
 * synchronous. This adapter subscribes now, drops events after unsubscribe
 * (the race where an event lands between the two), and detaches when the
 * plugin's unlisten arrives.
 */
/** Registrations still in flight, and the first that failed — what
 *  `whenListening` answers with. See `PeerWire.whenListening`. */
const attaching = new Set<Promise<unknown>>()
let firstRegistrationFailure: unknown = null

function subscription<T>(event: string, fn: (payload: T) => void): Unsubscribe {
  let live = true
  const pending = listen<T>(event, (received) => {
    if (live) fn(received.payload)
  })
  attaching.add(pending)
  void pending.then(
    () => attaching.delete(pending),
    (thrown: unknown) => {
      attaching.delete(pending)
      if (firstRegistrationFailure === null) firstRegistrationFailure = thrown
    },
  )
  /* A registration that FAILS must not sit as an unhandled rejection until
   * somebody unsubscribes — it is contained here, once, and unsubscribing
   * then finds nothing to detach.
   *
   * BUT IT IS SAID OUT LOUD. Containment used to be the whole of it, so a
   * `listen` that never attached left the caller believing it had
   * subscribed: pairing confirmations, session frames or transfer progress
   * simply never arrived, and every symptom of that looks like the other
   * device being silent. `console.error` rather than the diagnostics port
   * because this file is the raw Tauri seam and takes no injected
   * dependencies — one that reached for a port would have to be constructed,
   * and `tauriWire()` is a bare function by design. */
  void pending.catch((thrown: unknown) => {
    console.error(`peer: could not subscribe to "${event}"`, thrown)
  })
  return () => {
    if (!live) return
    live = false
    void pending.then((unlisten) => unlisten()).catch(() => {})
  }
}

/** The real wire: every method one `invoke`, every listener one `listen`. */
export function tauriWire(): PeerWire {
  return {
    status: () => invoke(command('peer_status')),
    localRole: () => invoke(command('peer_local_role')),
    setLocalRole: (role) => invoke(command('peer_set_local_role'), { role }),
    dataRoot: () => invoke(command('paper_data_root')),

    listPeers: () => invoke(command('peer_list_peers')),
    forgetPeer: (id) => invoke(command('peer_forget_peer'), { id }),
    setGrants: (id, grants) => invoke(command('peer_set_grants'), { id, grants }),
    hasGrant: (id, grant) => invoke(command('peer_has_grant'), { id, grant }),

    pairBegin: (name, kind) => invoke(command('peer_pair_begin'), { name: name ?? null, kind: kind ?? null }),
    pairCancel: () => invoke(command('peer_pair_cancel')),
    pairConfirm: (accept, grants, attemptId) => invoke(command('peer_pair_confirm'), { accept, grants: grants ?? null, attemptId }),
    pairFromUri: (uri, name, grants) => invoke(command('peer_pair_from_uri'), { uri, name: name ?? null, grants: grants ?? null }),

    ready: () => invoke(command('peer_ready')),
    connect: (peerId, hello) => invoke(command('peer_connect'), { peerId, hello: hello ?? null }),
    send: (sessionId, bytes) => invoke(command('peer_send'), { sessionId, bytes: Array.from(bytes) }),
    personStatus: (devices, circle) => invoke(command('peer_person_status'), { devices, circle }),
    personEnsure: () => invoke(command('peer_person_ensure')),
    personPhrase: () => invoke(command('peer_person_phrase')),
    personRestore: (words) => invoke(command('peer_person_restore'), { words }),
    personForget: () => invoke(command('peer_person_forget')),
    circlePeople: () => invoke(command('peer_circle_people')),
    circleRemember: (person, displayName) =>
      invoke(command('peer_circle_remember'), { person, displayName }),
    circleForget: (person) => invoke(command('peer_circle_forget'), { person }),
    circleIntroduce: (device, addrs) =>
      invoke(command('peer_circle_introduce'), { device, addrs: addrs === undefined ? null : [...addrs] }),
    circleRevoke: (device) => invoke(command('peer_circle_revoke'), { device }),
    pageSign: (message) => invoke(command('peer_page_sign'), { message }),
    circleMine: () => invoke(command('peer_circle_mine')),

    sessionRecv: async (sessionId, max) => {
      const frames = await invoke<number[][]>(command('peer_session_recv'), { sessionId, max: max ?? null })
      return frames.map((frame) => Uint8Array.from(frame))
    },
    close: (sessionId) => invoke(command('peer_close'), { sessionId }),

    blobFetch: (request) => invoke(command('peer_blob_fetch'), { request }),
    hashFile: (folder, name) => invoke(command('peer_hash_file'), { folder, name }),

    onPairingPending: (fn) => subscription('peer://pairing-pending', fn),
    onPairingResult: (fn) => subscription('peer://pairing-result', fn),
    onSessionOpen: (fn) => subscription('peer://session-open', fn),
    onSessionClosed: (fn) => subscription('peer://session-closed', fn),
    whenListening,
    onSessionFrames: (fn) => subscription('peer://session-frames', fn),
    onTransfer: (fn) => subscription('peer://transfer', fn),
  }
}

/** Whether this webview runs inside the Tauri app at all — outside it there
 *  is no plugin and the wire has nothing to speak to. */
export function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

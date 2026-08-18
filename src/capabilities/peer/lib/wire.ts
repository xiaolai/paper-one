import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * The wire — the peer capability's ONE window onto the Tauri plugin.
 *
 * `PeerWire` is a typed face over every command `tauri-plugin-peer` exposes
 * and every event it emits (`docs/plans/phase-07-peer-plugin.md`, "Contract
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

export interface PairOffer {
  readonly url: string
  /** The QR, as SVG markup — rendered in Rust so the secret never enters JS state. */
  readonly svg: string
  readonly expiresAt: number
}

export interface PairStart {
  /** The 4-digit SAS to show while the other side's human decides. */
  readonly sas: string
}

export interface PairingPending {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly sas: string
}

export interface PairingResult {
  readonly ok: boolean
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
  dataRoot(): Promise<string>
  fsync(path: string): Promise<void>

  listPeers(): Promise<readonly WirePeer[]>
  forgetPeer(id: string): Promise<void>
  setGrants(id: string, grants: readonly string[]): Promise<void>
  hasGrant(id: string, grant: string): Promise<boolean>

  pairBegin(name?: string): Promise<PairOffer>
  pairCancel(): Promise<void>
  pairConfirm(accept: boolean, grants?: readonly string[]): Promise<WirePeer | null>
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
  onSessionFrames(fn: (event: SessionFrames) => void): Unsubscribe
  onTransfer(fn: (event: TransferProgress) => void): Unsubscribe
}

const command = (name: string) => `plugin:peer|${name}`

/**
 * `listen` resolves its unlisten asynchronously; the wire's subscriptions are
 * synchronous. This adapter subscribes now, drops events after unsubscribe
 * (the race where an event lands between the two), and detaches when the
 * plugin's unlisten arrives.
 */
function subscription<T>(event: string, fn: (payload: T) => void): Unsubscribe {
  let live = true
  const pending = listen<T>(event, (received) => {
    if (live) fn(received.payload)
  })
  return () => {
    live = false
    void pending.then((unlisten) => unlisten()).catch(() => {})
  }
}

/** The real wire: every method one `invoke`, every listener one `listen`. */
export function tauriWire(): PeerWire {
  return {
    status: () => invoke(command('peer_status')),
    localRole: () => invoke(command('peer_local_role')),
    dataRoot: () => invoke(command('paper_data_root')),
    fsync: (path) => invoke(command('fs_fsync'), { path }),

    listPeers: () => invoke(command('peer_list_peers')),
    forgetPeer: (id) => invoke(command('peer_forget_peer'), { id }),
    setGrants: (id, grants) => invoke(command('peer_set_grants'), { id, grants }),
    hasGrant: (id, grant) => invoke(command('peer_has_grant'), { id, grant }),

    pairBegin: (name) => invoke(command('peer_pair_begin'), { name: name ?? null }),
    pairCancel: () => invoke(command('peer_pair_cancel')),
    pairConfirm: (accept, grants) => invoke(command('peer_pair_confirm'), { accept, grants: grants ?? null }),
    pairFromUri: (uri, name, grants) => invoke(command('peer_pair_from_uri'), { uri, name: name ?? null, grants: grants ?? null }),

    ready: () => invoke(command('peer_ready')),
    connect: (peerId, hello) => invoke(command('peer_connect'), { peerId, hello: hello ?? null }),
    send: (sessionId, bytes) => invoke(command('peer_send'), { sessionId, bytes: Array.from(bytes) }),
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
    onSessionFrames: (fn) => subscription('peer://session-frames', fn),
    onTransfer: (fn) => subscription('peer://transfer', fn),
  }
}

/** Whether this webview runs inside the Tauri app at all — outside it there
 *  is no plugin and the wire has nothing to speak to. */
export function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

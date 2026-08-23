import { defineSetting, type Setting, type SettingsStore } from '../../../kernel'
import type { PeerPort } from '../lib/port'
import type {
  PairOffer,
  PairingPending,
  PairingResult,
  PeerRole,
  TransferProgress,
  Unsubscribe,
  WirePeer,
} from '../lib/wire'

/**
 * The Devices section's MODEL — everything the pane decides, with no React
 * in it, so the logic is testable in the node project (the WI-C.5 rule:
 * component logic that matters lives in non-React helpers). The pane is an
 * adapter over `getSnapshot`/`subscribe`.
 */

/** "Local network only" — persisted NOW; plumbing it into the plugin's
 *  endpoint (RelayMode::Disabled, no DNS) is a later work item and is noted
 *  in `docs/sync.md`. Owned by peer because the endpoint it will configure
 *  is peer's. */
export const LOCAL_ONLY_SETTING: Setting<boolean> = defineSetting('peer.localOnly', false, (raw) =>
  typeof raw === 'boolean' ? raw : undefined,
)

/** The grants pairing one's own device writes (§2.2). */
export const OWN_DEVICE_GRANTS: readonly string[] = ['sync:*', 'blob:*']

/**
 * The same device, allowed to read but not to change anything.
 *
 * EVERY PAIRED DEVICE IS READ-WRITE TODAY, and not because the protocol says
 * so — `sync:pull` and `sync:push` are separate grants, `blobs.rs` enforces
 * `blob:read` on its own, and `peer_set_grants` has existed all along with
 * nothing calling it. The pairing simply wrote one wildcard pair and no
 * surface ever offered another.
 *
 * SPELLED OUT RATHER THAN NARROWED FROM THE WILDCARD. `grantCovers` reads
 * `<family>:*` as the whole family, so there is no "everything except push" to
 * express — the two sets are two lists, and this one names exactly the four
 * services a reader still gets: `sync.hello`, `sync.pull`, `sync.marks` and
 * `sync.content` all take `sync:pull` (`protocol.ts`), and the byte path takes
 * `blob:read` (`blobs.rs:244`). What it withholds is `sync:push`, which is the
 * one grant the shelf checks before merging anything a satchel sends.
 *
 * `sync:*` DOES NOT COVER `blob:read` — a wildcard names one family, and
 * `peers.rs` asserts that pairing explicitly. Both entries are load-bearing;
 * dropping the second is a device that syncs its marks and cannot open a book.
 */
export const READ_ONLY_GRANTS: readonly string[] = ['sync:pull', 'blob:read']

/**
 * Whether a peer may still change things here.
 *
 * Read off `sync:push`, which is the grant that decides it, rather than off
 * the shape of the list — so a peer granted something this app has not thought
 * of yet still answers correctly.
 */
export function peerCanWrite(grants: readonly string[]): boolean {
  return grants.some((held) => held === 'sync:push' || held === 'sync:*')
}

/**
 * PAIRING HAS A DIRECTION, AND THE PROTOCOL ENFORCES IT.
 *
 * The pane offered both halves to both roles, and each was dead on one of
 * them — not merely redundant. Rust refuses them by name:
 *
 *   `pairing.rs:426`  `begin()` returns `RoleMismatch` unless this node is a
 *                     shelf, so "Pair a new device" on a satchel could only
 *                     ever fail.
 *   `pairing.rs:545`  the far shelf refuses a hello whose role is not
 *                     satchel, so a shelf pasting another shelf's code could
 *                     only ever be turned away.
 *
 * It is directional because of what the invite IS. The URI carries the
 * OFFERER's endpoint id, its direct addresses and its relay — the joiner dials
 * it — and the handshake MAC is keyed over `shelfId ‖ satchelId`. The side
 * being dialled has to be the always-on one, and that is the shelf by
 * definition. So the library invites and the reader joins, in that direction
 * only.
 */
export function canOfferInvite(role: PeerRole | null): boolean {
  return role === 'shelf'
}

/** The other half of the same rule — see `canOfferInvite`. */
export function canJoinWithCode(role: PeerRole | null): boolean {
  return role === 'satchel'
}

/**
 * Does restricting THIS peer from THIS device actually do anything?
 *
 * Only on a shelf, and that is worth stating rather than discovering. Grants
 * are checked by the side being CALLED, and a shelf "answers satchels; it does
 * not dial them" — so the shelf's record of a satchel is the one that bites,
 * and a satchel's record of its shelf is never consulted, because the shelf
 * never calls in. Offering the switch there would be a control that does
 * nothing, which is the defect this whole pane is being dug out of.
 */
export function grantsAreEnforceable(mine: PeerRole | null): boolean {
  return mine === 'shelf'
}

/**
 * WHAT A ROLE IS, IN THE WORDS OF SOMEBODY WHO OWNS THE TWO MACHINES.
 *
 * `shelf` and `satchel` are the protocol's words and they were on screen as
 * themselves, next to a truncated endpoint id — which asks the reader to hold
 * a distributed-systems model in order to plug a laptop into a desktop. It is
 * also a word they could not act on when this was written: the role was fixed
 * at BUILD time, so the pane was naming a choice nobody could make. `role.rs`
 * takes a stored answer now, and a phone still cannot be talked out of being a
 * satchel.
 *
 * The reader CAN set it now — see `ROLE_CHOICES`, which asks the same question
 * as a fact about where their books live. This still says what the device does
 * rather than what the protocol calls it, because that is the useful sentence
 * either way, and because the role a phone gets is not a choice at all.
 */
export function describeRole(role: PeerRole | null): string {
  if (role === 'shelf') return 'Holds your library'
  if (role === 'satchel') return 'Reads from your library'
  return '…'
}

/**
 * THE QUESTION THE READER CAN ACTUALLY ANSWER.
 *
 * Not "shelf or satchel" — that is the protocol's vocabulary and it was the
 * confusing thing. It is the same choice asked as a fact about their own
 * books, and the second option is also the only sentence in the pane that
 * explains what pairing is FOR at the moment it is needed.
 *
 * Declared here rather than spelled in the pane so the words and the role they
 * mean cannot drift apart.
 */
export const ROLE_CHOICES: readonly { readonly role: PeerRole; readonly label: string; readonly detail: string }[] = [
  {
    role: 'shelf',
    label: 'On this Mac',
    detail: 'It keeps the whole library and other devices read from it.',
  },
  {
    role: 'satchel',
    label: 'On another device',
    detail: 'This one reads from it and keeps the books you download.',
  },
]

/**
 * May the reader still answer it?
 *
 * ONLY WHILE UNPAIRED. Switching afterwards means reconciling a whole library
 * against a metadata-only one, in both directions, and that is a migration
 * rather than a toggle — the honest move is to refuse it and say what to do
 * instead. Revoking every device puts the choice back.
 */
export function roleIsSettable(peers: readonly WirePeer[]): boolean {
  return peers.length === 0
}

/**
 * Why a pairing that LOOKS finished will never move anything, or null.
 *
 * A working pair needs exactly one side holding the library. Two shelves is
 * the state a second desktop falls into by default and there is nothing in the
 * protocol that refuses it: both sides record the pairing, both report ready,
 * and no session is ever opened because neither has anything to ask for.
 * Measured on this machine and a second Mac — paired, mutual, and silent for
 * thirty-four hours, and the only symptom was a menu with no Download in it.
 *
 * The pane cannot fix that. It can stop it being invisible.
 */
export function pairingFault(mine: PeerRole | null, theirs: PeerRole | null): string | null {
  if (!mine || !theirs) return null
  if (mine === 'shelf' && theirs === 'shelf') {
    return 'Both devices hold their own library, so nothing will sync between them. On the one you want to read from, revoke this pairing and set “Where do your books live?” to “On another device”.'
  }
  if (mine === 'satchel' && theirs === 'satchel') {
    return 'Neither device holds a library, so there is nothing to sync from.'
  }
  return null
}

/**
 * What a peer is allowed to do, said in artifacts rather than in wildcards.
 *
 * The pane printed `sync:*, blob:*` — the transport's own spelling, and not
 * even the spelling the SERVICE table uses (`book:read`, `mark:write`). Two
 * grant vocabularies meet at this pairing and the reader was shown the wrong
 * one, raw.
 *
 * THE COARSENESS IS REAL AND IS NOT HIDDEN HERE. `sync:*` is one wildcard over
 * everything sync carries, because `sync.pull`, `sync.marks` and `sync.content`
 * all require the same `sync:pull` grant (`protocol.ts`). So this returns one
 * phrase covering all of it rather than a list that would imply the reader
 * could have some and not others. Making that true is a change to the sync
 * protocol's grants, not to this function — see `docs/sync.md`.
 */
export function describeGrants(grants: readonly string[]): string {
  const has = (g: string) => grants.some((held) => held === g || held === `${g.split(':')[0]}:*`)
  const parts: string[] = []
  if (has('sync:pull')) parts.push('Books, highlights, reading position')
  if (has('blob:read')) parts.push('book files')
  if (!parts.length) return grants.length ? grants.join(', ') : 'Nothing yet'
  const sentence = parts.join(' and ')
  return has('sync:push') ? `${sentence} — both ways` : `${sentence} — receive only`
}

export interface DevicesSnapshot {
  /** False outside the app (no plugin) — the pane says so instead of lying. */
  readonly available: boolean
  readonly role: PeerRole | null
  readonly endpointId: string | null
  readonly peers: readonly WirePeer[]
  /** The QR being shown, when pairing was begun here. */
  readonly offer: PairOffer | null
  /** A satchel asking to pair — the human confirms against the SAS. */
  readonly pending: PairingPending | null
  /** The SAS to show after `pairWithCode`, while the other side decides. */
  readonly sas: string | null
  readonly lastResult: PairingResult | null
  /** Newest first, capped. */
  readonly transfers: readonly TransferProgress[]
  readonly localOnly: boolean
  /** Set since launch and not yet in force — the node read the old one. */
  readonly roleNeedsRestart: boolean
  readonly error: string | null
}

export interface DevicesModel {
  getSnapshot(): DevicesSnapshot
  subscribe(listener: () => void): Unsubscribe
  refresh(): Promise<void>
  beginPairing(name?: string): Promise<void>
  cancelPairing(): Promise<void>
  confirmPairing(accept: boolean): Promise<void>
  pairWithCode(uri: string): Promise<void>
  forget(id: string): Promise<void>
  setLocalOnly(on: boolean): void
  /** Record which side this device is. Applies at the next launch. */
  setRole(role: PeerRole): Promise<void>
  /** Let a paired device change things here, or restrict it to reading. */
  setPeerCanWrite(id: string, canWrite: boolean): Promise<void>
  dispose(): void
}

/**
 * The plugin's QR, ready to go INTO the document rather than beside it.
 *
 * It used to be `data:image/svg+xml,…` on an `<img>`, and that is what made it
 * look imported: a data URI is opaque to CSS, so the `qrcode` crate's white
 * card and black modules survived every theme the reader could pick. Inlined,
 * the same SVG is ordinary markup and `capability.css` colours it.
 *
 * THE XML PROLOG HAS TO GO. The crate emits `<?xml version="1.0"…?>` ahead of
 * the root element, which is well-formed XML and is not allowed in HTML — the
 * parser drops it as a bogus comment, and a leading stray node inside a figure
 * is the kind of thing that renders fine until something measures the figure's
 * first child. Cheaper to remove it than to explain it later.
 *
 * The SVG is the app's OWN Rust talking to the app's own webview; it carries a
 * QR of a URI this process just minted. That is why inlining it is not the
 * usual untrusted-markup question — but it is exactly the assumption to check
 * if this ever renders a code that arrived from somewhere else.
 */
export function inlineQrSvg(svg: string): string {
  return svg.replace(/^\s*<\?xml[^?]*\?>\s*/i, '')
}

const KEPT_TRANSFERS = 20

export function createDevicesModel({
  port,
  settings,
}: {
  readonly port: PeerPort | null
  readonly settings: SettingsStore
}): DevicesModel {
  let snapshot: DevicesSnapshot = {
    available: port !== null,
    role: null,
    endpointId: null,
    peers: [],
    offer: null,
    pending: null,
    sas: null,
    lastResult: null,
    transfers: [],
    localOnly: settings.get(LOCAL_ONLY_SETTING),
    roleNeedsRestart: false,
    error: null,
  }
  const listeners = new Set<() => void>()
  const publish = (next: Partial<DevicesSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }
  const said = (thrown: unknown): string =>
    thrown instanceof Error ? thrown.message : String((thrown as { message?: string })?.message ?? thrown)

  const offs: Unsubscribe[] = []
  if (port) {
    offs.push(
      port.onPairingPending((pending) => publish({ pending })),
      port.onPairingResult((lastResult) => {
        publish({ lastResult, pending: null, sas: null, offer: lastResult.ok ? null : snapshot.offer })
        void refresh()
      }),
      port.onTransfer((event) => {
        const rest = snapshot.transfers.filter((one) => one.transferId !== event.transferId)
        publish({ transfers: [event, ...rest].slice(0, KEPT_TRANSFERS) })
      }),
    )
  }

  /* Refreshes overlap — a listener fires one while a command's own refresh
   * is in flight — and they can resolve out of order; only the NEWEST may
   * publish, or an older peer list overwrites a newer one. */
  let refreshGeneration = 0
  /* One generation for every pairing-shaped operation (begin, pair-by-code,
   * cancel): whichever started LAST owns the next publish, and a disposal
   * bumps it so nothing publishes into a dead model. */
  let beginGeneration = 0
  let disposed = false
  /* Attempts whose confirmation is already in flight — a second click on
   * the same attempt must not race the first and overwrite its outcome. */
  const confirming = new Set<string>()
  const refresh = async (): Promise<void> => {
    if (!port) return
    const mine = ++refreshGeneration
    try {
      const [status, peers] = await Promise.all([port.status(), port.listPeers()])
      if (mine !== refreshGeneration) return
      publish({ role: status.role, endpointId: status.endpointId, peers, error: null })
    } catch (thrown) {
      if (mine !== refreshGeneration) return
      publish({ error: said(thrown) })
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh,
    beginPairing: async (name) => {
      if (!port || disposed) return
      /* Generation-tokened like refresh: two overlapping begins resolve in
       * either order, and only the NEWEST may publish its offer — the older
       * one's QR is already replaced on the backend. Beginning a NEW attempt
       * legitimately clears a previous attempt's result and SAS — refusing
       * to publish while `lastResult` was set left every later begin with a
       * live backend attempt and no visible QR. Only a confirmation the
       * human is mid-way through (`pending`) may not be stomped. */
      const mine = ++beginGeneration
      try {
        const offer = await port.pairBegin(name)
        if (mine !== beginGeneration || disposed) return
        if (snapshot.pending === null) {
          publish({ offer, lastResult: null, sas: null, error: null })
        }
      } catch (thrown) {
        if (mine !== beginGeneration || disposed) return
        publish({ error: said(thrown) })
      }
    },
    cancelPairing: async () => {
      if (!port || disposed) return
      /* Cancelling supersedes any begin still in flight — its offer must
       * not re-appear after this clears the pane. */
      const mine = ++beginGeneration
      try {
        await port.pairCancel()
        if (mine !== beginGeneration || disposed) return
        publish({ offer: null, pending: null, sas: null, error: null })
      } catch (thrown) {
        /* The native attempt may still be live — saying "stopped" while it
         * runs would be a lie. Keep the state, show the failure. */
        if (mine !== beginGeneration || disposed) return
        publish({ error: said(thrown) })
      }
    },
    confirmPairing: async (accept) => {
      if (!port) return
      /* Bind the confirmation to the attempt the human is looking at, so a
       * pre-played QR that started a different attempt cannot be confirmed
       * by this click. CAPTURED FIRST and REQUIRED: with no pending attempt
       * there is nothing this click can honestly approve, and an id-less
       * confirmation would fall back to Rust's unbound legacy path. */
      const pending = snapshot.pending
      if (!pending) {
        publish({ error: 'nothing is pending confirmation' })
        return
      }
      /* One confirmation per attempt: a double-click's second call would
       * race the first and could overwrite its success with a refusal. */
      if (confirming.has(pending.attemptId)) return
      confirming.add(pending.attemptId)
      try {
        await port.pairConfirm(accept, accept ? OWN_DEVICE_GRANTS : undefined, pending.attemptId)
        if (disposed) return
        /* Clear only what this click confirmed — a NEWER attempt that arrived
         * while the confirmation was in flight stays pending. */
        if (snapshot.pending === null || snapshot.pending.attemptId === pending.attemptId) {
          publish({ pending: null, offer: null, error: null })
        }
        await refresh()
      } catch (thrown) {
        if (!disposed) publish({ error: said(thrown) })
      } finally {
        confirming.delete(pending.attemptId)
      }
    },
    pairWithCode: async (uri) => {
      if (!port || disposed) return
      /* Same ordering rule as beginPairing: only the newest attempt's SAS
       * may land. */
      const mine = ++beginGeneration
      try {
        const start = await port.pairFromUri(uri.trim(), undefined, OWN_DEVICE_GRANTS)
        if (mine !== beginGeneration || disposed) return
        publish({ sas: start.sas, lastResult: null, error: null })
      } catch (thrown) {
        if (mine !== beginGeneration || disposed) return
        publish({ error: said(thrown) })
      }
    },
    forget: async (id) => {
      if (!port || disposed) return
      try {
        await port.forgetPeer(id)
        if (disposed) return
        await refresh()
      } catch (thrown) {
        if (!disposed) publish({ error: said(thrown) })
      }
    },
    setLocalOnly: (on) => {
      settings.set(LOCAL_ONLY_SETTING, on)
      publish({ localOnly: on })
    },
    setPeerCanWrite: async (id, canWrite) => {
      if (!port) return
      try {
        await port.setGrants(id, [...(canWrite ? OWN_DEVICE_GRANTS : READ_ONLY_GRANTS)])
        /* Re-read rather than assume: the plugin is the owner of the record,
           and a grant list echoed back from here would be this pane's idea of
           what it wrote rather than what the store holds. */
        await refresh()
      } catch (thrown) {
        if (!disposed) publish({ error: said(thrown) })
      }
    },
    setRole: async (role) => {
      if (!port) return
      try {
        await port.setLocalRole(role)
        /* `snapshot.role` is NOT moved to match. It reports what the node is
           running as, and the node read its role at start — claiming the new
           one here would put a sentence on screen that the next `refresh()`
           would quietly contradict. The flag is what the pane shows instead. */
        publish({ roleNeedsRestart: true })
      } catch (thrown) {
        if (!disposed) publish({ error: said(thrown) })
      }
    },
    dispose: () => {
      /* Invalidate everything in flight: a command resolving after this
       * must neither publish nor start follow-up IPC. */
      disposed = true
      beginGeneration++
      refreshGeneration++
      for (const off of offs.splice(0)) off()
      listeners.clear()
    },
  }
}

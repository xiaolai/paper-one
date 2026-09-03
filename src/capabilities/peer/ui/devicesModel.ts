import type { PeerPort } from '../lib/port'
import type {
  PairOffer,
  PairingPending,
  PairingResult,
  PeerRole,
  Unsubscribe,
  WirePeer,
} from '../lib/wire'

/**
 * The Devices section's MODEL — everything the pane decides, with no React
 * in it, so the logic is testable in the node project (the WI-C.5 rule:
 * component logic that matters lives in non-React helpers). The pane is an
 * adapter over `getSnapshot`/`subscribe`.
 */

/*
 * "LOCAL NETWORK ONLY" IS GONE, and it is worth saying why rather than
 * leaving a gap here.
 *
 * It was a checkbox wired to nothing: `peer.localOnly` was defined, stored,
 * published into the snapshot and drawn — and no code anywhere read it to
 * change behaviour. Every sync still went out over n0's relays and n0's DNS,
 * while a reader was being shown a control whose name is a promise about
 * where their library travels. A security control that does not control
 * anything is worse than its absence, because it is believed.
 *
 * The transport already has the knobs — `NodeConfig` carries `relay_mode` and
 * `discovery { n0_dns, mdns }`, and the test preset runs with
 * `RelayMode::Disabled` — so the honest version is not far away. What it
 * needs first is a decision this codebase cannot make yet: `for_app` sets
 * `mdns: cfg!(not(target_os = "ios"))`, so on iOS "local only" would mean no
 * relay, no DNS and no mDNS — a switch that silently turns sync off. That is
 * a mobile-transport decision, and the toggle comes back with it.
 */

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
 * The grant list the write toggle should write, given what the peer already
 * holds.
 *
 * REPLACING THE WHOLE LIST WAS WRONG IN BOTH DIRECTIONS. Turning write off
 * used to send exactly `READ_ONLY_GRANTS`, so a peer holding some grant this
 * pane does not model — `shelf:admin`, or anything a later version or the CLI
 * writes — lost it silently to a toggle about writing. And a peer holding NO
 * sync grants at all would have been GRANTED `sync:pull` and `blob:read` by a
 * control whose only stated effect is to take access away.
 *
 * So the toggle owns exactly the families it names: everything under `sync:`
 * and `blob:` is dropped and replaced by the chosen pair, and every other
 * grant is carried through untouched.
 */
export function grantsForWrite(held: readonly string[], canWrite: boolean): string[] {
  const mine = (grant: string) => grant.startsWith('sync:') || grant.startsWith('blob:')
  const kept = held.filter((grant) => !mine(grant))
  if (canWrite) return [...kept, ...OWN_DEVICE_GRANTS]
  /* TURNING IT OFF NEVER GRANTS ANYTHING — EACH GRANT DEMOTED ON ITS OWN. The
     first rule was "a peer holding any sync or blob grant gets the read-only
     pair", and that GRANTED: a peer holding `sync:push` alone was handed
     `blob:read` it never had, and one holding `blob:read` alone was handed
     `sync:pull`. So: a wildcard becomes its family's read grant, a read
     grant stays, `sync:push` goes, and no family the peer did not hold
     appears. A peer with no sync or blob grant at all keeps having none. */
  const reads = new Set<string>()
  for (const grant of held) {
    if (grant === 'sync:*' || grant === 'sync:pull') reads.add('sync:pull')
    if (grant === 'blob:*' || grant === 'blob:read') reads.add('blob:read')
  }
  return [...kept, ...READ_ONLY_GRANTS.filter((grant) => reads.has(grant))]
}

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
    /* "This device", not "this Mac": the pane runs on whatever the reader
       paired, and the row above it already says "This device" (WI-20.25). */
    label: 'On this device',
    detail: 'It keeps the whole library and other devices read from it.',
  },
  {
    role: 'satchel',
    label: 'On another device',
    detail: 'This one reads from it and keeps the books you download.',
  },
]

/**
 * The shelf's pairing name, as this device's peer list records it — the name
 * the other side gave when pairing, which the plugin defaults to its machine
 * name. Null while unpaired, or on the shelf itself.
 */
export function shelfNameOf(peers: readonly WirePeer[]): string | null {
  return peers.find((peer) => peer.role === 'shelf')?.name ?? null
}

/**
 * Where Paper has to be running for a sync to happen, said for THIS device's
 * role. The pane said "on your Mac" to everyone — to the phone whose library
 * lives on a Linux desktop, and to the desktop itself, where "your Mac" meant
 * "here". A satchel is told the shelf by its pairing name; a shelf is told
 * it is itself (WI-20.25). The plugin does not expose this machine's own
 * name to the webview, so the shelf's sentence says "this device", which is
 * also what the row above it calls it.
 */
export function describeReach(role: PeerRole | null, shelfName: string | null): string {
  if (role === 'satchel') {
    return `Syncing needs Paper running on ${shelfName ?? 'the device that holds your library'}; its tray keeps it alive with the window closed.`
  }
  return 'Syncing needs Paper running on this device; the tray keeps it alive with the window closed.'
}

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
 * protocol's grants, not to this function — see `dev-docs/sync.md`.
 */
export function describeGrants(grants: readonly string[]): string {
  const has = (g: string) => grants.some((held) => held === g || held === `${g.split(':')[0]}:*`)
  const parts: string[] = []
  if (has('sync:pull')) parts.push('Books, highlights, reading position')
  if (has('blob:read')) parts.push('book files')
  /* EVERYTHING ELSE IS NAMED, NOT HIDDEN. A peer holding `sync:pull` and
     `shelf:admin` read as "receive only" — the one grant that can empty a
     trash, concealed by the phrase for the others. */
  const known = new Set(['sync:*', 'sync:pull', 'sync:push', 'blob:*', 'blob:read'])
  const other = grants.filter((held) => !known.has(held))
  if (!parts.length) return grants.length ? grants.join(', ') : 'Nothing yet'
  const sentence = parts.join(' and ')
  const way = has('sync:push') ? `${sentence} — both ways` : `${sentence} — receive only`
  return other.length ? `${way}, plus ${other.join(', ')}` : way
}

export interface DevicesSnapshot {
  /** False outside the app (no plugin) — the pane says so instead of lying. */
  readonly available: boolean
  readonly role: PeerRole | null
  readonly peers: readonly WirePeer[]
  /**
   * Whether `peers` has been read from the plugin yet.
   *
   * AN EMPTY LIST BEFORE THE FIRST REFRESH LOOKS EXACTLY LIKE NO PEERS, and
   * `roleIsSettable` reads emptiness as "safe to change sides". So a pane
   * rendered in the gap before the first `refresh()` resolved offered the
   * role control on a device that is already paired — and the write is
   * durable, so the mistake survives the restart it asks for.
   */
  readonly peersLoaded: boolean
  /** The QR being shown, when pairing was begun here. */
  readonly offer: PairOffer | null
  /** A satchel asking to pair — the human confirms against the SAS. */
  readonly pending: PairingPending | null
  /** The SAS to show after `pairWithCode`, while the other side decides. */
  readonly sas: string | null
  readonly lastResult: PairingResult | null
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

export function createDevicesModel({
  port,
}: {
  readonly port: PeerPort | null
}): DevicesModel {
  let snapshot: DevicesSnapshot = {
    available: port !== null,
    role: null,
    peers: [],
    offer: null,
    pending: null,
    sas: null,
    lastResult: null,
    peersLoaded: false,
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
    /* ONE PUSH PER SUBSCRIPTION, AND ROLLED BACK. The two used to be
       ARGUMENTS to a single `offs.push(...)` — the same shape `serve()` in
       `port.ts` was caught with. Arguments evaluate before the call, so a
       throw from the second discarded the first's unsubscribe along with the
       argument list, and here the throw escapes the factory: the caller never
       receives a model, so nothing can ever dispose the listener that
       survived. Each handle is registered the moment it exists, and a throw
       part-way unsubscribes what was taken before re-throwing. */
    try {
      /* ⚠️ **DEVICE ATTEMPTS ONLY — the circle shares this stream.** The two
         surfaces confirm with DIFFERENT grants, so an unfiltered pending event
         let this panel answer a circle request with the reader's own-device
         grants, handing another person the permissions meant for their phone.
         The circle side filters symmetrically in `personPort`. */
      offs.push(
        port.onPairingPending((pending) => {
          if (pending.kind === 'circle') return
          publish({ pending })
        }),
      )
      offs.push(
        port.onPairingResult((lastResult) => {
          /* Device attempts only — see the pending handler above. */
          if (lastResult.kind === 'circle') return
          /* ⚠️ **THE PEER LIST IS UNKNOWN AGAIN UNTIL THE REFRESH LANDS.**
             This cleared `pending` and `sas` — the two flags `setRole` reads
             to mean "a pairing could still land a peer" — and then started an
             asynchronous refresh. In between, `peersLoaded` was still true
             over the OLD, empty list, so `roleIsSettable` said yes and the
             role control was both drawn and answerable: a click there wrote
             the durable role change the guard exists to refuse, and the pair
             that had just formed had two of one side. `peersLoaded: false` is
             the answer that already means "nothing has been read", which is
             exactly the truth in this window — and it fails CLOSED if the
             refresh itself fails. */
          publish({ lastResult, pending: null, sas: null, offer: lastResult.ok ? null : snapshot.offer, peersLoaded: false })
          void refresh()
        }),
      )
      /* NO TRANSFER SUBSCRIPTION. This kept the twenty most recent transfer
         events so the pane could list them — "Transfer 1 — done", the surface
         that per-book download progress replaced. The list went; the
         subscription and its twenty retained records did not, so every device
         pane held a rolling buffer of events nothing rendered. Progress now
         reaches the book's own row through sync's `BookStatus`, which is the
         only place a reader looks for it. */
    } catch (thrown) {
      for (const off of offs.splice(0)) off()
      throw thrown
    }
  }

  /* Refreshes overlap — a listener fires one while a command's own refresh
   * is in flight — and they can resolve out of order; only the NEWEST may
   * publish, or an older peer list overwrites a newer one. */
  /**
   * THE INVITE RETIRES ITSELF, because the attempt behind it does.
   *
   * `PairOffer.expiresAt` was carried into the snapshot and never read: the
   * QR and its copy button stayed on screen indefinitely, so the obvious
   * thing to do with a stale pane — copy the code and send it — produced a
   * refusal on the other device with nothing here suggesting why. Cleared in
   * the MODEL rather than by a component timer, because the snapshot is what
   * every consumer reads and an offer that is gone should be gone for all of
   * them.
   */
  let offerTimer: ReturnType<typeof setTimeout> | null = null
  const retireOffer = (offer: PairOffer | null): void => {
    if (offerTimer !== null) clearTimeout(offerTimer)
    offerTimer = null
    if (offer === null) return
    const left = offer.expiresAt - Date.now()
    if (left <= 0) {
      /* Expired IN FLIGHT — the backend answered an offer already past its
         time. Cleared now, or the QR stood on screen with no timer to end
         it. */
      if (snapshot.offer === offer) publish({ offer: null })
      return
    }
    offerTimer = setTimeout(() => {
      offerTimer = null
      if (disposed) return
      /* Only if it is still THIS offer — a newer begin has its own timer. */
      if (snapshot.offer === offer) publish({ offer: null })
    }, left)
  }

  let refreshGeneration = 0
  /* One generation for every pairing-shaped operation (begin, pair-by-code,
   * cancel): whichever started LAST owns the next publish, and a disposal
   * bumps it so nothing publishes into a dead model. */
  let beginGeneration = 0
  let disposed = false
  /* Attempts whose confirmation is already in flight — a second click on
   * the same attempt must not race the first and overwrite its outcome. */
  const confirming = new Set<string>()
  /** Per peer, the grant edit in flight — see `setPeerCanWrite`. */
  const grantEdits = new Map<string, Promise<void>>()
  const refresh = async (): Promise<void> => {
    if (!port || disposed) return
    const mine = ++refreshGeneration
    try {
      const [status, peers] = await Promise.all([port.status(), port.listPeers()])
      if (disposed || mine !== refreshGeneration) return
      publish({ role: status.role, peers, peersLoaded: true, error: null })
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
      /* NOT ACROSS A ROLE CHANGE THAT HAS NOT RESTARTED. The node still runs
         the OLD role, so a pairing made now is made as that role — and the
         restart then turns it into a pair with two of one side, durably. */
      if (snapshot.roleNeedsRestart) {
        publish({ error: 'Restart Paper to apply the role change before pairing' })
        return
      }
      /* Generation-tokened like refresh: two overlapping begins resolve in
       * either order, and only the NEWEST may publish its offer — the older
       * one's QR is already replaced on the backend. Beginning a NEW attempt
       * legitimately clears a previous attempt's result and SAS — refusing
       * to publish while `lastResult` was set left every later begin with a
       * live backend attempt and no visible QR. Only a confirmation the
       * human is mid-way through (`pending`) may not be stomped. */
      /* CHECKED BEFORE THE CALL, not after it. `pairBegin` replaces whatever
         attempt the backend is holding — so testing `pending` only around the
         PUBLISH destroyed the confirmation the human was reading a SAS for,
         and then declined to show the new offer, leaving both. The comment
         above says this may not be stomped; now it is not. */
      if (snapshot.pending !== null) return
      const mine = ++beginGeneration
      try {
        const offer = await port.pairBegin(name)
        if (mine !== beginGeneration || disposed) return
        if (snapshot.pending === null) {
          publish({ offer, lastResult: null, sas: null, error: null })
          retireOffer(offer)
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
      if (!port || disposed) return
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
          /* AND THE PEER LIST IS UNKNOWN UNTIL THE REFRESH BELOW — the same
             window as `onPairingResult`, for the same reason: the flags that
             say "a peer may still land" are being cleared here, and the list
             that would show the one that just did has not been read yet. */
          publish({ pending: null, offer: null, error: null, peersLoaded: false })
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
      /* NOT ACROSS A ROLE CHANGE THAT HAS NOT RESTARTED. The node still runs
         the OLD role, so a pairing made now is made as that role — and the
         restart then turns it into a pair with two of one side, durably. */
      if (snapshot.roleNeedsRestart) {
        publish({ error: 'Restart Paper to apply the role change before pairing' })
        return
      }
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
    setPeerCanWrite: async (id, canWrite) => {
      if (!port || disposed) return
      /* ONE EDIT AT A TIME PER PEER. The read-modify-write below, run twice
         in overlap from two quick toggles, read the same old list twice and
         the later write carried the earlier intent — write access left on
         after the reader turned it off. Chained on the peer's own promise. */
      const previous = grantEdits.get(id) ?? Promise.resolve()
      const mine = previous.then(async () => {
        if (disposed) return
        try {
          /* Read what the peer holds first: the toggle owns `sync:` and `blob:`
             and must not be able to add or drop anything else — see
             `grantsForWrite`. */
          const held = (await port.listPeers()).find((one) => one.id === id)?.grants ?? []
          /* Re-checked across the await: a disposal between the read and the
             write must not start further IPC on a dead model. */
          if (disposed) return
          await port.setGrants(id, grantsForWrite(held, canWrite))
          /* Re-read rather than assume: the plugin is the owner of the record,
             and a grant list echoed back from here would be this pane's idea of
             what it wrote rather than what the store holds. */
          await refresh()
        } catch (thrown) {
          if (!disposed) publish({ error: said(thrown) })
        }
      })
      grantEdits.set(id, mine)
      await mine
      if (grantEdits.get(id) === mine) grantEdits.delete(id)
    },
    setRole: async (role) => {
      if (!port || disposed) return
      /* THE INVARIANT, ENFORCED WHERE IT CAN BE. Changing sides while paired
         leaves a pair with no shelf or two of them, and the write is durable,
         so the mistake survives the restart it asks for. The pane hides the
         control, but hiding is not enforcing — and `peersLoaded` is why the
         emptiness is trustworthy: before the first refresh the list is empty
         because nothing has been read, which is not the same answer. */
      if (!snapshot.peersLoaded || !roleIsSettable(snapshot.peers)) return
      /* NOT WHILE A PAIRING IS IN FLIGHT: an offer on screen, a code being
         joined or a SAS being read means a peer record can land after this
         check, and the pair that results has two of one side.

         ALL THREE, NOT TWO. This named the joiner's window and then tested
         only `offer` and `pending` — the shelf's two halves. A satchel that
         has pasted a code holds neither: `pairWithCode` publishes `sas` and
         nothing else, its peer list is still empty until the far shelf
         confirms, so `roleIsSettable` says yes and the control is on screen.
         Changing sides there is exactly the durable two-shelf pair this guard
         exists to refuse. The window closes on its own — `from_uri` emits a
         `pairing-result` either way, bounded by the ack timeout, and that
         clears `sas` — so refusing here cannot wedge the control. */
      if (snapshot.offer !== null || snapshot.pending !== null || snapshot.sas !== null) {
        /* AND IT NAMES ONLY WHAT IS ON SCREEN. Cancel belongs to the invite —
           the pane draws it inside the offer — so a joiner reading its SAS
           told to "cancel" would go looking for a button that is not there.
           Waiting is what that side actually does, and the wait is bounded:
           the shelf answers or the attempt times out, and either way a
           `pairing-result` clears the SAS. */
        const canCancelHere = snapshot.offer !== null || snapshot.pending !== null
        publish({
          error: canCancelHere
            ? 'Finish or cancel the pairing in progress before changing sides'
            : 'Wait for the other device to answer this pairing before changing sides',
        })
        return
      }
      /* CHOOSING WHAT IS ALREADY RUNNING IS NOT A CHANGE. Every successful
         write used to raise "restart to apply", including the one that put
         the device back where it started. */
      const changes = snapshot.role !== null && snapshot.role !== role
      try {
        await port.setLocalRole(role)
        if (disposed) return
        /* `snapshot.role` is NOT moved to match. It reports what the node is
           running as, and the node read its role at start — claiming the new
           one here would put a sentence on screen that the next `refresh()`
           would quietly contradict. The flag is what the pane shows instead. */
        publish({ roleNeedsRestart: changes })
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
      if (offerTimer !== null) clearTimeout(offerTimer)
      offerTimer = null
      for (const off of offs.splice(0)) off()
      listeners.clear()
    },
  }
}

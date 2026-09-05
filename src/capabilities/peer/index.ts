import { messageOf } from '../../kernel'
import { createElement } from 'react'
import type { Capability, CapabilityContext, DevicePort, DeviceRow, Disposable, ServiceContribution } from '../../kernel'
import { createPeerPort, type PeerPort } from './lib/port'
import {
  hasTauri,
  tauriWire,
  type KnownPerson,
  type PairOffer,
  type PairStart,
  type PairingPending,
  type PairingResult,
  type PagePublisher,
  type PeerWire,
  type PersonStatus,
  type WirePeer,
} from './lib/wire'
import { createDevicesModel, type DevicesModel } from './ui/devicesModel'
import { DevicesPane } from './ui/DevicesPane'

/**
 * The `peer` capability — the transport (WI-C.1).
 *
 * The Rust half is `crates/tauri-plugin-peer` (phase 7): identity, pairing,
 * allow-listed sessions, blobs. This half is the typed wire over it
 * (`lib/wire.ts`, the one capability file importing @tauri-apps/api), the
 * envelope multiplexer (`lib/envelope.ts`), the PORT other capabilities
 * reach it through (`lib/port.ts` — `sync` lists `peer` in `requires` and
 * imports THIS file), and the Devices section the kernel's Settings pane
 * renders.
 *
 * The port is a MODULE SLOT filled by `start()`: registration order runs
 * `peer` before anything that requires it, so a dependent's `start` may call
 * `peerPort()` and trust the answer. Outside the app (a browser tab) there
 * is no plugin; the slot stays null and everything above degrades visibly.
 */

let port: PeerPort | null = null
/**
 * The raw wire, kept because `personPort` needs commands the `PeerPort`
 * abstraction does not carry — identity is not a session.
 *
 * Set and cleared with `port`, so "peer is running" is one fact rather than
 * two that can disagree.
 */
let wire: PeerWire | null = null
let model: DevicesModel | null = null
/** "Sync now" — the sync capability drops its trigger here (peer cannot
 *  import sync; the dependency runs the other way). */
let syncNow: (() => void) | null = null

/** How long between each retried role read at boot — one wait per retry, so the count of tries follows the list. */
const ROLE_BACKOFF_MS = [250, 500] as const
const ROLE_TRIES = ROLE_BACKOFF_MS.length + 1
/** One poll of the backoff wait — the unit the wait is counted in, so a stop is noticed within one of these. */
const ROLE_POLL_MS = 25

/**
 * This device's role, retried — or `null` when it could not be read at all.
 *
 * The service host is bound ONCE per composition, so whatever this answers
 * decides whether a shelf serves for the rest of the session. A single
 * transient failure used to answer "satchel", which serves nothing: a shelf
 * that lost one race at startup silently served nothing until the app was
 * restarted, and the log said `role-unknown` once with nothing acting on it.
 *
 * `null` rather than a guessed role: the caller serves nothing either way,
 * but "we could not find out" and "this is a satchel" are different facts and
 * only one of them is true.
 */
export async function readRole(
  port: { localRole: () => Promise<'shelf' | 'satchel'> },
  stopped: () => boolean,
  diagnostics: { warn: (event: string, fields: Record<string, unknown>) => void },
): Promise<'shelf' | 'satchel' | null> {
  let last: unknown = null
  for (let attempt = 0; attempt < ROLE_TRIES; attempt += 1) {
    if (stopped()) return null
    try {
      return await port.localRole()
    } catch (error) {
      last = error
      const wait = ROLE_BACKOFF_MS[attempt]
      if (wait === undefined) break
      /* The wait gives up as soon as the run is stopped, rather than holding
         the composition for the rest of the backoff.

         COUNTED IN POLLS, NOT IN WALL TIME. This measured `Date.now() -
         started`, and `Date.now()` is not monotonic: a clock set back during
         the wait — NTP, a time-zone correction, a laptop waking — made the
         difference negative and held the shelf's services for the rest of the
         adjustment, not the rest of the backoff. Each poll is one timer of a
         fixed length, so the polls ARE the elapsed time, and no clock is
         consulted at all. */
      await new Promise<void>((resolve) => {
        let remaining = Math.ceil(wait / ROLE_POLL_MS)
        const tick = (): void => {
          remaining -= 1
          // Stryker disable next-line EqualityOperator: one poll later is the same wait to a caller measured in polls.
          if (stopped() || remaining <= 0) resolve()
          else setTimeout(tick, ROLE_POLL_MS)
        }
        setTimeout(tick, ROLE_POLL_MS)
      })
    }
  }
  if (stopped()) return null
  /* Serving nothing is the safe side, but a role that could not be read means
   * this shelf's services never serve — a fact for the log, not a silent
   * guess. Reported after the retries, so it names a conclusion. */
  diagnostics.warn('peer.role-unknown', {
    tries: ROLE_TRIES,
    message: messageOf(last),
  })
  return null
}

/** The peer port, for capabilities that declared `requires: ["peer"]`.
 *  Null before `peer.start` ran, and outside the Tauri app. */
export function peerPort(): PeerPort | null {
  return port
}

/**
 * The person identity and the circle roster, for `circle` — WI-22.B1/B3.
 *
 * ⚠️ **A PORT RATHER THAN A SECOND WIRE**, the way `companion` reaches
 * `inferencePort()`. These are the PEER plugin's commands, and
 * `no-tauri-api-outside-peer-wire` asks for one file per plugin *"so the set of
 * command names is auditable in one place"* — a wire of `circle`'s own calling
 * `plugin:peer|…` would leave that sentence false while the rule still passed.
 *
 * `null` before `peer` has started, and on a composition that has no `peer` at
 * all — the browser client. A caller shows the panel's empty state rather than
 * failing: no plugin is no circle, which is a state and not an error.
 */
export function personPort(): PersonPort | null {
  /* Captured, not read through the module binding on every call: `wire` is
     cleared on stop, and a port that re-read it would start throwing mid-flight
     instead of simply belonging to the run that made it. */
  const held = wire
  return held === null ? null : personPortOver(held)
}

/**
 * What a page needs from this device: its identity, and its signature.
 *
 * ⚠️ **SEPARATE FROM `PersonPort`, BECAUSE THE AUDIENCE IS.** `PersonPort` is
 * what the circle PANEL uses — the reader's own custody, the people they know.
 * This is what the page TRANSPORT uses, and it is the only surface that can
 * make this device sign anything. Keeping them apart means a UI component
 * cannot reach a signing key by holding the port it needed for a name.
 *
 * `null` before `peer` has started, and on a composition without it.
 */
export interface PublishPort {
  /** The device's person, delegation and roster. `null` if it has no identity. */
  mine(): Promise<PagePublisher | null>
  /** Sign a page's bytes. Rust refuses anything that is not a page. */
  sign(message: string): Promise<string>
}

export function publishPort(): PublishPort | null {
  const held = wire
  return held === null ? null : publishPortOver(held)
}

/**
 * ONE PORT PER WIRE, so that `publishPort() === port` means "the peer that
 * answered `mine()` is still the one running". The circle's publisher holds
 * the port it built a page with and refuses to sign through any other — a
 * restart between building and signing must not sign this page with a
 * different device's key. That check reads identity, and this used to build a
 * fresh object on every call, so against the real plugin it could never pass:
 * every page signing failed in production, and the capability's own tests
 * hid it by mocking `publishPort` with one stable object. Keyed weakly on the
 * wire: a restart installs a new wire and therefore a new port, and a wire
 * that is gone takes its port with it.
 */
const publishPorts = new WeakMap<PeerWire, PublishPort>()

/** The port over a wire — see `personPortOver` for why this is separate. */
export function publishPortOver(held: PeerWire): PublishPort {
  const known = publishPorts.get(held)
  if (known !== undefined) return known
  const port: PublishPort = {
    mine: () => held.circleMine(),
    sign: (message) => held.pageSign(message),
  }
  publishPorts.set(held, port)
  return port
}

/**
 * The port over a wire — the shape `devicePortOver` uses, and for its reason.
 *
 * ⚠️ **SO THE PAIRING KIND CAN BE TESTED.** `personPort` reads module state
 * that only `start` sets, so nothing could assert that a circle offer really
 * asks for a CIRCLE pairing; a test at the panel could only check that `offer`
 * was called, which passed just as happily with `'device'` bound here. That is
 * the whole decision this function exists to expose.
 */
export function personPortOver(held: PeerWire): PersonPort {
  const known = personPorts.get(held)
  if (known !== undefined) return known
  /* The identity's listeners live with the port, and the port with the wire
     (`personPorts`): a port built afresh on every call had nobody to tell. */
  const identity = new Set<(event: IdentityEvent) => void>()
  const told = (event: IdentityEvent): void => {
    for (const fn of [...identity]) {
      try {
        fn(event)
      } catch (cause) {
        console.error('Paper: an identity listener threw', cause)
      }
    }
  }
  const port: PersonPort = {
    status: (devices, circle) => held.personStatus(devices, circle),
    /* ⚠️ **TOLD ON EVERY `ensure`**, whether or not one existed: the wire does
       not say, and what the listeners do — publish the shelf, warm the
       opinions, tell the share controls — is idempotent. Told AFTER the wire
       answered, so a listener that asks the wire finds the identity there. */
    ensure: async () => {
      const person = await held.personEnsure()
      told({ kind: 'made', person })
      return person
    },
    phrase: () => held.personPhrase(),
    restore: async (words) => {
      const person = await held.personRestore(words)
      told({ kind: 'restored', person })
      return person
    },
    forget: async () => {
      await held.personForget()
      told({ kind: 'forgotten' })
    },
    people: () => held.circlePeople(),
    /* ⚠️ **THE ROSTER'S SIZE, READ FROM THE ROSTER — WI-23.A3.** `circle`
       used to answer a hardcoded 1 here, which showed the custody marker to a
       reader with three devices. The roster this device presents, this device
       included; a reader with no identity has no roster and is not at risk of
       losing one, so 0 is the honest count and the marker does not read it.

       READ, NOT MINTED. This went through `circleMine`, which renews a
       delegation that is due and REFUSES a leaf whose delegation ran out — so
       refreshing the Circle panel either wrote credentials or replaced the
       panel with an error, for a count that was on disk the whole time.
       `circleRoster` reads the file and nothing else, as `status` does. */
    devices: async () => (await held.circleRoster())?.length ?? 0,
    remember: (person, name) => held.circleRemember(person, name),
    forgetPerson: (person) => held.circleForget(person),
    introduce: (device, addrs) => held.circleIntroduce(device, addrs),
    revokeDevice: (device) => held.circleRevoke(device),
    /* ── adding somebody (WI-22.B3) ──────────────────────────────────────
     *
     * ⚠️ **A PERSON IS ADDED BY PAIRING, NOT BY TYPING AN ID.** The circle file
     * records people this reader has MET; `circle::admit` refuses anybody else,
     * so an id entered by hand would be a row that never admits anything. What
     * makes a person real is the six digits two humans compared — which is why
     * this is the pairing flow and not a text field. */
    offer: () => held.pairBegin(undefined, 'circle'),
    join: (uri) => held.pairFromUri(uri, undefined, ['circle:read']),
    confirm: (accept, attemptId) => held.pairConfirm(accept, ['circle:read'], attemptId),
    cancel: () => held.pairCancel(),
    /* ⚠️ **FILTERED HERE, SO A PANEL CANNOT FORGET.** Devices and the circle
       subscribe to ONE stream and confirm with different grants — unlabelled,
       Devices could answer a circle request with a reader's own-device grants.
       Doing the filter in the port rather than in each panel means a third
       consumer inherits it instead of re-deriving it. */
    onPending: (fn) => held.onPairingPending((e) => { if (e.kind === 'circle') fn(e) }),
    onResult: (fn) => held.onPairingResult((e) => { if (e.kind === 'circle') fn(e) }),
    onIdentity: (fn) => {
      identity.add(fn)
      return () => {
        identity.delete(fn)
      }
    },
  }
  personPorts.set(held, port)
  return port
}

/**
 * ONE PERSON PORT PER WIRE, for `publishPorts`' reason and one more: the
 * identity's listeners are held by the port, so a port made afresh on every
 * `personPort()` call would tell nobody. Keyed weakly, so a wire that is gone
 * takes its port and its listeners with it.
 */
const personPorts = new WeakMap<PeerWire, PersonPort>()

/** What changed about this device's OWN identity, through the person port. */
export interface IdentityEvent {
  readonly kind: 'made' | 'restored' | 'forgotten'
  /** The person id — for `made` and `restored`. */
  readonly person?: string
}

/** What `circle`'s panel needs, with no Tauri types in it. */
export interface PersonPort {
  status(devices: number, circle: number): Promise<PersonStatus>
  ensure(): Promise<string>
  phrase(): Promise<string | null>
  restore(words: string): Promise<string>
  forget(): Promise<void>
  people(): Promise<readonly KnownPerson[]>
  /** How many of this reader's OWN devices the roster carries, this one included. */
  devices(): Promise<number>
  remember(person: string, displayName: string): Promise<void>
  forgetPerson(person: string): Promise<void>
  /**
   * Introduce this device to another over the circle door.
   *
   * `false` means that person's device did not admit this one — an answer, not
   * an error. See `PeerWire.circleIntroduce`.
   */
  introduce(device: string, addrs?: readonly string[]): Promise<boolean>
  /**
   * Revoke one of this reader's OWN devices.
   *
   * Distinct from `forgetPerson`, which drops somebody else. See
   * `PeerWire.circleRevoke`.
   */
  revokeDevice(device: string): Promise<void>
  /** Start a circle offer — the QR and link a friend joins with. */
  offer(): Promise<PairOffer>
  /** Join a friend's offer. Answers the six digits to compare. */
  join(uri: string): Promise<PairStart>
  /** Answer somebody who is asking to join. */
  confirm(accept: boolean, attemptId: string): Promise<WirePeer | null>
  cancel(): Promise<void>
  onPending(fn: (event: PairingPending) => void): () => void
  onResult(fn: (event: PairingResult) => void): () => void
  /**
   * Told when this device's own identity is made, restored or forgotten —
   * through THIS port, which is the only writer of it in this process.
   *
   * ⚠️ **THE ONE SIGNAL AN IDENTITY MAKES.** The library does not change
   * when an identity is made, so everything that waited on one — the
   * published shelf, the opinions whose switch is on, every share control
   * saying "Start a circle" — had nothing to hear, and a panel calling a
   * capability's method after `ensure` was the panel doing the capability's
   * wiring. The capability subscribes here instead.
   */
  onIdentity(fn: (event: IdentityEvent) => void): () => void
}

/** Register the Devices section's "Sync now" action. Returns the unregister. */
export function registerSyncNow(fn: () => void): () => void {
  syncNow = fn
  return () => {
    if (syncNow === fn) syncNow = null
  }
}

/**
 * A stored peer as the service table's `device` noun describes one.
 *
 * BUILT FROM NAMED FIELDS, never spread. The plugin's `lastAddrs` is this
 * LAN's shape — internal hostnames and private addresses — and no caller of
 * `device.list` needs it to name a device; a spread would publish it, and
 * would publish whatever the plugin adds next without anyone deciding to.
 *
 * The grants are COPIED. They are the plugin's own array, and a caller that
 * sorted or pushed to what it was handed would be editing the authorisation
 * record this process is holding.
 */
export const deviceRow = (peer: WirePeer): DeviceRow => ({
  id: peer.id,
  name: peer.name,
  platform: peer.platform,
  role: peer.role,
  grants: [...peer.grants],
  pairedAt: peer.pairedAt,
  lastSeenAt: peer.lastSeenAt,
})

/**
 * The `device` noun, over a peer plugin.
 *
 * EXTRACTED so it can be tested. It lived inline in `start`, which needs a
 * composed app around it — so the three operations that CHANGE a peer's
 * authorisation had never been executed by a test at all: not the refusal
 * translation, not the read-back, not the concurrent-forget behaviour that
 * exists because two of them raced in the field.
 */
export function devicePortOver(port: {
  listPeers: () => Promise<readonly WirePeer[]>
  setGrants: (id: string, grants: readonly string[]) => Promise<unknown>
  forgetPeer: (id: string) => Promise<unknown>
}): DevicePort {
  /* The plugin's own refusal for "there is no such peer", which is not a
   * `ServiceError` — so it crossed the envelope as `internal`, the generic
   * code a caller cannot branch on, for a condition with a perfectly good
   * name. */
  const unknownPeer = (cause: unknown): boolean => (cause as { kind?: unknown })?.kind === 'peerUnknown'
  const noPeer = (id: string) => ({ code: 'not-found', message: `no peer ${id}`, retryable: false })
  return {
    list: async () => (await port.listPeers()).map(deviceRow),
    grant: async (id, grants) => {
      await port.setGrants(id, grants).catch((cause: unknown) => {
        /* The read-back below reports the same thing when the peer vanished
         * between the two calls; this reports it when it was never there. */
        if (unknownPeer(cause)) throw noPeer(id)
        throw cause
      })
      const after = (await port.listPeers()).find((one) => one.id === id)
      /* The peer AS IT NOW STANDS, read back rather than echoed: the plugin
       * is the authority on what it stored, and a caller told "these are the
       * grants" from its own request would never learn that one had been
       * dropped. */
      if (!after) throw noPeer(id)
      return deviceRow(after)
    },
    forget: async (id) => {
      /* ASKED ONCE, not looked-up-then-deleted. The pre-check and the delete
       * were separate IPC calls, so two concurrent forgets both saw the peer,
       * one deleted it and the other's delete failed on a peer that had just
       * gone — reported as an error for doing exactly what was asked. The
       * plugin is the authority on whether there was anything to forget, and
       * `peerUnknown` is its answer for "no". */
      try {
        await port.forgetPeer(id)
        return true
      } catch (cause) {
        if (unknownPeer(cause)) return false
        throw cause
      }
    },
  }
}

/**
 * What one `start` acquired, so releasing it is not four closures.
 *
 * `stop` used to read four `let` slots out of `start`'s scope, which is why
 * that function was over a hundred lines and why the teardown could only be
 * exercised by composing the whole capability. A record makes both halves
 * ordinary functions.
 */
export interface PeerResources {
  port: PeerPort | null
  model: DevicesModel | null
  serviceHost: Disposable | null
  devicePort: Disposable | null
  /** The kernel's hash port, bound while the plugin is there — BLAKE3 in Rust (WI-23.C5). */
  hashPort: Disposable | null
}

/**
 * Release everything one `start` acquired, in reverse order.
 *
 * EACH STEP ISOLATED: a throwing dispose must not rob the later steps — nor
 * leave the module slots pointing at a dead instance. A capability whose
 * teardown gives up halfway is worse than one that never had a teardown,
 * because the half that ran makes the rest look done.
 */
export function releasePeer(held: PeerResources, diagnostics: { warn: (event: string, fields: Record<string, unknown>) => void }): void {
  const step = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (error) {
      /* The report itself is guarded: a diagnostics port that throws must
         not rob the steps after this one either. */
      try {
        diagnostics.warn('peer.teardown-step-failed', {
          label,
          message: messageOf(error),
        })
      } catch {
        /* Nothing left to tell it to. */
      }
    }
  }
  /* In REVERSE order of acquisition — `start` binds the model, then the
     service host, then the device port — so the device port goes first. The
     test that pinned the other order named it reverse and was not. */
  step('hash-port', () => held.hashPort?.dispose())
  step('device-port', () => held.devicePort?.dispose())
  step('service-host', () => held.serviceHost?.dispose())
  step('devices-model', () => held.model?.dispose())
}

/**
 * Serve the composed service table — but only on a SHELF, and only while this
 * capability is alive.
 *
 * The kernel serves the whole set once every capability has started, and this
 * capability owns the shelf side of it: a shelf serves them over the router, a
 * satchel serves nothing. That is what makes a declared service reachable —
 * not each capability serving its own subset.
 *
 * TEARDOWN IS RE-CHECKED AFTER EVERY AWAIT. A serve that resolves past `stop`
 * is unserved on the spot rather than leaking listeners into an ended
 * lifetime.
 */
export function serveWhenShelf(options: {
  readonly port: PeerPort | null
  readonly stopped: () => boolean
  readonly diagnostics: { warn: (event: string, fields: Record<string, unknown>) => void }
}): (services: readonly ServiceContribution[]) => Promise<Disposable> {
  const NOTHING_SERVED: Disposable = { dispose: () => {} }
  return async (services) => {
    const held = options.port
    if (!held || options.stopped()) return NOTHING_SERVED
    const role = await readRole(held, options.stopped, options.diagnostics)
    if (options.stopped() || role !== 'shelf' || services.length === 0) return NOTHING_SERVED
    const unserve = await held.serve(services)
    if (options.stopped()) {
      unserve()
      return NOTHING_SERVED
    }
    return { dispose: () => unserve() }
  }
}

export const peer: Capability = {
  id: 'peer',
  requires: [],

  settings: [
    {
      id: 'peer:devices',
      title: 'Devices',
      /* After Storage — see the note there. Both declare a number rather than
       * one of them leaning on the default, so neither moves when the other
       * changes its mind, and the gap leaves room to slot something between
       * them without renumbering either. */
      order: 20,
      render: () => (model ? createElement(DevicesPane, { model, syncNow }) : null),
    },
  ],

  start(api: CapabilityContext, signal: AbortSignal): Disposable {
    /* TEARDOWN FIRST, ACQUISITIONS AFTER. `stop` is registered with the
     * kernel's disposer stack BEFORE anything is acquired, so a
     * `createDevicesModel` that throws leaves no live port behind. And it
     * clears the MODULE slots only while it still owns them — an overlapping
     * restart's newer instances are not this stop's to destroy. */
    // Stryker disable next-line ObjectLiteral: every field is null until acquired; `releasePeer` reads them by name.
    const held: PeerResources = { port: null, model: null, serviceHost: null, devicePort: null, hashPort: null }
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      signal.removeEventListener('abort', stop)
      releasePeer(held, api.diagnostics)
      if (model === held.model) model = null
      if (port === held.port) {
        port = null
        /* Cleared WITH the port, so "peer is running" stays one fact. A wire
           left standing past a stop would hand `circle` a live door into a
           plugin this capability has already released. */
        wire = null
      }
    }
    api.onCleanup(stop)
    signal.addEventListener('abort', stop, { once: true })

    const built = hasTauri() ? tauriWire() : null
    wire = built
    held.port = built === null ? null : createPeerPort(built)
    port = held.port
    held.model = createDevicesModel({ port: held.port })
    model = held.model
    void held.model.refresh()

    held.serviceHost = api.services.bindServiceHost(
      serveWhenShelf({ port: held.port, stopped: () => stopped, diagnostics: api.diagnostics }),
    )

    /* THE `device` NOUN of the service table (phase 11). Pairing state lives
     * in `peers.rs` and the kernel imports nothing from a capability, so it
     * reaches the `device.*` handlers as a late-bound port — read at CALL
     * time, which is what lets a handler built before this `start` see it.
     *
     * Bound only where there IS a plugin. Unbound, `device.*` refuses
     * `unsupported` by name rather than answering an empty peer list, which
     * is the difference between "nothing is paired" and "this host cannot
     * see what is paired". */
    if (held.port) {
      held.devicePort = api.services.bindDevicePort(devicePortOver(held.port))
      /* Captured, not re-read: a port the run no longer holds must not answer through the slot. */
      const port = held.port
      // Stryker disable next-line all: wiring — the plugin's hash handed to the kernel's slot; `services.ports.test.ts` holds the slot and the plugin its hash.
      held.hashPort = api.services.bindHashPort({ hashFile: (folder, name) => port.hashFile(folder, name) })
    }

    api.diagnostics.info('peer.started', { available: held.port !== null })
    return { dispose: stop }
  },
}

/* The wire's TYPES and the port's, for dependents and for the composition. */
export type { PeerPort, Channel } from './lib/port'
export { createPeerPort } from './lib/port'
export type {
  BlobRequest,
  DeviceRole,
  HashResult,
  KnownPerson,
  PairOffer,
  PairStart,
  PairingPending,
  PersonStatus,
  Version,
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
} from './lib/wire'
/* WHAT THE ENVELOPE PUBLISHES OUTSIDE THIS CAPABILITY, and no more.
 *
 * `src/cli/remote.ts` reaches a remote shelf over a `Channel` the peer port
 * hands it, and needs exactly one thing from the envelope: the error class, so
 * a refusal that crossed the wire can be told from a local fault.
 *
 * The codec and the two ends — `createClient`, `createRouter`, `encodeFrame`,
 * `decodeFrame`, `ENVELOPE_VERSION`, `ENVELOPE_ERRORS`, `serviceError` — were
 * exported here too, with a comment saying the CLI required the router and the
 * client "as the pair". It does not, and never did: a grep for any of them
 * imported through this index finds nothing. They are the protocol's internals,
 * and publishing them made the capability's public surface the whole wire
 * format — every one of them a shape a consumer could pin and a refactor could
 * then break. Anything inside the capability imports `./lib/envelope`
 * directly, which is where its own tests get them. */
export { ServiceCallError } from './lib/envelope'
export type { ServiceError } from './lib/envelope'
export type { CallOptions, Client, ClientOptions, Frame, FrameKind, Router, RouterConnection, RouterOptions } from './lib/envelope'

/* The in-memory wire pair, re-exported so a DEPENDENT capability's tests can
 * run the real protocol over it without reaching past this index (the
 * boundary rules allow another capability only this file). Excluded from
 * coverage as a testkit; a few hundred bytes in the bundle is the price of
 * the boundary staying whole. */
export { fakeBlobHash, fakeWire, linkWires, linkedWires } from './lib/fakeWire.testkit'
export type { FakeWire, FakeWireOptions } from './lib/fakeWire.testkit'

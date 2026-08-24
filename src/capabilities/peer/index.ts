import { createElement } from 'react'
import type { Capability, CapabilityContext, DevicePort, DeviceRow, Disposable, ServiceContribution } from '../../kernel'
import { createPeerPort, type PeerPort } from './lib/port'
import { hasTauri, tauriWire, type WirePeer } from './lib/wire'
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
let model: DevicesModel | null = null
/** "Sync now" — the sync capability drops its trigger here (peer cannot
 *  import sync; the dependency runs the other way). */
let syncNow: (() => void) | null = null

/** The peer port, for capabilities that declared `requires: ["peer"]`.
 *  Null before `peer.start` ran, and outside the Tauri app. */
/** How many times, and how long between, a role read is retried at boot. */
const ROLE_TRIES = 3
const ROLE_BACKOFF_MS = [250, 500] as const

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
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  if (stopped()) return null
  /* Serving nothing is the safe side, but a role that could not be read means
   * this shelf's services never serve — a fact for the log, not a silent
   * guess. Reported after the retries, so it names a conclusion. */
  diagnostics.warn('peer.role-unknown', {
    tries: ROLE_TRIES,
    message: last instanceof Error ? last.message : String(last),
  })
  return null
}

export function peerPort(): PeerPort | null {
  return port
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
      diagnostics.warn('peer.teardown-step-failed', {
        label,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  step('service-host', () => held.serviceHost?.dispose())
  step('device-port', () => held.devicePort?.dispose())
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
    const held: PeerResources = { port: null, model: null, serviceHost: null, devicePort: null }
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      signal.removeEventListener('abort', stop)
      releasePeer(held, api.diagnostics)
      if (model === held.model) model = null
      if (port === held.port) port = null
    }
    api.onCleanup(stop)
    signal.addEventListener('abort', stop, { once: true })

    held.port = hasTauri() ? createPeerPort(tauriWire()) : null
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

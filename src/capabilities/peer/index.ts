import { createElement } from 'react'
import type { Capability, CapabilityContext, Disposable } from '../../kernel'
import { createPeerPort, type PeerPort } from './lib/port'
import { hasTauri, tauriWire } from './lib/wire'
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

export const peer: Capability = {
  id: 'peer',
  requires: [],

  settings: [
    {
      id: 'peer:devices',
      title: 'Devices',
      render: () => (model ? createElement(DevicesPane, { model, syncNow }) : null),
    },
  ],

  start(api: CapabilityContext, signal: AbortSignal): Disposable {
    /* Teardown FIRST, acquisitions after: `stop` reads this invocation's own
     * slots and is registered with the kernel's disposer stack BEFORE
     * anything is acquired, so a `createDevicesModel` that throws leaves no
     * live port behind. And it clears the module slots only while it still
     * owns them — an overlapping restart's newer instances are not this
     * stop's to destroy. */
    let myPort: PeerPort | null = null
    let myModel: DevicesModel | null = null
    let unbindServiceHost: Disposable | null = null
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      signal.removeEventListener('abort', stop)
      /* Each step isolated: a throwing dispose must not rob the later steps
       * — nor leave the module slots pointing at a dead instance. */
      const step = (label: string, fn: () => void) => {
        try {
          fn()
        } catch (error) {
          api.diagnostics.warn('peer.teardown-step-failed', {
            label,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      step('service-host', () => unbindServiceHost?.dispose())
      step('devices-model', () => myModel?.dispose())
      if (model === myModel) model = null
      if (port === myPort) port = null
    }
    api.onCleanup(stop)
    signal.addEventListener('abort', stop, { once: true })

    myPort = hasTauri() ? createPeerPort(tauriWire()) : null
    port = myPort
    myModel = createDevicesModel({ port: myPort, settings: api.settings })
    model = myModel
    void myModel.refresh()

    /* Own the SHELF side of the contribution API's `services`: when the kernel
     * serves the composed set (after every capability has started), a shelf
     * serves them over the router, a satchel serves nothing. This is what
     * makes a declared service actually reachable — not each capability
     * serving its own subset. The callback awaits, so teardown is re-checked
     * after every await: a serve that resolves past `stop` is unserved on
     * the spot rather than leaking listeners into an ended lifetime. */
    const NOTHING_SERVED = { dispose: () => {} }
    const held = myPort
    unbindServiceHost = api.services.bindServiceHost(async (services) => {
      if (!held || stopped) return NOTHING_SERVED
      const role = await held.localRole().catch((error: unknown) => {
        /* Serving nothing is the safe side, but a role that could not be
         * read means this shelf's services silently never serve — a fact
         * for the log, not a silent guess. */
        api.diagnostics.warn('peer.role-unknown', { message: error instanceof Error ? error.message : String(error) })
        return 'satchel' as const
      })
      if (stopped || role !== 'shelf' || services.length === 0) return NOTHING_SERVED
      const unserve = await held.serve(services)
      if (stopped) {
        unserve()
        return NOTHING_SERVED
      }
      return { dispose: () => unserve() }
    })

    api.diagnostics.info('peer.started', { available: myPort !== null })
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
export { ServiceCallError, serviceError } from './lib/envelope'
export type { ServiceError } from './lib/envelope'

/* The in-memory wire pair, re-exported so a DEPENDENT capability's tests can
 * run the real protocol over it without reaching past this index (the
 * boundary rules allow another capability only this file). Excluded from
 * coverage as a testkit; a few hundred bytes in the bundle is the price of
 * the boundary staying whole. */
export { fakeBlobHash, fakeWire, linkWires, linkedWires } from './lib/fakeWire.testkit'
export type { FakeWire, FakeWireOptions } from './lib/fakeWire.testkit'

import { createElement } from 'react'
import type { Capability, Disposable, KernelApi } from '../../kernel'
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

  start(api: KernelApi, signal: AbortSignal): Disposable {
    port = hasTauri() ? createPeerPort(tauriWire()) : null
    model = createDevicesModel({ port, settings: api.settings })
    void model.refresh()
    api.diagnostics.info('peer.started', { available: port !== null })
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      model?.dispose()
      model = null
      port = null
      signal.removeEventListener('abort', stop)
    }
    signal.addEventListener('abort', stop, { once: true })
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

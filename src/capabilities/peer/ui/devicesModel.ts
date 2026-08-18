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
  dispose(): void
}

/** The QR as an inline image source — the SVG the plugin rendered, encoded. */
export function qrDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
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

  const refresh = async (): Promise<void> => {
    if (!port) return
    try {
      const [status, peers] = await Promise.all([port.status(), port.listPeers()])
      publish({ role: status.role, endpointId: status.endpointId, peers, error: null })
    } catch (thrown) {
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
      if (!port) return
      try {
        publish({ offer: await port.pairBegin(name), lastResult: null, error: null })
      } catch (thrown) {
        publish({ error: said(thrown) })
      }
    },
    cancelPairing: async () => {
      if (!port) return
      await port.pairCancel().catch(() => {})
      publish({ offer: null, pending: null, sas: null })
    },
    confirmPairing: async (accept) => {
      if (!port) return
      try {
        await port.pairConfirm(accept, accept ? OWN_DEVICE_GRANTS : undefined)
        publish({ pending: null, offer: null, error: null })
        await refresh()
      } catch (thrown) {
        publish({ error: said(thrown) })
      }
    },
    pairWithCode: async (uri) => {
      if (!port) return
      try {
        const start = await port.pairFromUri(uri.trim(), undefined, OWN_DEVICE_GRANTS)
        publish({ sas: start.sas, lastResult: null, error: null })
      } catch (thrown) {
        publish({ error: said(thrown) })
      }
    },
    forget: async (id) => {
      if (!port) return
      try {
        await port.forgetPeer(id)
        await refresh()
      } catch (thrown) {
        publish({ error: said(thrown) })
      }
    },
    setLocalOnly: (on) => {
      settings.set(LOCAL_ONLY_SETTING, on)
      publish({ localOnly: on })
    },
    dispose: () => {
      for (const off of offs.splice(0)) off()
      listeners.clear()
    },
  }
}

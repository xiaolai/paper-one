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

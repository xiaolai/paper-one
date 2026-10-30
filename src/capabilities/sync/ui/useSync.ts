import { useSyncExternalStore } from 'react'
import { syncNow, syncStatus } from '../lib/runtime'
import type { SyncStatus } from '../lib/status'

/**
 * The sync status, as a hook (WI-C.4) — an adapter over the status store,
 * exactly the shape the kernel's own hooks take over kernel stores. The
 * TRIGGER logic lives in `lib/scheduler.ts` (tested with fake timers, no
 * React); the degraded state — "Paper on Study iMac isn’t reachable", or
 * which book was refused and why — is a value of the store, set by the
 * session runner in `index.ts` through `lib/status.ts`'s sentences.
 */
export function useSync(): { readonly status: SyncStatus; readonly syncNow: () => void } {
  const status = useSyncExternalStore(syncStatus.subscribe, syncStatus.getSnapshot)
  return { status, syncNow }
}

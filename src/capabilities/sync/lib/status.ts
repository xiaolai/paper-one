/**
 * The sync STATUS store — one snapshot, `getSnapshot`/`subscribe`, no React
 * (WI-C.4). The scheduler writes it; `useSync` and the Storage section read
 * it. `degraded` is the honest state for "the shelf did not answer": the
 * satchel keeps working from what it has and the UI says why.
 */

export type SyncState = 'idle' | 'syncing' | 'ok' | 'degraded'

export interface SyncStatus {
  readonly state: SyncState
  /** What to tell the reader when degraded — e.g. "Paper on your Mac isn't reachable". */
  readonly detail: string | null
  readonly lastSyncAt: number | null
  /** The last session's movement, for the Storage section's line. */
  readonly lastSummary: { readonly pushed: number; readonly pulledRows: number } | null
}

export interface SyncStatusStore {
  getSnapshot(): SyncStatus
  subscribe(listener: () => void): () => void
  set(next: Partial<SyncStatus>): void
}

export const DEGRADED_DETAIL = "Paper on your Mac isn't reachable"

export function createSyncStatus(): SyncStatusStore {
  let snapshot: SyncStatus = { state: 'idle', detail: null, lastSyncAt: null, lastSummary: null }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

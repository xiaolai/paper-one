import { createSyncStatus, type SyncStatusStore } from './status'
import type { SyncScheduler } from './scheduler'
import type { SyncRole } from './protocol'

/**
 * The capability's RUNTIME SLOTS — what `start()` builds and the static
 * surfaces (the Capability object's `services`, `bookActions`, the panes,
 * `useSync`) reach for. Static, because a `Capability` is a value the
 * registry validates before anything runs; alive, because the journal, the
 * ledger and the scheduler exist only once `start()` has the kernel in its
 * hands. The status store exists from module load so a subscriber never
 * needs a null branch.
 */

export const syncStatus: SyncStatusStore = createSyncStatus()

let scheduler: SyncScheduler | null = null
let role: SyncRole | null = null

export function bindScheduler(next: SyncScheduler | null): void {
  scheduler = next
}

export function syncNow(): void {
  scheduler?.syncNow()
}

export function bindRole(next: SyncRole | null): void {
  role = next
}

export function currentRole(): SyncRole | null {
  return role
}

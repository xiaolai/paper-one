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
let roleOwner: object | null = null

export function bindScheduler(next: SyncScheduler | null): void {
  scheduler = next
}

/** Unbind ONLY when `own` is still the bound scheduler — an older stop
 *  firing after a restart must not strip the newer start's binding. */
export function unbindScheduler(own: SyncScheduler): void {
  if (scheduler === own) scheduler = null
}

export function syncNow(): void {
  scheduler?.syncNow()
}

/** Bind the role and take OWNERSHIP: the returned token is what `unbindRole`
 *  demands, so an older lifetime's stop cannot strip a newer binding of the
 *  same role value (roles are plain strings — value identity is not
 *  ownership). */
export function bindRole(next: SyncRole | null): object {
  role = next
  const token = {}
  roleOwner = token
  return token
}

export function unbindRole(own: object): void {
  if (roleOwner === own) {
    role = null
    roleOwner = null
  }
}

export function currentRole(): SyncRole | null {
  return role
}

import { useMemo, useSyncExternalStore } from 'react'
import type { Lookups } from '../../core/lookupStore'
import type { Lookup } from '../../core/lookups'

/**
 * The lookup history, bound to React — an ADAPTER over `core/lookupStore`, in
 * `useCards`' shape and for its reasons.
 *
 * READ AND REMOVE, AND NOTHING ELSE. Recording is not a verb here: a lookup is
 * filed by `useLookUp` when a definition arrives, and a surface that could file
 * one by hand would be a second route into the history with none of the
 * guarantees about what a record holds.
 */
export interface LookupsView {
  readonly all: readonly Lookup[]
  /** `CardsView.persistent`'s meaning — a history that is not being saved says so. */
  readonly persistent: boolean
  readonly remove: (term: string) => void
}

export function useLookups(store: Lookups): LookupsView {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  /* LET GO, like `useCards`' verbs: a refused write is what `persistent`
     reports, and an unhandled rejection is what must not happen. */
  const remove = useMemo(() => (term: string) => void store.remove(term).catch(() => {}), [store])
  return useMemo(
    () => ({ all: snapshot.all, persistent: snapshot.persistent, remove }),
    [snapshot.all, snapshot.persistent, remove],
  )
}

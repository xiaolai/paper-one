import { useCallback, useMemo } from 'react'
import {
  COLLECTIONS_STORAGE_KEY,
  addCollection,
  collectionIdFor,
  parseCollections,
  removeCollection,
  type Collection,
} from './collections'
import type { Scope } from './library'
import { localStore, useStoredCollection, writeJson } from './useStoredCollection'

/**
 * The reader's saved scopes.
 *
 * Its own store rather than a field on the library, because a collection is not
 * a fact about any one book — it is a restriction over all of them. Folding it
 * into `library.json` would mean rewriting every row to rename a shelf.
 */
export interface Collections {
  readonly all: readonly Collection[]
  /** Save the current scope. A duplicate PREDICATE is refused, not the label. */
  save: (scope: Scope) => void
  remove: (id: string) => void
}

export function useCollections(storage = localStore()): Collections {
  const { items: all, apply } = useStoredCollection<Collection>({
    storage,
    load: (target) => {
      try {
        return parseCollections(target.getItem(COLLECTIONS_STORAGE_KEY))
      } catch {
        return []
      }
    },
    save: (target, next) => writeJson(target, COLLECTIONS_STORAGE_KEY, next),
  })

  const save = useCallback(
    (scope: Scope) => {
      // Derived, and derived in `collections.ts` so the claim it makes — same
      // scope, same id, any machine — is somewhere it can be tested.
      apply((prev) => [...addCollection(prev, scope, collectionIdFor(scope))])
    },
    [apply],
  )

  const remove = useCallback(
    (id: string) => apply((prev) => [...removeCollection(prev, id)]),
    [apply],
  )

  return useMemo(() => ({ all, save, remove }), [all, save, remove])
}

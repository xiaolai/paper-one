import { useCallback, useMemo } from 'react'
import {
  COLLECTIONS_STORAGE_KEY,
  addCollection,
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
      /* The id is derived from the predicate rather than drawn at random, for
       * the reason every other id in this project is derived: it makes the same
       * scope produce the same collection on any machine, which is what lets
       * these ever be replicated between devices without colliding. */
      const id = `c:${scope.series ? `s/${scope.series}` : `t/${scope.tag ?? ''}`}`
      apply((prev) => [...addCollection(prev, scope, id)])
    },
    [apply],
  )

  const remove = useCallback(
    (id: string) => apply((prev) => [...removeCollection(prev, id)]),
    [apply],
  )

  return useMemo(() => ({ all, save, remove }), [all, save, remove])
}

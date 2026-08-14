import { useCallback, useMemo } from 'react'
import {
  LIBRARY_STORAGE_KEY,
  byRecency,
  parseLibrary,
  recordOpen,
  type LibraryEntry,
} from './library'
import { localStore, useStoredCollection, writeJson } from './useStoredCollection'

/**
 * The library, bound to React.
 *
 * Same shape as `useMarks` deliberately — one persistence idiom in the app, not
 * two. Mutations compose from a ref rather than from the value closed over at
 * render, so two opens in one tick both survive, and the write happens outside
 * the state updater because React may invoke an updater twice in StrictMode.
 */

export interface Library {
  readonly books: readonly LibraryEntry[]
  record: (entry: LibraryEntry) => void
}

export function useLibrary(storage = localStore()): Library {
  /* The same plumbing as marks and cards — see `useStoredCollection`. The one
   * difference that matters is deliberate and stays here: a failed write is not
   * surfaced. Losing a mark loses the reader's own words; losing a row here
   * only means the switcher forgets a title, and a persistence warning over
   * the recency list would be noise. */
  const { items: books, apply } = useStoredCollection<LibraryEntry>({
    storage,
    load: (target) => {
      try {
        return byRecency(parseLibrary(target.getItem(LIBRARY_STORAGE_KEY)))
      } catch {
        return []
      }
    },
    save: (target, next) => writeJson(target, LIBRARY_STORAGE_KEY, next),
  })

  const record = useCallback(
    (entry: LibraryEntry) => apply((prev) => recordOpen(prev, entry)),
    [apply],
  )

  /* `forget` was published here and nothing called it: there is no affordance
   * anywhere for removing a book from the shelf, so this was an API waiting for
   * a button. It comes back with the button, tested against what that button
   * actually needs rather than against what seemed likely in advance. */
  return useMemo<Library>(() => ({ books, record }), [books, record])
}

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  LIBRARY_STORAGE_KEY,
  byRecency,
  forgetBook,
  parseLibrary,
  recordOpen,
  type LibraryEntry,
} from './library'
import type { MarkStorage } from './marks'

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
  forget: (bookId: string) => void
}

function defaultStorage(): MarkStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useLibrary(storage = defaultStorage()): Library {
  const [books, setBooks] = useState<readonly LibraryEntry[]>(() => {
    if (!storage) return []
    try {
      return byRecency(parseLibrary(storage.getItem(LIBRARY_STORAGE_KEY)))
    } catch {
      return []
    }
  })

  const latest = useRef<readonly LibraryEntry[]>(books)
  const storageRef = useRef(storage)
  storageRef.current = storage

  const apply = useCallback((mutate: (prev: readonly LibraryEntry[]) => LibraryEntry[]) => {
    const next = mutate(latest.current)
    latest.current = next
    setBooks(next)
    try {
      storageRef.current?.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // A full or disabled storage costs the recency list, nothing more. Marks
      // surface their write failures because losing one loses the reader's own
      // words; losing a row here only means the switcher forgets a title.
    }
  }, [])

  const record = useCallback(
    (entry: LibraryEntry) => apply((prev) => recordOpen(prev, entry)),
    [apply],
  )

  const forget = useCallback(
    (bookId: string) => apply((prev) => forgetBook(prev, bookId)),
    [apply],
  )

  return useMemo<Library>(() => ({ books, record, forget }), [books, record, forget])
}

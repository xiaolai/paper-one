import { useCallback, useRef, useState } from 'react'
import type { MarkStorage } from './marks'

/**
 * A collection kept in local storage — the shape all three stores share.
 *
 * Marks, cards and the library were three copies of this hook with different
 * type parameters written out by hand, each with its own comment explaining the
 * same two decisions. Copies of a decision do not stay copies: the three had
 * already diverged on what happens when a write fails, so identical-looking
 * code gave the reader a persistence warning for marks and silence for cards.
 *
 * The two decisions, stated once:
 *
 *   The ref is the authority between renders. Every mutation composes from
 *   `latest`, not from the value closed over at render time, so two mutations
 *   in one tick both survive — the second would otherwise be computed from a
 *   collection that predates the first and silently drop it.
 *
 *   The write happens in the mutation, not in a state updater. React may invoke
 *   an updater twice in StrictMode; a write placed inside one runs twice and
 *   stops being a pure function of state.
 *
 * What each store still owns: how its rows are parsed, how they are serialised,
 * and what its mutations mean. Only the plumbing is here.
 */
export interface StoredCollection<T> {
  readonly items: readonly T[]
  /**
   * False once a write has failed, true again once one succeeds.
   *
   * Not latched. Each write persists the WHOLE collection, so a success after a
   * failure is a complete repair — there is nothing partial left behind, and a
   * reader told their work is not being saved while it is has no way to find
   * out otherwise.
   */
  readonly persistent: boolean
  /** Mutate, publish and persist, in that order. */
  apply: (mutate: (prev: readonly T[]) => readonly T[]) => void
}

export interface StoredCollectionOptions<T> {
  storage: MarkStorage | null
  /** Read the collection at mount. Called once, lazily. */
  load: (storage: MarkStorage) => readonly T[]
  /** Write the whole collection. Returns false if it could not be saved. */
  save: (storage: MarkStorage, items: readonly T[]) => boolean
}

export function useStoredCollection<T>({
  storage,
  load,
  save,
}: StoredCollectionOptions<T>): StoredCollection<T> {
  /* Loaded once, lazily. Reading storage on every render would re-parse the
   * whole collection for nothing, and reading it in an effect would render one
   * frame with no rows — long enough for a margin column to appear and then
   * collapse again on a book that has marks. */
  const [items, setItems] = useState<readonly T[]>(() => (storage ? load(storage) : []))
  const [persistent, setPersistent] = useState(true)

  const latest = useRef<readonly T[]>(items)
  /* The functions through refs as well: a caller that passes an inline arrow —
   * which all three do — would otherwise rebuild `apply` on every render, and
   * `apply` is a dependency of every action the stores publish. */
  const storageRef = useRef(storage)
  storageRef.current = storage
  const saveRef = useRef(save)
  saveRef.current = save

  const apply = useCallback((mutate: (prev: readonly T[]) => readonly T[]) => {
    const next = mutate(latest.current)
    latest.current = next
    setItems(next)

    const target = storageRef.current
    setPersistent(target !== null && saveRef.current(target, next))
  }, [])

  return { items, persistent, apply }
}

/** The window's storage, or null where it is disabled by policy. */
export function localStore(): MarkStorage | null {
  try {
    return window.localStorage
  } catch {
    // Throws outright when storage is disabled, rather than returning null.
    return null
  }
}

/** Serialise to JSON under one key, reporting whether it landed. */
export function writeJson(storage: MarkStorage, key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    // Quota, private browsing, a disabled store. The caller tells the reader.
    return false
  }
}

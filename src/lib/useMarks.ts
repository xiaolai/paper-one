import { useCallback, useMemo, useRef, useState } from 'react'
import {
  createMark,
  loadMarks,
  marksForBook,
  removeMark as removeFrom,
  saveMarks,
  updateNote as updateNoteIn,
  upsertMark,
  type Mark,
  type MarkStorage,
  type NewMark,
} from './marks'

/**
 * The annotation store, bound to React.
 *
 * All the rules live in `marks.ts`; this holds the state, persists after every
 * change, and narrows the whole collection to the open book. Writing on every
 * change rather than on an interval or on unload is deliberate: a reader who
 * highlights a line and then force-quits should still have the highlight, and
 * the payload is small enough that debouncing would buy nothing.
 */

export interface MarkStore {
  /** Every mark, across every book — what the Notes panel browses. */
  readonly all: readonly Mark[]
  /** The open book's marks, in book order. */
  readonly current: readonly Mark[]
  /**
   * False once a write has failed. Surfaced rather than swallowed so the
   * reader can be told their marks are not being saved; a store that silently
   * stops persisting is indistinguishable from one that works.
   */
  readonly persistent: boolean
  add: (draft: NewMark) => Mark
  remove: (id: string) => void
  setNote: (id: string, note: string) => void
}

function defaultStorage(): MarkStorage | null {
  try {
    return window.localStorage
  } catch {
    // Throws outright when storage is disabled by policy.
    return null
  }
}

export function useMarks(bookId: string | null, storage = defaultStorage()): MarkStore {
  /* Loaded once, lazily. Reading storage on every render would re-parse the
   * whole collection for nothing, and reading it in an effect would render one
   * frame with no marks — long enough for the margin column to appear and then
   * collapse again on a book that has them. */
  const [marks, setMarks] = useState<readonly Mark[]>(() =>
    storage ? loadMarks(storage) : [],
  )
  const [persistent, setPersistent] = useState(true)

  /**
   * The authoritative collection between renders.
   *
   * Every mutation composes from this rather than from the `marks` closed over
   * at render time, so two marks made in the same tick both survive — the
   * second would otherwise be computed from a `marks` that predates the first
   * and silently drop it.
   *
   * A state updater cannot do this job instead: persisting belongs to the
   * mutation, and React may invoke an updater twice in StrictMode, so a write
   * placed inside one runs twice and stops being a pure function of state.
   */
  const latest = useRef<readonly Mark[]>(marks)
  const storageRef = useRef(storage)
  storageRef.current = storage

  const apply = useCallback((mutate: (prev: readonly Mark[]) => readonly Mark[]) => {
    const next = mutate(latest.current)
    latest.current = next
    setMarks(next)

    const target = storageRef.current
    // Never latch back to true: once a write has failed, what is on disk is
    // already behind, and a later success does not recover what was lost.
    if (!target || !saveMarks(target, next)) setPersistent(false)
  }, [])

  const add = useCallback(
    (draft: NewMark) => {
      const mark = createMark(draft)
      apply((prev) => upsertMark(prev, mark))
      return mark
    },
    [apply],
  )

  const remove = useCallback(
    (id: string) => apply((prev) => removeFrom(prev, id)),
    [apply],
  )

  const setNote = useCallback(
    (id: string, note: string) => apply((prev) => updateNoteIn(prev, id, note)),
    [apply],
  )

  const current = useMemo(() => marksForBook(marks, bookId), [marks, bookId])

  return useMemo<MarkStore>(
    () => ({ all: marks, current, persistent, add, remove, setNote }),
    [marks, current, persistent, add, remove, setNote],
  )
}

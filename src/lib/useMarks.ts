import { useCallback, useMemo } from 'react'
import { rekeyBook } from './idMigration'
import { upsertOverlapping } from './markMatch'
import {
  createMark,
  loadMarks,
  marksForBook,
  removeMark as removeFrom,
  saveMarks,
  updateNote as updateNoteIn,
  type Mark,
  type NewMark,
} from './marks'
import { localStore, useStoredCollection } from './useStoredCollection'

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
  /**
   * Move every row from a superseded book id onto the current one.
   *
   * A no-op unless the reader has rows written under the previous identity
   * scheme — see `idMigration`. Called on open rather than at load, because the
   * old id can only be recomputed from the file itself.
   */
  rekey: (from: string, to: string) => void
}

export function useMarks(bookId: string | null, storage = localStore()): MarkStore {
  /* The plumbing — lazy load, the between-renders ref, the write and the
   * persistence flag — is `useStoredCollection`, shared with cards and the
   * library. What is left here is what marks specifically mean. */
  const {
    items: marks,
    persistent,
    apply,
  } = useStoredCollection<Mark>({ storage, load: loadMarks, save: saveMarks })

  const add = useCallback(
    (draft: NewMark) => {
      const mark = createMark(draft)
      /* Overlapping, not byte-identical. A mark is reached by any selection
       * that covers part of it, so the row a new mark replaces is the row that
       * selection resolved to — otherwise re-marking a passage the reader was
       * just told is marked writes a second, overlapping row. */
      apply((prev) => upsertOverlapping(prev, mark))
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


  /* `apply` persists whatever the mutation returns even when nothing changed,
   * and this runs on every open — so the guard is here, reading the identity
   * `rekeyBook` returns when it found nothing to move. */
  const rekey = useCallback(
    (from: string, to: string) =>
      apply((prev) => {
        const next = rekeyBook(prev, from, to)
        return next === prev ? prev : [...next]
      }),
    [apply],
  )

  return useMemo<MarkStore>(
    () => ({ all: marks, current, persistent, add, remove, setNote, rekey }),
    [marks, current, persistent, add, remove, setNote, rekey],
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readMarks, writeMarks } from './bookFolder'
import { scanAllMarks, type IndexFs } from './bookIndex'
import { upsertOverlapping } from './markMatch'
import {
  createMark,
  parseMarks,
  removeMark as removeFrom,
  updateNote as updateNoteIn,
  type Mark,
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
  /** Every mark, across every book — what the Notes panel browses. Empty
   *  until `loadAll` has run, because it costs a read per book. */
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
  /**
   * Read every book's marks into `all`.
   *
   * Called by the Notes pane when it mounts. Marks live in book folders, so
   * answering "every book's marks" costs one read per book — paid at the moment
   * somebody asks for cross-book notes rather than at boot, where nobody did.
   */
  loadAll: () => void
}

export function useMarks(bookId: string | null, fs: IndexFs | null): MarkStore {
  /* THE OPEN BOOK'S MARKS ONLY, held here.
   *
   * They live in that book's folder, so there is nothing to load until a book is
   * open and nothing to filter once one is — `current` used to be
   * `marksForBook(everything)`, which is what a shared store forces.
   *
   * Loaded asynchronously, which is safe because marks are DRAWN after a section
   * loads: the overlay is built on the `load` event and reads the marks then, so
   * a read that resolves a few frames into the open is indistinguishable from
   * one that resolved before it. */
  const [current, setCurrent] = useState<readonly Mark[]>([])
  const [persistent, setPersistent] = useState(true)
  const [all, setAll] = useState<readonly Mark[]>([])

  const latest = useRef<readonly Mark[]>(current)
  latest.current = current

  useEffect(() => {
    if (!bookId || !fs) {
      setCurrent([])
      return
    }
    let live = true
    void readMarks(fs, bookId)
      .then((raw) => {
        // Parsed through the same validator the shared store used: this is a
        // file on disk, and a mark with no CFI cannot be drawn.
        if (live) setCurrent(parseMarks(JSON.stringify(raw)))
      })
      .catch(() => {
        if (live) setCurrent([])
      })
    return () => {
      live = false
    }
  }, [bookId, fs])

  /** Change this book's marks, then write its file. */
  const apply = useCallback(
    (mutate: (prev: readonly Mark[]) => readonly Mark[]) => {
      const next = mutate(latest.current)
      if (next === latest.current) return
      latest.current = next
      setCurrent(next)
      if (!bookId || !fs) return
      void writeMarks(fs, bookId, next)
        .then(() => setPersistent(true))
        .catch((cause: unknown) => {
          /* SURFACED, not swallowed. Losing a mark loses the reader's own words,
           * and a store that silently stops persisting is indistinguishable from
           * one that works. */
          console.error('Paper: could not save your marks', cause)
          setPersistent(false)
        })
    },
    [bookId, fs],
  )

  /**
   * Read every book's marks, for the Notes pane.
   *
   * Called by Notes when it mounts, which is the moment somebody asked for
   * cross-book notes — and Notes only mounts when its pane is open, so a reader
   * who never opens it never pays for the scan.
   */
  const loadAll = useCallback(() => {
    if (!fs) return
    void scanAllMarks(fs)
      .then((raw) => setAll(parseMarks(JSON.stringify(raw))))
      .catch(() => setAll([]))
  }, [fs])

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

  const remove = useCallback((id: string) => apply((prev) => removeFrom(prev, id)), [apply])

  const setNote = useCallback(
    (id: string, note: string) => apply((prev) => updateNoteIn(prev, id, note)),
    [apply],
  )

  /**
   * Carry marks written under a superseded book id onto this one.
   *
   * With marks in book folders this MOVES a file rather than rewriting rows: the
   * old id named a different folder, so its marks are read from there and merged
   * into this book's. A no-op unless the reader has marks under the previous
   * identity scheme — see `idMigration`.
   */
  const rekey = useCallback(
    (from: string, to: string) => {
      if (!fs || from === to) return
      void readMarks(fs, from).then((raw) => {
        const moved = parseMarks(JSON.stringify(raw))
        if (moved.length === 0) return
        apply((prev) => [...prev, ...moved.map((mark) => ({ ...mark, bookId: to }))])
      })
    },
    [fs, apply],
  )

  return useMemo<MarkStore>(
    () => ({ all, current, persistent, add, remove, setNote, rekey, loadAll }),
    [all, current, persistent, add, remove, setNote, rekey, loadAll],
  )
}

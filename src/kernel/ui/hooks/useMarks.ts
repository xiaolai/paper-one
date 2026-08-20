import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { MarkStore } from '../../core/markStore'
import { createMark, type Annotation, type Bookmark, type NewMark } from '../../core/marks'

/**
 * The annotation store, bound to React — an ADAPTER over `core/markStore`.
 *
 * The rules are in `marks.ts` and the state, the queue and the write path in
 * the service; this subscribes a component to the snapshot, tells the service
 * which book is open, and hands the verbs on with their promises let go —
 * see `useLibrary` for why a rejection is caught here rather than left.
 */

/** One shared empty list, so a book with no marks does not re-render on identity. */
const EMPTY: readonly Annotation[] = []
const NO_BOOKMARKS: readonly Bookmark[] = []

export interface MarksView {
  /** Every ANNOTATION, across every book — what the Notes panel browses. Empty
   *  until `loadAll` has run, because it costs a read per book. */
  readonly all: readonly Annotation[]
  /** The open book's ANNOTATIONS, in book order. Never a bookmark — the store
   *  splits the two at its own door, see `MarkSnapshot.bookmarks`. */
  readonly current: readonly Annotation[]
  /** The open book's BOOKMARKS, in book order. */
  readonly bookmarks: readonly Bookmark[]
  /** False once a write has failed — see `MarkSnapshot.persistent`. */
  readonly persistent: boolean
  /** Whether this book's marks have been READ — see `MarkSnapshot.ready`.
   *  Paired with the book asked for, like the two lists above. */
  readonly ready: boolean
  /**
   * Add a mark and hand it back AT ONCE, because the reader draws it before
   * the write lands: foliate only offers marks to an overlay when it builds
   * one, so without the mark in hand the highlight would not appear until
   * the reader scrolled away and back.
   */
  add: <T extends NewMark>(draft: T) => T & { id: string; createdAt: number }
  remove: (id: string) => void
  setNote: (id: string, note: string) => void
  /** Move every row from a superseded book id onto the current one — see the service. */
  rekey: (from: string, to: string) => void
  /** Read every book's marks into `all`. Called by the Notes pane when it mounts. */
  loadAll: () => void
}

const SAVE_FAILED = "Paper: could not save that book's marks"

function letGo(written: Promise<unknown>): void {
  void written.catch((cause: unknown) => {
    console.error(SAVE_FAILED, cause)
  })
}

export function useMarks(store: MarkStore, bookId: string | null): MarksView {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  /* Which book is open is the component's to say and the service's to act
   * on: the read goes on that book's queue, and a read that lands after the
   * reader has moved on is discarded by the service, not here. */
  useEffect(() => {
    void store.open(bookId)
  }, [store, bookId])

  /* PAIRED WITH THE BOOK ASKED FOR, not merely with what the service holds.
   * Between the render that names a new book and the effect that opens it,
   * the snapshot is still the previous book's — and showing those marks for a
   * frame is showing, and letting the overlay DRAW, another book's highlights.
   *
   * The bookmarks take the same pairing, and need it for the same reason one
   * step further on: the ribbon and the footer toggle both read "is THIS place
   * bookmarked", so the previous book's places would light the ribbon over the
   * opening page of the new one. */
  const current = snapshot.bookId === bookId ? snapshot.current : EMPTY
  const bookmarks = snapshot.bookId === bookId ? snapshot.bookmarks : NO_BOOKMARKS

  const verbs = useMemo(
    () => ({
      add: <T extends NewMark>(draft: T) => {
        const mark = createMark(draft)
        letGo(store.add(mark))
        return mark
      },
      remove: (id: string) => letGo(store.remove(id)),
      setNote: (id: string, note: string) => letGo(store.updateNote(id, note)),
      rekey: (from: string, to: string) => letGo(store.rekey(from, to)),
      loadAll: () => letGo(store.loadAll()),
    }),
    [store],
  )

  return useMemo<MarksView>(
    () => ({
      all: snapshot.all,
      current,
      bookmarks,
      persistent: snapshot.persistent,
      ready: snapshot.ready && snapshot.bookId === bookId,
      ...verbs,
    }),
    [snapshot.all, current, bookmarks, snapshot.persistent, snapshot.ready, snapshot.bookId, bookId, verbs],
  )
}

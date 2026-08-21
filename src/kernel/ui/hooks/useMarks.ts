import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { MarkStore } from '../../core/markStore'
import { createMark, type Annotation, type Bookmark, type Mark, type NewMark } from '../../core/marks'

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

/** Enough of a mark to act on it: which one, and whose book it is. */
export type MarkRef = Pick<Mark, 'id' | 'bookId'>

export interface MarksView {
  /** Every ANNOTATION, across every book — what the Marginalia panel browses. Empty
   *  until `loadAll` has run, because it costs a read per book. */
  readonly all: readonly Annotation[]
  /** The open book's ANNOTATIONS, in book order. Never a bookmark — the store
   *  splits the two at its own door, see `MarkSnapshot.bookmarks`. */
  readonly current: readonly Annotation[]
  /** The open book's BOOKMARKS, in book order — what the ribbon reads. */
  readonly bookmarks: readonly Bookmark[]
  /** Every book's bookmarks, beside `all`. Empty until `loadAll` has run. */
  readonly allBookmarks: readonly Bookmark[]
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
  add: <T extends NewMark>(draft: T) => Mark & Pick<T, 'kind'>
  /**
   * Remove a mark — from ITS OWN BOOK, which is not always the open one.
   *
   * THE WHOLE MARK, not its id. These used to take an id and let the store
   * work the book out, which it does well: `ownerOf` looks the id up in the
   * open book's list and then in the cross-book one. That is not wrong, and it
   * is not free either — it is a lookup standing in for a fact the caller
   * already had, and it fails in the one case where the lookup comes up empty.
   * A failed rescan sets the cross-book list to `[]` (see `loadAll`), and from
   * that moment Marginalia is still SHOWING another book's rows while the store
   * can no longer place them: the delete rejects with "no mark is known", the
   * rejection is logged and swallowed, and the row stays with nothing said.
   *
   * Passing the book beside the id would have fixed today's callers and left
   * tomorrow's to rediscover this. Taking the mark makes the omission
   * unspellable — every caller already has one in hand.
   */
  remove: (mark: MarkRef) => void
  /** Rewrite a note, in its own book — same reasoning as `remove`. */
  setNote: (mark: MarkRef, note: string) => void
  /** Move every row from a superseded book id onto the current one — see the service. */
  rekey: (from: string, to: string) => void
  /** Read every book's marks into `all`. Called by the Marginalia pane when it mounts. */
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
      remove: (mark: MarkRef) => letGo(store.remove(mark.id, mark.bookId)),
      setNote: (mark: MarkRef, note: string) => letGo(store.updateNote(mark.id, note, mark.bookId)),
      rekey: (from: string, to: string) => letGo(store.rekey(from, to)),
      loadAll: () => letGo(store.loadAll()),
    }),
    [store],
  )

  return useMemo<MarksView>(
    () => ({
      all: snapshot.all,
      allBookmarks: snapshot.allBookmarks,
      current,
      bookmarks,
      persistent: snapshot.persistent,
      ready: snapshot.ready && snapshot.bookId === bookId,
      ...verbs,
    }),
    [snapshot.all, snapshot.allBookmarks, current, bookmarks, snapshot.persistent, snapshot.ready, snapshot.bookId, bookId, verbs],
  )
}

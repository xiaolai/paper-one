import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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
  /** This book's marks file is there and would not read — see
   *  `MarkSnapshot.unreadable`. Paired with the book, like `ready`. */
  readonly unreadable: boolean
  /** Whether a `loadAll` scan is still in flight — `all` and `allBookmarks`
   *  are not yet an answer while it is. */
  readonly scanning: boolean
  /** The last cross-book scan failed — `all` is empty for that reason, not
   *  because nothing is kept. `MarkSnapshot.scanFailed`. */
  readonly scanFailed: boolean
  /**
   * Add a mark and hand it back AT ONCE, because the reader draws it before
   * the write lands: foliate only offers marks to an overlay when it builds
   * one, so without the mark in hand the highlight would not appear until
   * the reader scrolled away and back.
   */
  add: <T extends NewMark>(draft: T) => Mark & Pick<T, 'kind'>
  /**
   * Mint and write several marks for ONE book in a single store write, and
   * resolve when it has landed.
   *
   * `add` is right for the reader marking a passage — one mark, one write, the
   * promise let go because the pane reports persistence separately. An import
   * is the other case: a whole archive in one write per book, and an answer
   * about whether it worked before anything is claimed.
   */
  addMany: (bookId: string, drafts: readonly NewMark[]) => Promise<void>
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
  /**
   * Read every book's marks and RESOLVE WITH THEM — annotations and bookmarks
   * together, which is what a whole-library reader needs.
   *
   * WHY THIS EXISTS RATHER THAN `loadAll()` FOLLOWED BY READING `all`. The
   * cross-book lists are empty until a scan has run, and the ONLY caller of
   * `loadAll` is the Marginalia panel mounting. So an export from the command
   * palette, in a session where that panel was never opened, walked an empty
   * list, wrote `{"version":1,"books":[]}` and reported success — a backup that
   * exists, opens, and contains nothing. The reader does not find out until the
   * day they need it.
   *
   * Awaiting `loadAll()` and then reading the hook's `all` would not fix it
   * either: `all` is a value captured in the closure that called it, one React
   * commit behind the store. This asks the store and hands the rows straight
   * back, so there is no render in the path at all.
   */
  loadAllNow: () => Promise<readonly Mark[]>
}

const SAVE_FAILED = "Paper: could not save that book's marks"

function letGo(written: Promise<unknown>): void {
  void written.catch((cause: unknown) => {
    console.error(SAVE_FAILED, cause)
  })
}

export function useMarks(store: MarkStore, bookId: string | null): MarksView {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  /* WHETHER THE CROSS-BOOK SCAN IS STILL RUNNING. `loadAll` costs a read per
   * book and the store publishes nothing until it lands, so the panel that
   * asked drew "Nothing kept yet" over a library it had not finished reading.
   * Counted rather than flagged: two overlapping scans must not let the first
   * to finish declare the second done. */
  const [scans, setScans] = useState(0)

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
      addMany: (bookId: string, drafts: readonly NewMark[]): Promise<void> => {
        /* FAIL FAST on a draft naming another book. The store writes the batch
         * under the FIRST argument's file, so a mismatched draft would land in
         * one book's file while carrying another book's id — ownership
         * corrupted quietly, surfacing only when a later mutation routes by
         * the id inside the row. Today's one caller builds both from the same
         * plan entry; this guard is for the caller that will not. */
        const foreign = drafts.find((draft) => draft.bookId !== bookId)
        if (foreign) {
          return Promise.reject(
            new Error(`addMany for ${bookId} was handed a draft belonging to ${foreign.bookId}`),
          )
        }
        return store.addMany(bookId, drafts.map((draft) => createMark(draft)))
      },
      remove: (mark: MarkRef) => letGo(store.remove(mark.id, mark.bookId)),
      setNote: (mark: MarkRef, note: string) => letGo(store.updateNote(mark.id, note, mark.bookId)),
      rekey: (from: string, to: string) => letGo(store.rekey(from, to)),
      loadAll: () => {
        setScans((n) => n + 1)
        letGo(store.loadAll().finally(() => setScans((n) => n - 1)))
      },
      loadAllNow: async () => {
        /* ⚠️ A FAILED SCAN STILL RESOLVES. `MarkStore.loadAll` catches the
         * scan's failure, installs an empty list and resolves — so an export
         * built on this can read a read failure as an empty library and write
         * the empty backup the caller exists to prevent. Telling the two apart
         * needs the store to surface the failure (its `loadAll` contract);
         * until it does, the honest statement is here, not a claim. */
        await store.loadAll()
        const fresh = store.getSnapshot()
        /* BOTH CLASSES. They share a file and a store and are split at the
           snapshot; anything that wants the whole of what a reader left in
           their books has to put them back together. */
        return [...fresh.all, ...fresh.allBookmarks]
      },
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
      unreadable: snapshot.unreadable && snapshot.bookId === bookId,
      scanning: scans > 0,
      scanFailed: snapshot.scanFailed,
      ...verbs,
    }),
    [
      snapshot.all,
      snapshot.scanFailed,
      snapshot.allBookmarks,
      current,
      bookmarks,
      snapshot.persistent,
      snapshot.ready,
      snapshot.unreadable,
      snapshot.bookId,
      bookId,
      scans,
      verbs,
    ],
  )
}

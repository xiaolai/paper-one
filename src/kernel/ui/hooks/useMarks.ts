import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { MarkStore } from '../../core/markStore'
import type { ResolvedCfi } from '../../core/resolvedCfi'
import {
  createMark,
  type Annotation,
  type Bookmark,
  type Mark,
  type NewMark,
  type Placed,
} from '../../core/marks'

/**
 * The annotation store, bound to React — an ADAPTER over `core/markStore`.
 *
 * The rules are in `marks.ts` and the state, the queue and the write path in
 * the service; this subscribes a component to the snapshot, tells the service
 * which book is open, and hands the verbs on with their promises let go —
 * see `useLibrary` for why a rejection is caught here rather than left. The
 * one exception hands the promise back as well: `setNote`, for an editor that
 * still holds the text and can try again (#131).
 */

/** One shared empty list, so a book with no marks does not re-render on identity. */
const EMPTY: readonly Placed<Annotation>[] = []
const NO_BOOKMARKS: readonly Bookmark[] = []
const NO_UNSAVED: ReadonlyMap<string, string> = new Map()

/** Enough of a mark to act on it: which one, and whose book it is. */
export type MarkRef = Pick<Mark, 'id' | 'bookId'>

export interface MarksView {
  /** Every ANNOTATION, across every book — what the Marginalia panel browses. Empty
   *  until `loadAll` has run, because it costs a read per book. */
  readonly all: readonly Annotation[]
  /** The open book's ANNOTATIONS, in book order. Never a bookmark — the store
   *  splits the two at its own door, see `MarkSnapshot.bookmarks`. And never
   *  an unplaced one, which WI-22.A1 makes a fact about the TYPE rather than
   *  a promise in this comment — see `MarkSnapshot.current`. */
  readonly current: readonly Placed<Annotation>[]
  /** The open book's BOOKMARKS, in book order — what the ribbon reads. */
  readonly bookmarks: readonly Bookmark[]
  /** Every book's bookmarks, beside `all`. Empty until `loadAll` has run. */
  readonly allBookmarks: readonly Bookmark[]
  /** The open book's annotations with NO ANCHOR HERE — see
   *  `MarkSnapshot.unplaced`. Never in `current`, so nothing paints one. */
  readonly unplaced: readonly Annotation[]
  /** Every book's unplaced annotations, beside `all`. Empty until `loadAll`. */
  readonly allUnplaced: readonly Annotation[]
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
  /**
   * Rewrite a note, in its own book — same reasoning as `remove` — and SAY
   * WHETHER IT LANDED.
   *
   * ⚠️ **THE ONE VERB HERE WHOSE CALLER HAS SOMETHING TO RETRY WITH.** Every
   * other verb's promise is let go, because the pane reports persistence
   * separately and there is nothing a caller could do with the answer. A note
   * is different: the editor is still holding the text, and it used to move its
   * "already stored" marker forward the moment it handed the note over — so a
   * write that failed was indistinguishable from one that landed, every later
   * save found the draft unchanged and wrote nothing, and closing the editor
   * took the last chance to try again (#131).
   *
   * The rejection is still LOGGED here and the store still drops `persistent`,
   * so a caller that ignores this promise is exactly as safe as before.
   */
  setNote: (mark: MarkRef, note: string) => Promise<void>
  /**
   * The text of each note whose NEWEST write was refused, by mark id — what the
   * store does not have, and what no editor may be left holding.
   *
   * ⚠️ **THE EDITOR WAS THE ONLY COPY, AND CLOSING THE PANE UNMOUNTS IT**
   * (2026-09-14, #131, round 4). A refusal arriving after that had nothing to
   * retry with, and the reader's words were gone — and for the open book the
   * row went on SHOWING them, because the store draws a note before its write
   * lands and does not take it back. Held here because this hook lives as long
   * as the window and the pane does not; `Marginalia` offers it on the row
   * again. A later write of the same mark decides afresh: landing clears it.
   */
  readonly unsaved: ReadonlyMap<string, string>
  /**
   * Give an UNPLACED mark the anchor a re-anchoring pass found — WI-22.A2.
   *
   * The book is named rather than looked up, for `remove`'s reason: the caller
   * is `useReanchor`, which walked ONE book and has its id in hand. A pass that
   * let the store work it out would fail in exactly the case the lookup comes
   * up empty — a cross-book scan that failed — and the mark would stay unplaced
   * with the rejection logged and swallowed.
   */
  place: (id: string, cfi: ResolvedCfi, sectionIndex: number, bookId: string) => void
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
  /* WHETHER THE CROSS-BOOK SCAN IS STILL RUNNING. `loadAll` costs a read per
   * book and the store publishes nothing until it lands, so the panel that
   * asked drew "Nothing kept yet" over a library it had not finished reading.
   * Counted rather than flagged: two overlapping scans must not let the first
   * to finish declare the second done. */
  const [scans, setScans] = useState(0)
  const [unsaved, setUnsaved] = useState(NO_UNSAVED)
  /* WHICH NOTE WRITE OF EACH MARK IS THE NEWEST. Only its answer decides what
   * `unsaved` holds: a refusal arriving behind a later write of the same mark
   * must not put back text the reader has already written past. */
  const noteWrites = useRef({ count: 0, newest: new Map<string, number>() })

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
  const unplaced = snapshot.bookId === bookId ? snapshot.unplaced : EMPTY

  const verbs = useMemo(
    () => ({
      add: <T extends NewMark>(draft: T) => {
        const mark = createMark(draft)
        letGo(store.add(mark))
        return mark
      },
      remove: (mark: MarkRef) => letGo(store.remove(mark.id, mark.bookId)),
      setNote: (mark: MarkRef, note: string): Promise<void> => {
        const written = store.updateNote(mark.id, note, mark.bookId)
        /* LOGGED AND HANDED BACK. `letGo` attaches its own handler, so a caller
           that ignores this cannot produce an unhandled rejection — and one
           that awaits it learns whether the note is on disk. See `setNote`. */
        letGo(written)
        const writes = noteWrites.current
        // Stryker disable next-line AssignmentOperator: counting down mints a different number for every write just as counting up does, and the count is only ever compared for equality with a mark's newest.
        writes.count += 1
        const mine = writes.count
        writes.newest.set(mark.id, mine)
        const answered = (refused: boolean): void => {
          if (writes.newest.get(mark.id) !== mine) return
          setUnsaved((held) => {
            if (refused) return new Map(held).set(mark.id, note)
            /* THE SAME MAP when there was nothing to let go, so a note landing
               does not re-render everything that reads this view. */
            if (!held.has(mark.id)) return held
            const next = new Map(held)
            next.delete(mark.id)
            return next
          })
        }
        void written.then(
          () => answered(false),
          () => answered(true),
        )
        return written
      },
      place: (id: string, cfi: ResolvedCfi, sectionIndex: number, forBook: string) =>
        letGo(store.place(id, cfi, sectionIndex, forBook)),
      rekey: (from: string, to: string) => letGo(store.rekey(from, to)),
      loadAll: () => {
        setScans((n) => n + 1)
        letGo(store.loadAll().finally(() => setScans((n) => n - 1)))
      },
    }),
    [store],
  )

  return useMemo<MarksView>(
    () => ({
      all: snapshot.all,
      allBookmarks: snapshot.allBookmarks,
      allUnplaced: snapshot.allUnplaced,
      current,
      bookmarks,
      unplaced,
      persistent: snapshot.persistent,
      ready: snapshot.ready && snapshot.bookId === bookId,
      unreadable: snapshot.unreadable && snapshot.bookId === bookId,
      scanning: scans > 0,
      scanFailed: snapshot.scanFailed,
      unsaved,
      ...verbs,
    }),
    [
      unsaved,
      snapshot.all,
      snapshot.scanFailed,
      snapshot.allBookmarks,
      snapshot.allUnplaced,
      current,
      bookmarks,
      unplaced,
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

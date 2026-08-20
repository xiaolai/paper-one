import { useCallback, useMemo } from 'react'
import { findMark } from '../../core/markMatch'
import { bookmarkFrom, type Bookmark } from '../../core/marks'
import type { Book } from './useBook'
import type { MarksView } from './useMarks'

/**
 * Putting a bookmark in the book, and taking it out again.
 *
 * The counterpart to `useMarking`, and the difference between the two is the
 * whole shape of this file: marking acts on a SELECTION — a passage the reader
 * pointed at — and bookmarking acts on a PLACE, which is wherever the reader
 * happens to be. Nothing has to be selected, nothing is drawn into the text,
 * and the same gesture puts one in and takes it out.
 *
 * Lifted out of the reader for the same reason marking was: three callers need
 * it — the footer button, §11's ⌘B, and the command palette — and the palette
 * has to be able to ask "is there one here right now" in order to say which of
 * the two things it is offering to do.
 */

export interface Bookmarking {
  /**
   * The bookmark on the place the reader is at, or null.
   *
   * BY OVERLAP, not by an identical anchor — see `here` below for why that is
   * the only rule that works here.
   */
  readonly here: Bookmark | null
  /**
   * Whether a bookmark can be put here at all.
   *
   * False before the renderer has reported a position, for a place whose
   * section cannot be told, and — the one that is easy to miss — until this
   * book's marks have actually been READ. Read by every control that offers
   * the action, so none of them is a button that does nothing: the same rule
   * ⌘D follows for a selection that is not there.
   *
   * THE READ MATTERS BECAUSE THE TOGGLE IS A TOGGLE. Before the file arrives,
   * `all` is empty and `here` is therefore null — so a page the reader
   * bookmarked yesterday reads as unbookmarked, and pressing ⌘B on it PLACES
   * one instead of removing it. The write path recovers (the store reads the
   * file before it writes, and `upsertOverlapping` supersedes the old row
   * rather than duplicating it), so nothing is corrupted; but the reader
   * pressed a control labelled "Remove this bookmark" and the bookmark stayed.
   */
  readonly canBookmark: boolean
  /** Put a bookmark here, or take off the one that is here. */
  toggle: () => void
  /**
   * Take one off — from any book, routed by id through the store.
   *
   * The one verb here that is not about "here". Marginalia lists every book's
   * places and its rows have to be removable; the list itself, the persistence
   * warning and the navigation all belong to that panel, which reads them from
   * `MarksView` directly. This hook kept copies of all three while it also fed
   * a panel of its own, and they went dead with it.
   */
  remove: (bookmark: Bookmark) => void
}

export function useBookmarking(book: Book, marks: MarksView): Bookmarking {
  const { bookId, position, placeHere } = book
  const { cfi, sectionIndex } = position
  const all = marks.bookmarks

  /**
   * The bookmark the reader is standing on.
   *
   * BY OVERLAP — `findMark` — and not by comparing the current CFI with the
   * stored one, which is the obvious implementation and is wrong in both
   * directions.
   *
   * It is wrong in scrolled flow because the position moves continuously: a
   * bookmark put down and then scrolled past by one line no longer matches its
   * own anchor, so the ribbon goes out while the bookmark is still on screen,
   * and pressing the key again makes a SECOND bookmark a line below the first.
   *
   * It is wrong across a reopen because the CFI a relocation reports is
   * generated from the layout the reader currently has. A book reopened at
   * another type size, or in another window, lands on the same words with a
   * different anchor.
   *
   * Overlap answers the question actually being asked — is one of my bookmarks
   * on this page — and it is the same rule, and the same function, that decides
   * whether a selection is on an existing highlight. Where the relocation
   * reports a RANGE spanning the visible page, this is exactly "a bookmark
   * anywhere on screen"; where it reports a single point, it degrades to the
   * point comparison, which is what the naive version would have done anyway.
   */
  const here = useMemo(
    () =>
      cfi && sectionIndex !== null && bookId
        ? findMark(all, { cfi, sectionIndex, bookId })
        : null,
    [all, cfi, sectionIndex, bookId],
  )

  const canBookmark = cfi !== null && sectionIndex !== null && bookId !== null && marks.ready

  const toggle = useCallback(() => {
    if (!bookId) return
    /* Taking one off comes first, and does not consult the renderer at all.
     * The reader can see the ribbon, so the bookmark is there to be removed
     * whatever `placeHere` would say about the current moment — and asking
     * would make the remove fail exactly when a section is mid-render, which
     * is the one time the reader is most likely to press the key twice. */
    if (here) {
      marks.remove(here.id)
      return
    }
    /* TAKEN WHOLE FROM THE SESSION, anchor included — this hook's `cfi` is a
     * React commit behind the renderer's, and pairing the two produced a
     * bookmark whose anchor and whose section described different pages. See
     * `ReaderSession.placeHere`. */
    const place = placeHere()
    if (!place) return
    marks.add(
      bookmarkFrom({
        bookId,
        cfi: place.cfi,
        sectionIndex: place.sectionIndex,
        text: place.text,
        prefix: place.prefix,
        suffix: place.suffix,
        /* FROM THE PLACE, not from this hook's own `position.chapterLabel`.
         * Recorded at creation exactly as a mark records its chapter — the list
         * shows it, and re-deriving it later means resolving a CFI in a book
         * that may not be open — but taken from the same relocation as the
         * anchor, so the two cannot describe different chapters. */
        chapter: place.chapter,
      }),
    )
  }, [bookId, here, marks, placeHere])

  const remove = useCallback((bookmark: Bookmark) => marks.remove(bookmark.id), [marks])

  return useMemo<Bookmarking>(
    () => ({ here, canBookmark, toggle, remove }),
    [here, canBookmark, toggle, remove],
  )
}

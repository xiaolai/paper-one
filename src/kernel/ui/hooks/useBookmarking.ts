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
  const { cfi, sectionIndex, sectionExact } = position
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

  /*
   * TWO DIFFERENT QUESTIONS, and collapsing them into one took a feature away.
   *
   * MAKING one needs a section that is KNOWN rather than guessed — the bar
   * `placeHere` holds a bookmark to. Without that agreement the two surfaces
   * disagreed on exactly the books where the distinction exists: a fixed-layout
   * spread publishes a section from whichever page rendered last, so the footer
   * button offered itself, ⌘B was live, and pressing either did nothing,
   * because the session then refused to hand over a place.
   *
   * REMOVING one needs only that a bookmark is standing here. It already
   * exists; its section was settled when it was made, and nothing about the
   * renderer's present confidence changes that. Requiring `sectionExact` for
   * both is the same collapse in the other direction — it hid the button, and
   * ⌘B with it, over a ribbon the reader could see and now had no way to take
   * off. A control that cannot undo what it just did is worse than one that
   * refuses to act in the first place.
   */
  const somewhere = cfi !== null && sectionIndex !== null && bookId !== null && marks.ready
  const canBookmark = somewhere && (sectionExact || here !== null)

  const toggle = useCallback(() => {
    if (!bookId) return
    /*
     * ONE SNAPSHOT DECIDES BOTH HALVES.
     *
     * This asked `here` — a render-time value — whether to remove, and only
     * then asked the session where it was in order to create. Those two are
     * read at different moments, so between a relocation and React committing
     * it the toggle could remove the PREVIOUS page's bookmark while the reader
     * was looking at the next one. The removal branch even said it was
     * deliberate, on the grounds that the reader can see the ribbon — but the
     * ribbon is drawn from the same stale value, so that argument justified
     * acting on stale information rather than avoiding it.
     *
     * `placeHere()` is the renderer's own answer, and the bookmark to remove is
     * whichever one overlaps THAT place. `here` remains the fallback for the
     * moment the session cannot pin a place down at all: a visible ribbon must
     * stay removable even then, which is the true half of the old comment.
     */
    const place = placeHere()
    const standing = place
      ? findMark(all, { cfi: place.cfi, sectionIndex: place.sectionIndex, bookId })
      : here
    if (standing) {
      marks.remove(standing)
      return
    }
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
  }, [bookId, here, all, marks, placeHere])

  /* ITS OWN BOOK. Marginalia lists every book's bookmarks, and this is what
     its rows delete through — routed by the open book it silently did nothing
     for every row that came from elsewhere. */
  const remove = useCallback((bookmark: Bookmark) => marks.remove(bookmark), [marks])

  return useMemo<Bookmarking>(
    () => ({ here, canBookmark, toggle, remove }),
    [here, canBookmark, toggle, remove],
  )
}

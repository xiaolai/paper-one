import { useEffect, useState } from 'react'
import type { IndexFs } from '../../core/bookIndex'
import { readBook } from '../../core/bookFolder'

/** Where the open book's own record says to resume — see `useResumeAt`. */
export interface ResumeAt {
  readonly bookId: string
  readonly position: string | null
}

/**
 * Where to resume, read from the BOOK'S OWN RECORD rather than from the index.
 *
 * The index is a cache and it can be one write behind — a crash between
 * writing `book.json` and writing `index.json` leaves it so, and that is a
 * trade this project accepts because a stale cache cannot cause a stale WRITE:
 * every mutation applies to the record on disk.
 *
 * Except through here. The position it handed back was fed to the reader as
 * the place to resume, and the reader then saved it — so the one path by which
 * a stale cache could overwrite a newer record was the reading position, which
 * is the single thing a reader notices losing.
 *
 * Falls back to the row until the read lands. One small file against parsing a
 * book is not a close race, but if it were, the cached position is a better
 * answer than none.
 *
 * ⚠️ **THE ANSWER IS NEVER A PREVIOUS OPEN'S, ON ANY COMMITTED RENDER.** A
 * resume outranks the row in `locationToOpen`, and one left over from an
 * earlier open of the same book outranked a row that had moved on since — so
 * a reopen whose parse finished before its record read sent the reader to
 * where they were the time before last. Clearing it from the read's effect
 * was not enough: an effect runs AFTER the commit, and the render before it
 * had already computed `lastLocation` from the stale value and handed it to
 * the reader's ref. So each open is COUNTED — the count moves during render,
 * the moment `bookId` changes, by React's own adjust-state-while-rendering
 * rule — the value is kept with the count of the open it was read for, and
 * the answer is derived: the held value when it is this open's, `null`
 * otherwise. Until this book's record speaks, the row does; the read then
 * says what the record holds, or clears it when the record answers nothing.
 * Extracted from `App` so the timing can be pinned render by render, which
 * nothing rendered can be asked about.
 */
export function useResumeAt(bookId: string | null, fs: IndexFs | null, read: typeof readBook = readBook): ResumeAt | null {
  /* WHICH OPEN THIS IS, moved during render. Setting state while rendering
     makes React discard this render's output and run the component again
     with the new value before anything is committed — so no render that
     reaches the screen carries the count of the open before it. */
  const [open, setOpen] = useState(0)
  const [openOf, setOpenOf] = useState<string | null>(bookId)
  if (openOf !== bookId) {
    setOpenOf(bookId)
    setOpen(open + 1)
  }
  const [held, setHeld] = useState<{ readonly open: number; readonly value: ResumeAt } | null>(null)
  useEffect(() => {
    if (!bookId || !fs) return
    let live = true
    /* The open this read belongs to — what its answer is filed under, and
       the only answer it may clear. */
    const mine = open
    /* A read that answers nothing LETS THE ROW SPEAK — by clearing what an
       earlier read of THIS open left here (a filesystem change re-reads the
       same open). Another open's value is not this read's to touch; it is
       not answered either way. */
    const rowSpeaks = () => {
      if (live) setHeld((was) => (was !== null && was.open === mine ? null : was))
    }
    void read(fs, bookId)
      .then((record) => {
        /* A record that is not there, or will not read, is `null` from
           `readBook` — and a null resume here suppressed the row's cached
           position, which is the better answer. Only a record that was read
           speaks. */
        if (live && record) setHeld({ open: mine, value: { bookId, position: record.position ?? null } })
        else rowSpeaks()
      })
      .catch(() => {
        // The row's value stands. A record that will not read is a book that is
        // about to fail to open anyway, and this is not where that is reported.
        rowSpeaks()
      })
    return () => {
      live = false
    }
  }, [bookId, fs, read, open])
  return held !== null && held.open === open ? held.value : null
}

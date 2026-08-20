import { useEffect, useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { ICON, type Platform } from '../../core/metrics'
import type { Bookmark } from '../../core/marks'
import { relativeTime } from '../../core/relativeTime'
import type { Bookmarking } from '../hooks/useBookmarking'
import { comboFor } from '../panes'
import styles from './SidePane.module.css'

/**
 * Bookmarks — the reader's own places in the open book.
 *
 * Distinct from Contents, which is the BOOK's structure: this list is one
 * reader's, it is editable, and it is empty for most books. Distinct from Notes
 * too, and the line is §15's: a mark is about a passage and a bookmark is about
 * a place. Nothing here is drawn into the text.
 *
 * PER BOOK, unlike Notes, which browses every book's marks. There is no
 * cross-book read to show — see `MarkSnapshot.bookmarks` — and the panel is
 * book-only for that reason rather than as a layout preference.
 */

export interface BookmarksProps {
  bookmarking: Bookmarking
  /** True when a book is open. False is the "nothing to list" empty state. */
  hasBook: boolean
  /**
   * Which keyboard this reader has, so the empty state names a key they can
   * press.
   *
   * NOT DECORATION. §11's accelerator is ⌘ on macOS and Ctrl everywhere else,
   * and `comboFor` exists because printing the registry's ⌘ verbatim tells a
   * Windows reader to press a key their keyboard does not have — the app
   * describing a feature it does not have, which is the row the library ledger
   * opens with. This panel is the one place the combo is taught.
   */
  platform: Platform
  /** Injected so a test can assert an age without waiting for one to pass. */
  now?: number
}

/**
 * The clock the ages are measured against.
 *
 * A PLAIN PROP WAS NOT ENOUGH. `now` defaulted to `Date.now()` evaluated during
 * render, so it only advanced when something unrelated re-rendered the panel —
 * a reader who left the pane open watched three bookmarks stay "Just now" for
 * an hour. Ticking once a minute matches the resolution `relativeTime` reports
 * in; anything faster would re-render for a value that cannot have changed.
 *
 * Skipped entirely when a caller supplies one, which is what keeps the tests
 * deterministic and stops a timer running in them.
 */
function useNow(injected: number | undefined): number {
  const [now, setNow] = useState(() => injected ?? Date.now())
  useEffect(() => {
    if (injected !== undefined) return
    const tick = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(tick)
  }, [injected])
  return injected ?? now
}

/**
 * What a row shows for a place.
 *
 * The remembered opening line where there is one, and the chapter alone where
 * there is not — which is every fixed-layout book, because `foliate-fxl`
 * reports no range to read a line out of. See `ReaderSession.placeHere`.
 *
 * `bookmarkFrom` collapses the whitespace before storing, so for anything
 * written since that landed this is already done. It stays because rows
 * written BEFORE it are on disk carrying the newlines and indentation of the
 * markup they were walked out of, and a row set in those has a ragged hole
 * through the middle of it. Idempotent, so it costs a pass and settles both.
 */
function lineOf(bookmark: Bookmark): string {
  return bookmark.text.replace(/\s+/gu, ' ').trim()
}

/**
 * §11: say what happened. A store that has quietly stopped saving looks exactly
 * like one that works — and a bookmark, whose whole purpose is to still be
 * there tomorrow, is the worst thing to be quiet about.
 *
 * ABOVE EVERY STATE, not just the list. It lived below the two early returns,
 * which hid it in the one case that matters most: a failed REMOVE leaves the
 * optimistic list empty, so the panel took the empty branch and the warning
 * that the removal had not been saved went with it. The reader saw a bookmark
 * disappear and no word that it would be back.
 */
function Unsaved() {
  return (
    <div className={styles.panelMeta}>
      <span>Bookmarks are not being saved — this device’s storage is unavailable.</span>
    </div>
  )
}

/** The panel's empty and loading states, which differ only in their words. */
function Nothing({ title, body, warn }: { title: string; body: ReactNode; warn: boolean }) {
  return (
    <>
      {warn && <Unsaved />}
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>{title}</div>
        <div className={styles.emptyBody}>{body}</div>
      </div>
    </>
  )
}

export function Bookmarks({ bookmarking, hasBook, platform, now: injected }: BookmarksProps) {
  const { all, here, remove, goTo, persistent, ready } = bookmarking
  const now = useNow(injected)

  if (!hasBook) {
    return (
      <Nothing
        title="No book open"
        body="Bookmarks belong to a book. Open one and this lists the places you have kept in it."
        /* No book, no writes to have failed — and nothing on screen the warning
           could be about. */
        warn={false}
      />
    )
  }

  /* NOT THE SAME AS EMPTY, and saying so is the point. A book's marks are read
     off disk after it opens, and until they arrive the list is empty for a
     reason that has nothing to do with the reader. Announcing "No bookmarks in
     this book" over a book with four of them is the app being confidently
     wrong for as long as the read takes. */
  if (!ready) {
    return <Nothing title="Reading this book’s bookmarks…" body="One moment." warn={!persistent} />
  }

  if (all.length === 0) {
    return (
      <Nothing
        title="No bookmarks in this book"
        /* SAYS HOW, because there is nothing on screen to discover it from
           until the first one exists: the ribbon only appears on a page that
           already carries one. Through `comboFor`, so the key named is the key
           this platform actually binds. */
        body={`Press ${comboFor('⌘B', platform)}, or the bookmark button below the page, to keep the place you are reading.`}
        /* THE CASE THE WARNING WAS HIDDEN IN. An empty list is exactly what a
           failed removal produces optimistically, so this branch is where the
           reader most needs to be told the write did not land. */
        warn={!persistent}
      />
    )
  }

  return (
    <div className={styles.panel}>
      {!persistent && <Unsaved />}

      <div className={styles.panelMeta}>
        {all.length} {all.length === 1 ? 'bookmark' : 'bookmarks'}
      </div>

      {all.map((bookmark) => {
        const line = lineOf(bookmark)
        const when = relativeTime(bookmark.createdAt, now)
        const chapter = bookmark.chapter || 'Somewhere in this book'
        return (
          <div
            key={bookmark.id}
            className={styles.note}
            /* Borrows the note row wholesale and drops its tint bar — a
               bookmark carries no colour. See the rule this selects. */
            data-place="true"
            /* The place the reader is standing on, lit the same way Notes lights
               the row it was asked to reveal — a tint rather than a border, so
               the row does not change size and shift every row under it. */
            data-focused={here?.id === bookmark.id}
          >
            <button type="button" className={styles.noteJump} onClick={() => goTo(bookmark)}>
              {/* THE CHAPTER LEADS, and the line follows it. A reader scanning
                  this list is looking for a place in the book, and the chapter
                  is the coordinate they hold it by; the line is what confirms
                  they have the right one of the four they kept in it. With no
                  line to show, the chapter is the whole row rather than a
                  label over an empty one. */}
              <span className={styles.placeChapter}>{chapter}</span>
              {line && (
                <span className={`${styles.noteBody} ${styles.placeLine}`}>{line}</span>
              )}
            </button>

            <div className={styles.noteSource}>
              <span>{when}</span>
              <button
                type="button"
                className={styles.noteDelete}
                title="Remove this bookmark"
                /* NAMES THE PLACE, where the tooltip does not have to. Two
                   things make the bare label useless to anyone not looking at
                   the screen: the footer toggle carries the same five words,
                   and several bookmarks in ONE chapter are explicitly
                   supported — so the chapter alone does not separate them
                   either. The remembered line is what actually distinguishes
                   two places in the same chapter, so it is what goes here. */
                aria-label={`Remove this bookmark — ${line || chapter}`}
                onClick={() => remove(bookmark)}
              >
                <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

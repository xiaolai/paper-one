import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { legacyBookIdFor } from '../../core/idMigration'
import { contentPathIn, recordPath, recordFromMeta } from '../../core/bookFolder'
import type { BookMeta } from '../../core/bookMeta'
import type { IndexFs } from '../../core/bookIndex'
import type { BookRecord } from '../../core/bookFolder'
import type { RekeyOutcome } from '../../core/libraryStore'

/**
 * Taking a book in: its bytes, its identity, and its record, in that order.
 *
 * THIS IS THE PIECE THAT HAS PRODUCED THE MOST DEFECTS IN THIS APP, and the
 * reason is legible once it is on its own: five things happen here, each with
 * an await between it and the next, and every pair of them can be interleaved
 * with the reader doing something else. As one effect inside a nine-hundred-line
 * component it read as a formality. It is not one.
 *
 * The order is the whole design, and each step earns its place ahead of the
 * next:
 *
 *   1. IDENTITY, first and awaited. `bookIdFor` hashes content now rather than
 *      a file's ends, so a book stored under the previous scheme computes a new
 *      id on its first open. The library's half of that migration is a directory
 *      RENAME; the marks' and cards' halves rewrite ids inside whatever
 *      directory the book ends up in. Run as separate effects they raced, and
 *      only one of the two interleavings produced a whole book.
 *
 *   2. THE REMOVAL CHECK, against a baseline taken when the reader ASKED for the
 *      book rather than when this ran — parsing takes seconds, and a removal
 *      inside that window belongs to the reader's current intent.
 *
 *   3. THE BYTES, before the record. A folder holding a book with no record is
 *      simply not on the shelf yet — `scanBooks` skips it — and the next open of
 *      the same file finishes the job. The reverse is a row that cannot open,
 *      which is the state `canOpen` exists to describe and should not have to.
 *
 *   4. THE REMOVAL CHECK AGAIN, because the write above is the long part.
 *
 *   5. THE RECORD, which is what puts the book on the shelf.
 */
export interface BookIntake {
  /* No `openedPath` here. It is where the open book lives on this machine and
   * it is INTAKE'S business — the record effect is the only thing that ever
   * wanted it, and returning it invited a second reader who would then have to
   * be kept in step with the first. */
  /** Tell intake a book was asked for, with the path it came from. */
  readonly noteOpen: (source: File | string, path: string | null) => void
  /** Tell intake a book was taken off the shelf. */
  readonly noteRemoval: (bookId: string) => void
}

export interface BookIntakeInput {
  readonly bookId: string | null
  readonly meta: BookMeta | null
  readonly source: File | string | null
  readonly fs: IndexFs | null
  readonly add: (bookId: string, record: BookRecord, sparse?: boolean) => void
  /**
   * The library's own content write — on the book's queue, bracketed for a
   * recorder, atomic. Resolves once the bytes are in the folder (or were
   * already there), which is what lets the record be ordered after them.
   */
  readonly keepContent: (bookId: string, name: string, bytes: Blob) => Promise<boolean>
  readonly rekeyBook: (from: string, to: string) => Promise<RekeyOutcome>
  readonly rekeyMarks: (from: string, to: string) => void
  readonly rekeyCards: (from: string, to: string) => void
}

export function useBookIntake({
  bookId,
  meta,
  source,
  fs,
  add,
  keepContent,
  rekeyBook,
  rekeyMarks,
  rekeyCards,
}: BookIntakeInput): BookIntake {
  /* Where the open book lives on THIS machine, when it was opened from disk.
   *
   * Held beside the book rather than inside it: everything downstream takes a
   * `File`, and neither foliate nor `bookIdFor` has any business knowing about
   * the filesystem. It is written onto the library row so the shelf can open
   * the book again — which is the whole point, and what a `File` could never
   * support, since it is a handle to bytes granted for one session. */
  const [openedPath, setOpenedPath] = useState<string | null>(null)
  /** The path `openBook` was given, tagged with the source it belongs to. */
  const pendingPath = useRef<{ source: File | string; path: string | null } | null>(null)

  /**
   * Books the reader took off the shelf, and WHEN — as a count of removals
   * rather than a clock, because only the order matters.
   *
   * Intake writes the bytes and then the record, with awaits in between, and a
   * removal landing in that gap used to put the book straight back: the row
   * reappeared as if the click had been ignored. Nothing else can see that,
   * because the effect's inputs do not change when a row is removed.
   *
   * A TICK RATHER THAN A FLAG THAT GETS CLEARED. Clearing was the trap: the
   * marker for a book removed under its legacy id could only be cleared after
   * hashing the file, and a removal made during that hash was then cleared by
   * it. Comparing counts asks the question that actually matters — did a removal
   * happen AFTER this intake started — and needs nothing cleared, since one made
   * before it is the reader opening the book again.
   */
  const removedWhileOpen = useRef(new Map<string, number>())
  const removals = useRef(0)
  /** The tick when the current book was ASKED FOR — see the effect below. */
  const openedAt = useRef<{ source: File | string; at: number } | null>(null)


  /**
   * A book has been asked for. Called before the open itself begins.
   *
   * The path is handed over WITH its source rather than set directly, so the
   * effect that notices a new source is the single place it is decided. Set
   * eagerly it survived a route that does not come through here — dropping a
   * book onto the open reader recorded it with the PREVIOUS book's path.
   */
  const noteOpen = useCallback((next: File | string, path: string | null) => {
    pendingPath.current = { source: next, path }
  }, [])

  /** A book has been taken off the shelf. Ordered, not timed — see above. */
  const noteRemoval = useCallback((removed: string) => {
    removals.current += 1
    removedWhileOpen.current.set(removed, removals.current)
  }, [])

  /* Stamp the removal baseline the instant a new source appears.
   *
   * NOT IN `openBook`, which is only one of the ways a book arrives — a drop on
   * the reader and a `?book=` on startup both go straight to `book.open`, and
   * for those the baseline fell back to "now", which is captured only after the
   * file has been hashed and parsed. A removal inside that window then became
   * the baseline instead of being compared against it, so the book was
   * resurrected under its new id with its tags and marks left in the trash.
   *
   * `useLayoutEffect` so it runs before the intake effect that reads it, and on
   * `source` because that is set the moment an open begins, long before there
   * is an id or a parse. */
  useLayoutEffect(() => {
    if (source && openedAt.current?.source !== source) {
      openedAt.current = { source, at: removals.current }
      /* AND THE PATH BELONGS TO THE SOURCE, not to whatever was opened last.
       * `openBook` set it and the routes that bypass `openBook` did not clear
       * it — so dropping a book onto the open reader recorded it with the
       * PREVIOUS book's path as its origin, and clicking it later opened the
       * wrong book. A source that arrived with no path of its own has none. */
      setOpenedPath(pendingPath.current?.source === source ? pendingPath.current.path : null)
    }
  }, [source])

  useEffect(() => {
    if (!bookId || !meta) return
    /* CLEARED FOR THIS BOOK, ONCE PER OPEN.
     *
     * Keyed on the SOURCE, because this effect also runs when the parse lands —
     * and metadata arriving is not the reader asking for the book back. Clearing
     * unconditionally there undid a removal made in the seconds between opening
     * a book and it finishing parsing. A fresh open produces a new `File`, or a
     * different path, so identity is exactly the right test. */
    /* From the OPEN, not from here: this effect does not run until the book has
     * been hashed and parsed, and a removal during that window belongs to the
     * reader's current intent rather than a previous one. Falls back to now for
     * a book that arrived without going through `openBook`. */
    const startedAt = openedAt.current?.source === source ? openedAt.current.at : removals.current
    const removedSince = (...ids: readonly string[]): boolean =>
      ids.some((id) => (removedWhileOpen.current.get(id) ?? 0) > startedAt)
    let cancelled = false
    void (async () => {
      /* THE IDENTITY MIGRATION FIRST, and awaited, which is the whole reason it
       * lives here rather than in its own effect. `add` below creates the folder
       * for the NEW id, and `rekeyBook` abandons the move when that folder is
       * already there — so run as a separate effect the two raced, and losing
       * the race meant a permanent duplicate row rather than a moved book.
       *
       * A book stored under the previous scheme only. `legacyBookIdFor` returns
       * the same id for everything since, and `rekeyBook` returns immediately
       * when it does. */
      /* CARRY THE READER'S EXISTING WORK ACROSS FIRST, in one place and in one
       * order, because the three halves of it cannot be independent.
       *
       * `bookIdFor` hashes content now rather than a file's ends, so everything
       * stored under the previous scheme is filed under an id nothing will
       * compute again. The library's half is a DIRECTORY RENAME and the other
       * two are id rewrites inside whatever directory the book ends up in — so
       * the rename has to finish before they run. Left as separate effects they
       * raced, and only one of the two interleavings produced a whole book:
       * marks migrated into a folder that was about to be renamed over them, or
       * a folder renamed out from under a migration still reading it.
       */
      let legacy = bookId
      try {
        if (source) legacy = await legacyBookIdFor(source)
      } catch (cause) {
        console.error('Paper: could not check the legacy book id', cause)
      }
      if (legacy !== bookId) {
        const carried = await rekeyBook(legacy, bookId)
        /* STOP. Adding the book under its new id after a move that did not
         * happen creates the second folder the move exists to prevent — and
         * every later attempt then finds the destination occupied and gives up.
         * Left alone, the book keeps the id it has and the next open retries. */
        if (carried === 'failed') return
        /* OCCUPIED means the book exists under both ids and neither is moving.
         * The other stores must leave the old copy alone rather than migrating
         * their half of it, or the same mark ends up in two folders under one id
         * and neither read of it is authoritative. */
        if (carried !== 'occupied') {
          rekeyMarks(legacy, bookId)
          rekeyCards(legacy, bookId)
        }
      }
      /* THE LEGACY ID COUNTS AS THIS BOOK. `removeBook` records whatever id the
       * ROW carried, which for a book stored under the previous scheme is the
       * legacy one — so checking only the newly computed id meant removing a
       * book while it was still parsing put it back under a different name,
       * with the tags and marks it owned left in the old id's trash entry for
       * the sweep. */
      if (cancelled || removedSince(bookId, legacy)) return
      if (source instanceof File && fs) {
        try {
          /* THE LIBRARY WRITES IT — on this book's queue, in line with its
           * record write and its removal, and bracketed for a recorder like
           * every other write to a folder. This used to be an inline
           * temp-and-rename here, outside the queue, which is the one place a
           * removal could interleave with. The checks below still stand,
           * because the write is the long part either way. */
          await keepContent(bookId, source.name, source)
        } catch (cause) {
          /* Reported and not fatal. The record is still written, and the shelf
           * says the copy is missing rather than pretending the open failed. */
          console.error('Paper: could not keep our own copy of the book', cause)
        }
        /* CHECKED AGAIN, because the write above is the long part — a 40MB book
         * off a network volume — and a removal during it leaves the folder that
         * `mkdir` recreated sitting there holding nothing but content.
         *
         * ONLY THE FILE THIS EFFECT WROTE, and only once the record is gone,
         * which is what proves the removal finished and this folder is the shell
         * we made. Removing the DIRECTORY here was catastrophic: lose the race
         * the other way and it deletes the live book — content, record, tags,
         * position and marks — before `trashBook` has moved anything, so there
         * is no copy to recover. A stray file is worth incomparably less than
         * the chance of that. */
        if (removedSince(bookId, legacy) && fs && source instanceof File) {
          const at = contentPathIn(bookId, source.name)
          if (!(await fs.exists(recordPath(bookId)))) await fs.remove(at).catch(() => {})
          return
        }
      }
      /* The SAME question as everywhere else: did a removal arrive after the
       * reader asked for this book. Membership was the old flag scheme, and it
       * never forgot — so removing the open book and then deliberately opening
       * the same file again was refused for the rest of the session. */
      if (cancelled || removedSince(bookId, legacy)) return
      /* `add`, which FOLDS a fresh parse into what the reader owns rather than
       * replacing it — see `mergeParsed`. Phase 3 spread the parse over the row
       * and erased the reader's tags on every reopen.
       *
       * `openedAt` is set here because this is the moment a book is opened, and
       * the shelf is ordered by it. */
      add(bookId, {
        /* The parse's own fields — see `recordFromMeta`, which the enrichment
         * pass shares, so a book parsed in the background and a book opened
         * agree about what a parse knows. */
        ...recordFromMeta(meta),
        openedAt: Date.now(),
        addedAt: Date.now(),
        /* THIS IS A PARSE, so it stamps the parse marker — the enrichment pass
         * must not come back for a book the reader has just read. `mergeParsed`
         * gives the parse authority over `parsedAt`, which is right: it is the
         * parse's own provenance. But authority means the parse has to SUPPLY
         * it, and this route did not — so opening a book DELETED its marker and
         * put it back in the queue, and every book the reader actually read was
         * re-parsed on the next launch, forever. The pass converged only for
         * books nobody opened, which is the opposite of the intended guarantee. */
        parsedAt: Date.now(),
        /* NO `description`. It was passed here and dropped on the floor:
         * `BookRecord` has no such field and `parseRecord` discards it, so every
         * write serialised it and every read threw it away. Nothing displays a
         * description yet — when something does, it belongs in the record first
         * and here second. */
        /* WHERE THE BOOK CAME FROM — a path, or a URL when that is what was
         * opened. Phase 3 kept `url` as a separate field and phase 4 deleted it
         * on the reasoning that a book is its own folder; but Paper only ever
         * copies a `File`, so a book opened from a URL has no folder contents at
         * all. Without this it became a row that could never be opened again,
         * which is precisely the state `canOpen` had to be brought back to
         * describe. One field, because a fallback is a fallback whatever kind of
         * address it holds. */
        ...(openedPath ?? (typeof source === 'string' ? source : null)
          ? { origin: openedPath ?? (source as string) }
          : {}),
        ...(source instanceof File ? { ext: source.name.split('.').pop() ?? '' } : {}),
      })
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, meta, source, add, keepContent, openedPath, fs, rekeyBook, rekeyMarks, rekeyCards])

  return { noteOpen, noteRemoval }
}

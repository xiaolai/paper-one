import { useEffect, useRef, useState } from 'react'
import type { IndexedBook } from './bookIndex'
import type { BookRecord } from './bookFolder'
import type { VaultFs } from './bookVault'
import { keepCover } from './coverArt'
import { enrichOne, nextStep, pendingFor, type EnrichDeps } from './enrich'

/**
 * Fill the shelf in, one book at a time, out of the way.
 *
 * The decisions live in `enrich.ts`; this is the scheduling, which is the part
 * with a reader in it. Three rules, and they are all about staying out of the
 * way:
 *
 * ONE AT A TIME. Parsing is CPU work on the main thread — foliate unzips there,
 * and pdf.js decodes page one there — so two in flight doubles the jank to
 * halve a wall-clock nobody is watching. The pass is not in a hurry; it has
 * until the reader next looks at the shelf, and then it has the launch after
 * that.
 *
 * NOT WHILE READING. A reader in a book is spending the main thread on page
 * turns, and a background parse lands as a stutter in the one place this app
 * has to feel smooth. The pass stops when the reader opens a book and picks up
 * where it left off when they come back — no state needed, because `parsedAt`
 * on disk IS the progress.
 *
 * A BREATH BETWEEN BOOKS. Yielding to the event loop between parses is what
 * keeps a shelf scrollable while two thousand books are being read.
 *
 * It resumes across quits for the same reason: the work list is derived from
 * the shelf every time, so a pass interrupted at book four hundred starts the
 * next launch at book four hundred and one, and a pass that finishes finds
 * nothing to do and costs one filter.
 */

/**
 * How long to stand aside between books, in milliseconds.
 *
 * Long enough that a scroll gesture lands between two parses rather than behind
 * one, short enough that two thousand books do not take all evening: at 120ms
 * of standing aside the pass spends four minutes waiting across a shelf that
 * size, which is nothing next to the parsing itself.
 */
const BREATH_MS = 120

export interface EnrichmentProgress {
  /** How many books still have no parse. Zero means the shelf is complete. */
  readonly pending: number
  /** Whether a book is being parsed right now. */
  readonly running: boolean
}

export interface EnrichmentDeps {
  /** The shelf, as the library holds it. */
  readonly books: readonly IndexedBook[]
  /** Null outside Tauri, which is also how the pass is switched off in tests. */
  readonly fs: VaultFs | null
  /**
   * True while the reader is IN a book — the pass stands down.
   *
   * The reader's screen rather than whether a book is loaded: a book stays
   * loaded when the reader steps back to the shelf, and the shelf is exactly
   * where they want jackets appearing.
   */
  readonly reading: boolean
  /** Fold a parse into the shelf — the same `add` the reader's own open uses. */
  readonly add: (bookId: string, record: BookRecord) => void
  /** Read a book's bytes back as a `File` — see `EnrichDeps.readBook`. */
  readonly readBook: EnrichDeps['readBook']
  /** The reader's own parser — see `EnrichDeps.parse`. */
  readonly parse: EnrichDeps['parse']
}

export function useEnrichment(deps: EnrichmentDeps): EnrichmentProgress {
  // Only what this function itself reads; the loop reaches the rest through `live`.
  const { books, fs, reading } = deps
  const [running, setRunning] = useState(false)

  /* The whole of `deps` behind a ref. The loop is a single long-lived async
   * function, and everything it needs changes underneath it — the shelf grows
   * as it writes to it, and `add` is a new function on every render. Depended
   * on, the effect would tear the loop down and start it again on every book it
   * finished, which is a loop that makes progress only by accident. */
  const live = useRef(deps)
  live.current = deps

  /* Derived, not counted: the shelf IS the progress. A number kept alongside
   * would be a second source of truth about the same thing, and the one that
   * goes stale. */
  const pending = pendingFor(books).length

  useEffect(() => {
    if (!fs || reading || pending === 0) return
    let stopped = false
    /* NOT `void (async () => …)()`. The cleanup has to be able to wait for the
     * loop to notice it has been stopped — see the end of this effect. */
    const done = (async () => {
      /* Re-derived every turn rather than taken once. The shelf changes as this
       * writes to it, and an import can land three hundred more books while the
       * pass is halfway through the last batch; a list captured at the start
       * would finish and stop with the new ones untouched until the next
       * launch. */
      for (;;) {
        if (stopped) return
        /* ASKED EVERY TURN, and asked of `nextStep` rather than decided here:
         * the reader can open a book DURING a parse, and the guard that started
         * this loop ran a minute and four hundred books ago. It is also the
         * only place the rule lives, so the test that pins it pins this. */
        const step = nextStep({
          books: live.current.books,
          hasFilesystem: live.current.fs !== null,
          reading: live.current.reading,
        })
        if (step.kind === 'idle') return
        setRunning(true)
        /* ONE BOOK, because `nextStep` hands back one book — the rule is in the
         * return type rather than in a constant that could be set to two and
         * change nothing. Parsing is CPU work on the main thread; two in flight
         * doubles the jank to halve a wall-clock nobody is watching. */
        {
          const enriched = await enrichOne(
            {
              readBook: (one) => live.current.readBook(one),
              parse: (file) => live.current.parse(file),
              now: () => Date.now(),
            },
            step.book,
          )
          if (stopped) return
          /* THE RECORD FIRST, THE JACKET SECOND, and it matters which way round.
           * `parsedAt` is what stops the pass returning to this book, so a crash
           * between the two lines leaves a book with its title and no picture —
           * which the reader can fix by opening it, and which looks like a book
           * that has no cover. The other order leaves a jacket on disk for a
           * book that will be parsed again on the next launch, and `keepCover`
           * would then decline to write the real one because a file is already
           * there. */
          live.current.add(enriched.bookId, enriched.record)
          if (enriched.cover) await keepCover(live.current.fs!, enriched.bookId, enriched.cover)
        }
        setRunning(false)
        /* The breath. Also the loop's only yield point when every book fails
         * fast — without it a shelf of unreadable files would spin the main
         * thread flat rather than failing politely. */
        await new Promise((resolve) => setTimeout(resolve, BREATH_MS))
      }
    })()

    return () => {
      stopped = true
      /* The flag is set synchronously, so the loop stops at its next check; this
       * only makes sure `running` is not left true by an effect that was torn
       * down mid-parse. A parse already in flight is allowed to finish — it is
       * about to be thrown away, and cancelling a pdf.js render midway is more
       * likely to leak a worker than to save anything. */
      void done.finally(() => setRunning(false))
    }
    // `books` is deliberately absent: `pending` is derived from it and is the
    // only part of it this effect reacts to, and the loop reads the rest
    // through `live`. Listed, every write the pass makes would restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, reading, pending === 0])

  return { pending, running }
}

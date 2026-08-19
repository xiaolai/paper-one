import { useEffect, useRef } from 'react'
import type { IndexedBook } from '../../core/bookIndex'
import type { BookRecord } from '../../core/bookFolder'
import type { VaultFs } from '../../core/bookVault'
import { breathe } from '../../core/breath'
import { enrichOne, needsEnrichment, nextStep, pendingCount, type EnrichDeps } from '../../core/enrich'

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
 * NOT WHILE READING, AND NOT WHILE IMPORTING. A reader in a book is spending
 * the main thread on page turns, and a background parse lands as a stutter in
 * the one place this app has to feel smooth. An import is spending the same
 * thread copying, and it shelves as it goes — so its rows land here while it
 * is still running, and a pass that took them would be parsing a book a
 * second against a copy loop that wants the thread seventy times a second.
 * Both stand-downs cost nothing: `parsedAt` on disk IS the progress, so the
 * pass resumes exactly where it left off.
 *
 * A BREATH BETWEEN BOOKS, TAKEN WHEN IT IS NEEDED. Yielding between parses is
 * what keeps a shelf scrollable while two thousand books are being read — but
 * the yield waits for the main thread to be free rather than for a fixed
 * 120ms, so the pass stands aside from a reader and not from an empty room.
 * See `breathe`.
 *
 * It resumes across quits for the same reason: the work list is derived from
 * the shelf every time, so a pass interrupted at book four hundred starts the
 * next launch at book four hundred and one, and a pass that finishes finds
 * nothing to do and costs one filter.
 */

/**
 * The LONGEST this stands aside between books, in milliseconds.
 *
 * A ceiling now, not a duration — see `breathe`. It was a flat sleep, and a
 * flat sleep charges the same whether the reader is scrolling or the app has
 * been untouched for an hour: at 120ms a book, a shelf of two thousand spent
 * very nearly four minutes waiting for nobody. The wait is `requestIdleCallback`
 * with this as its timeout, so it ends as soon as the main thread is free and
 * still cannot be starved past the figure that was tuned here.
 *
 * The value is unchanged deliberately. It was chosen as the longest pause a
 * reader would not notice, which is exactly the right ceiling; what was wrong
 * with it was being the floor as well.
 */
const BREATH_MS = 120

export interface EnrichmentProgress {
  /** How many books still have no parse. Zero means the shelf is complete. */
  readonly pending: number
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
  /**
   * True while an import is still copying books in — the pass stands down.
   *
   * The import shelves as it copies, so its rows arrive while it is running
   * and this pass would otherwise start parsing on top of it, on the same
   * thread, for the whole of the import. See `IdleReason`'s `importing`.
   */
  readonly importing: boolean
  /** Fold a parse into the shelf — the same `add` the reader's own open uses. */
  readonly add: (bookId: string, record: BookRecord) => void
  /** File the jacket, in order with this book's other writes — see `keepJacket`. */
  readonly keepJacket: (bookId: string, cover: Blob) => void
  /** Read a book's bytes back as a `File` — see `EnrichDeps.readBook`. */
  readonly readBook: EnrichDeps['readBook']
  /** The reader's own parser — see `EnrichDeps.parse`. */
  readonly parse: EnrichDeps['parse']
}

export function useEnrichment(deps: EnrichmentDeps): EnrichmentProgress {
  // Only what this function itself reads; the loop reaches the rest through `live`.
  const { books, fs, reading, importing } = deps

  /* The whole of `deps` behind a ref. The loop is a single long-lived async
   * function, and everything it needs changes underneath it — the shelf grows
   * as it writes to it, and `add` is a new function on every render. Depended
   * on, the effect would tear the loop down and start it again on every book it
   * finished, which is a loop that makes progress only by accident. */
  const live = useRef(deps)
  live.current = deps

  /* THERE IS NO `running` STATE. There was, and nothing ever read it — the app
   * uses only `pending` — while `setRunning(true)`/`setRunning(false)` fired
   * once each per book. On a two-thousand-book shelf that is four thousand
   * re-renders of a tree containing the shelf itself, to maintain a value with
   * no consumer, from a pass whose entire purpose is to stay out of the way. A
   * progress indicator that costs more than the work it reports is not
   * observability. */

  /* Derived, not counted: the shelf IS the progress. A number kept alongside
   * would be a second source of truth about the same thing, and the one that
   * goes stale. `pendingCount` rather than `pendingFor(...).length`, because
   * this runs on every render and the ordering is of no use to it. */
  const pending = pendingCount(books)

  /**
   * WHICH LOOP IS ALLOWED TO ACT.
   *
   * The effect can be torn down and replaced — `reading` flips, or StrictMode
   * double-invokes it in development, which this app enables. Cleanup cannot
   * await, so an obsolete loop is still mid-parse when its replacement starts:
   * a boolean `stopped` per closure stopped the old loop at its next CHECK but
   * did nothing about the parse already in flight, so two ran at once and the
   * one-at-a-time guarantee held only between checks.
   *
   * A generation counter fixes both halves. The replacement waits for the
   * previous loop to actually finish before parsing anything, and any loop
   * whose generation is stale writes nothing — a parse that outlived its effect
   * is thrown away rather than committed.
   */
  const generation = useRef(0)
  const inFlight = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (!fs || reading || importing || pending === 0) return
    const mine = (generation.current += 1)
    const current = () => generation.current === mine

    const previous = inFlight.current
    const done = (async () => {
      /* WAIT FOR THE LOOP THIS ONE REPLACES. Without it, StrictMode's second
       * mount starts parsing while the first mount's parse is still running —
       * two foliate books, or two pdf.js workers, for a pass that promises
       * one. */
      await previous.catch(() => {})
      for (;;) {
        if (!current()) return
        /* ASKED EVERY TURN, and asked of `nextStep` rather than decided here:
         * the reader can open a book DURING a parse, and the guard that started
         * this loop ran a minute and four hundred books ago. It is also the
         * only place the rule lives, so the test that pins it pins this. */
        const step = nextStep({
          books: live.current.books,
          hasFilesystem: live.current.fs !== null,
          reading: live.current.reading,
          /* Asked every turn, like `reading`: an import can START while this
           * loop is running — a drop onto the window during the parse pass —
           * and the guard that let the loop in ran books ago. */
          importing: live.current.importing,
        })
        if (step.kind === 'idle') return

        /* ONE BOOK, because `nextStep` hands back one book — the rule is in the
         * return type rather than in a constant that could be set to two and
         * change nothing. Parsing is CPU work on the main thread; two in flight
         * doubles the jank to halve a wall-clock nobody is watching. */
        const enriched = await enrichOne(
          {
            readBook: (one) => live.current.readBook(one),
            parse: (file) => live.current.parse(file),
            now: () => Date.now(),
          },
          step.book,
        )
        if (!current()) return

        /* STILL ON THE SHELF? A parse takes seconds, and in those seconds the
         * reader can remove the book. `add` is not a plain write — it restores
         * a book from the trash, because its job is "this book exists, take it
         * in" — so committing a parse for a book that has just been removed
         * pulls the folder back OUT of the trash and puts the row back on the
         * shelf. The reader deletes a book and it reappears.
         *
         * Re-resolved from `live`, not from `step.book`, because that snapshot
         * is as old as the parse. `needsEnrichment` is re-checked with it: if
         * something else has parsed this book meanwhile, this result is stale
         * and worth nothing. */
        const still = live.current.books.find((one) => one.bookId === enriched.bookId)
        if (!still || !needsEnrichment(still)) continue

        /* THE RECORD FIRST, THE JACKET SECOND, and it matters which way round.
         * `parsedAt` is what stops the pass returning to this book, so a crash
         * between the two lines leaves a book with its title and no picture —
         * which the reader can fix by opening it, and which looks like a book
         * that has no cover. The other order leaves a jacket on disk for a book
         * that will be parsed again on the next launch, and `keepCover` would
         * then decline to write the real one because a file is already there. */
        live.current.add(enriched.bookId, enriched.record)
        if (enriched.cover) live.current.keepJacket(enriched.bookId, enriched.cover)

        /* The breath. Also the loop's only yield point when every book fails
         * fast — without it a shelf of unreadable files would spin the main
         * thread flat rather than failing politely. `breathe` always yields,
         * idle callback or timer, so that guarantee is unchanged. */
        await breathe(BREATH_MS)
      }
    })()
    inFlight.current = done

    return () => {
      /* Bumped synchronously, so every check in the loop above fails from here
       * on and nothing it produces is written. The parse already in flight is
       * allowed to finish — cancelling a pdf.js render midway is more likely to
       * leak a worker than to save anything — and the NEXT effect waits for it
       * through `inFlight` rather than racing it. */
      generation.current += 1
    }
    // `books` is deliberately absent: `pending` is derived from it and is the
    // only part of it this effect reacts to, and the loop reads the rest
    // through `live`. Listed, every write the pass makes would restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, reading, importing, pending === 0])

  return { pending }
}

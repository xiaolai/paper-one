/**
 * What Settings → Library search needs and the PLUGIN cannot answer.
 *
 * Two things, and they are together because they have one reason: the plugin
 * knows what it holds and nothing about the shelf. Both were found missing by
 * looking at the running app on the real library (WI-31.8), and neither could
 * have been found any other way — the panel rendered, every test passed, and
 * what a reader was shown was still wrong.
 *
 * ⚠️ **"300 BOOKS INDEXED" IS NOT "HOW FAR", AND THAT IS THE WHOLE REASON THIS
 * EXISTS.** The plugin knows how many books it holds; it has no idea how many
 * the shelf HAS, because the shelf is the kernel's and the plugin never sees it.
 * So a reader with 1 959 books shown *"300 books · 6 000 chapters"* cannot tell
 * a build that is one sixth done from one that has finished and found only three
 * hundred books worth indexing. The plan asks for *"that it is building and
 * roughly how far"*, and only the capability can say.
 *
 * ⚠️ **A MODULE-LEVEL HOLDER, FOR THE REASON THE PORT IS ONE.** A contributed
 * settings section renders from a closure that has no `CapabilityContext` —
 * `render: () => createElement(Pane, …)` — so there is nowhere to pass this
 * through. `voices` reaches its port the same way and `theDownloads` is the same
 * shape; the alternative is widening `SettingsSection.render` for one field,
 * which would be a kernel change for a capability's convenience.
 *
 * ⚠️ **AND IT IS DELIBERATELY NOT PERSISTED.** It describes a sweep in THIS
 * process. After a relaunch the honest answer is whatever `passages_status` and
 * the shelf say, and a remembered "sweeping" from a session that was killed
 * mid-build would be a spinner nothing can ever stop.
 *
 * ## The second thing: what a book is CALLED
 *
 * ⚠️ **THE UNREADABLE LIST SHOWED BOOK IDS, WHICH A READER CANNOT ACT ON.**
 * Observed on a real shelf: *"book:d2ce8755… — it holds no text this build could
 * read"*, twenty-one times over. The records were perfectly accurate — every one
 * was a picture book, all pictures and almost no selectable text — and the panel
 * was still useless, because a reader cannot tell which of their books is
 * missing from search.
 *
 * The plugin cannot help: it is handed text and an id and never sees a title.
 * The shelf is the kernel's, and a contributed settings section renders from a
 * closure with no `CapabilityContext` — so the lookup arrives the same way the
 * progress does.
 *
 * ⚠️ **IT IS NOT PART OF THE SNAPSHOT, AND THAT IS DELIBERATE.** A function in a
 * `useSyncExternalStore` value has a new identity every render and would make
 * every comparison unequal. The panel re-reads the status on a timer anyway, so
 * a title that arrives after the lookup is bound shows within one poll.
 */

import { notifyAll } from '../../../kernel'

/** What a reader is told about the build. */
export interface Progress {
  /** How many books on this shelf have text worth indexing. */
  readonly wanted: number
  /** Whether a sweep is running right now. */
  readonly sweeping: boolean
  /** Whether a sweep has finished since this process started. */
  readonly swept: boolean
}

const NOTHING: Progress = { wanted: 0, sweeping: false, swept: false }

/** What a book is called, or undefined when the shelf does not know. */
export type TitleOf = (bookId: string) => string | undefined

/** A holder the pane subscribes to. */
export interface ProgressHolder {
  get(): Progress
  set(next: Progress): void
  subscribe(listener: () => void): () => void
  /**
   * What a book is called — see the header. Answers `undefined` until the
   * capability has bound a lookup, and for a book the shelf no longer has.
   */
  titleOf: TitleOf
  /** Bind the shelf's lookup. Called once, from the capability's `start`. */
  bindTitles(lookup: TitleOf): void
}

export function makeProgress(): ProgressHolder {
  let held = NOTHING
  let titles: TitleOf = () => undefined
  const listeners = new Set<() => void>()
  return {
    /* READ THROUGH, not captured: the lookup is bound after this object is
     * made, and a captured one would answer `undefined` for ever. */
    titleOf: (bookId) => titles(bookId),
    bindTitles: (lookup) => {
      titles = lookup
    },
    get: () => held,
    set: (next) => {
      /* ⚠️ **NOTHING IS PUBLISHED WHEN NOTHING CHANGED.** `useSyncExternalStore`
       * re-renders per notification, and a sweep over 1 959 books would
       * otherwise redraw the Settings panel once per book for a number that
       * moved on one of them. */
      if (
        next.wanted === held.wanted &&
        next.sweeping === held.sweeping &&
        next.swept === held.swept
      ) {
        return
      }
      held = next
      /* ⚠️ **`notifyAll`, NOT A BARE LOOP — AND `notify.test.ts` REFUSED THE
       * BARE ONE BEFORE ANY OF THIS SHIPPED.** It copies the set, because a
       * listener may unsubscribe while being told and mutating a `Set`
       * mid-iteration skips another; the Settings panel is exactly that, since
       * it can unmount on the change it is hearing about. And it catches a
       * thrower, so one bad subscriber does not stop the rest being told. */
      notifyAll(listeners, 'passage index progress')
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** The app's own holder — one per process, like the port beside it. */
export const theProgress: ProgressHolder = makeProgress()

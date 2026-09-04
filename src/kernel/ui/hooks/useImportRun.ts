import { useCallback, useRef, useState } from 'react'
import { createHandover } from '../importHandover'
import type { ImportOutcome, ImportProgress } from '../../core/importFolder'

/**
 * The one import coordinator, shared by every route that copies books in.
 *
 * # The shape this exists to remove
 *
 * There are two ways in — a pick or a drop (`addAndOpen`) and a folder walk
 * (`addFolder`) — and each had written out the same six things: a generation
 * token, an abort controller, the progress bar's lifetime, a handover chained
 * one batch behind the copying, the settle that the notice waits on, and the
 * cleanup. Six pieces, twice, in one component, eight hundred lines apart.
 *
 * They had already drifted, in both directions:
 *
 * - the folder walk cleared its progress AFTER awaiting the shelf writes; the
 *   drop path cleared it in a `finally` that ran BEFORE, so every control came
 *   back while records were still being written.
 * - the drop path returned out of its loop when superseded, walking straight
 *   past the settle its own comment calls unconditional — so a superseded
 *   batch abandoned the write chain it was supposed to wait for.
 * - the folder walk refused to re-enter; the drop path superseded silently,
 *   so dropping a book during a walk killed that walk with nothing on screen.
 *
 * Every one of those is the same defect: two copies of a lifecycle, and no
 * single place that decides what a lifecycle is.
 *
 * # What a route still owns
 *
 * The WORK, and its own policy on a second one. Superseding versus refusing is
 * a genuine difference — a folder walk is expensive and was once started twice
 * by a keyboard shortcut, while dropping books is the reader saying "these
 * now" — so `busy` is exposed and the route decides. What is no longer a
 * choice is whether the bar, the token, the signal and the settle behave the
 * same way, because they are not written twice any more.
 */

/** One running import, as the work that produces it sees it. */
export interface ImportRun {
  /**
   * Whether this run is still the current one.
   *
   * Checked after every await. A superseded run must stop REPORTING at once —
   * but see `shelve`, which it must go on doing.
   */
  current(): boolean
  /** The signal the work must honour, so a superseded run stops COPYING too. */
  readonly signal: AbortSignal
  /**
   * Hand one copied book over to be shelved, one batch behind.
   *
   * ⚠️ **UNCONDITIONAL, even when superseded.** A run that has been replaced
   * still copied these bytes, and a copy with no shelf record is invisible to
   * the library and to removal alike — an orphan on disk nobody can reach.
   * The token governs the NOTICE, never the bookkeeping.
   */
  shelve(outcome: ImportOutcome): void
  /** Report progress. Ignored once superseded. */
  report(progress: ImportProgress): void
}

export interface Imports {
  /** The running import's progress, or null. */
  readonly progress: ImportProgress | null
  /** True while an import is running — what a route reads to decide policy. */
  readonly busy: boolean
  /**
   * Retire whatever is running, without starting anything.
   *
   * ⚠️ **EVERY INTAKE SUPERSEDES, NOT ONLY EVERY BATCH.** The token used to be
   * taken inside the multi-book branch, so a single-file pick or drop advanced
   * nothing — a folder walk already running was therefore still current when
   * it finished, and its closing `openBook` ran AFTER the single book the
   * reader had just asked for, leaving them in the older one. One book is as
   * much an intake as a thousand; what is being superseded is "which book
   * opens last", which every intake decides.
   */
  supersede(): void
  /**
   * Run one import, superseding whatever was running.
   *
   * `work` returns the outcomes to summarise. Whatever it throws is passed to
   * `onFailure` — the two routes word that differently — and the lifecycle is
   * closed either way.
   *
   * SO IS A SHELF WRITE THAT REJECTS. The settle is part of the lifecycle and
   * not part of the work, and it used to be the one failure that escaped:
   * `onFailure` was never called, the bar never came down, and this promise
   * rejected instead. It does not reject any more, for any reason a caller
   * can produce — every ending goes out through `onFailure` or the notice.
   *
   * RESOLVES WHETHER THE RUN WAS STILL CURRENT ONCE THE SETTLE HAD FINISHED.
   * `run.current()` inside the work answers for the copying; a supersession
   * that lands during the shelf writes after it came after the last answer
   * the work could take, and a caller opening the book it just added was
   * reading a freshness that had gone stale in that window.
   */
  run(
    work: (run: ImportRun) => Promise<readonly ImportOutcome[]>,
    say: {
      /** Turn the outcomes and the unsaved count into the reader's sentence. */
      summarise: (outcomes: readonly ImportOutcome[], unsaved: number) => string
      onFailure: (cause: unknown) => void
    },
  ): Promise<boolean>
}

export interface ImportRunOptions {
  /** Write a batch of outcomes to the shelf; answers how many did not land. */
  readonly shelve: (outcomes: readonly ImportOutcome[]) => Promise<number>
  /** How many books to shelve per write — see `createHandover`. */
  readonly batch: number
  readonly notice: (text: string) => void
}

export function useImportRun({ shelve, batch, notice }: ImportRunOptions): Imports {
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  /* A ref rather than state: it is read inside a running loop, where a
     re-render's stale closure is exactly the thing that must not happen. */
  const generation = useRef(0)
  /* The batch token makes a superseded import stop REPORTING; this is what
     makes it stop WORKING — the walk takes the signal and checks it between
     books. */
  const abort = useRef<AbortController | null>(null)
  /**
   * Which generation the progress bar belongs to.
   *
   * ⚠️ **A BARE `supersede()` LEFT THE BAR UP FOR THE REST OF THE SESSION.**
   * A retiring run returns before `setProgress(null)` — it must, or it would
   * pull down the bar its REPLACEMENT has already raised — and that reasoning
   * silently assumed every supersession comes from another `run`. It does not:
   * a single-book pick or drop supersedes without running anything, so nobody
   * owned the bar and nobody took it down. `busy` stayed true, the folder
   * route refuses to start while busy, and every later import was refused.
   *
   * A run claims the bar when it raises it; the retiring run clears it only
   * while the claim is still its own.
   */
  const bar = useRef(0)

  /* A NEW INTAKE RETIRES THE OLD ONE'S WORK, not just its reporting: the
     token stops it REPORTING and the signal stops it COPYING. */
  const supersede = useCallback((): void => {
    abort.current?.abort()
    abort.current = null
    generation.current += 1
  }, [])

  const run = useCallback<Imports['run']>(
    async (work, say) => {
      supersede()
      const controller = new AbortController()
      abort.current = controller
      const mine = generation.current
      const current = (): boolean => generation.current === mine

      bar.current = mine
      setProgress({ done: 0, total: 0 })
      const handed = createHandover<ImportOutcome>(batch, shelve)
      let outcomes: readonly ImportOutcome[] = []
      let failed: { cause: unknown } | null = null
      try {
        outcomes = await work({
          current,
          signal: controller.signal,
          shelve: (outcome) => handed.add(outcome),
          report: (next) => {
            if (current()) setProgress(next)
          },
        })
      } catch (cause) {
        failed = { cause }
      }

      /* FLUSHED AND SETTLED ON EVERY PATH, superseded or failed included: the
         bytes are on disk either way, and leaving them recordless is the
         orphan this pipeline exists to avoid. */
      handed.flush()
      /* ⚠️ AND THE SETTLE ITSELF CAN REJECT, WHICH IS STILL THIS LIFECYCLE'S
         TO CLOSE. `settled()` is a chain of `shelve` calls, so one rejected
         shelf write threw straight out of `run` — past `setProgress(null)`,
         past `onFailure`, past everything below. The bar stayed on screen and
         `busy` stayed true for the rest of the session: the folder route
         refuses to start while busy, so it refused every later import, and the
         drop route went on superseding a run that had already finished. A
         terminal catch at the call site caught the rejection and said so; it
         could not put the bar away, because the state lives in here.

         FOLDED INTO THE SAME `failed` THE WORK USES, so a settle failure is
         reported through `onFailure` exactly like a copy failure — one
         sentence to the reader either way. The work's cause wins when both
         fail, because it is the one that explains the other; the second is
         logged rather than dropped. */
      let unsaved = 0
      try {
        unsaved = await handed.settled()
      } catch (cause) {
        if (failed === null) failed = { cause }
        else console.error('Paper: the import also failed to record what it copied', cause)
      }

      /* ⚠️ CLEARED AFTER THE SHELF WRITES LAND, NOT BEFORE THEM. One route had
         this in a `finally` that ran before the settle, so the bar went away
         and every control came back while records were still being written —
         the reader could start a second import into a shelf the first had not
         finished writing. The bar is what says "this is still happening". */
      if (abort.current === controller) abort.current = null
      if (!current()) {
        /* Superseded, so this run says nothing — but the bar is not a thing it
           says, it is a thing it raised. Cleared only while the claim is still
           this run's: a replacement `run` has already raised its own, and
           pulling that one down is what the bare return was protecting. See
           `bar`. */
        if (bar.current === mine) setProgress(null)
        return false
      }
      setProgress(null)
      /* The caller's own callbacks, guarded: `run` promises never to reject,
         and a `summarise` that throws is a caller's bug, not a reason to
         break that promise for every caller. */
      try {
        if (failed !== null) say.onFailure(failed.cause)
        else notice(say.summarise(outcomes, unsaved))
      } catch (cause) {
        console.error('Paper: the import could not say what it did', cause)
      }
      return true
    },
    [shelve, batch, notice, supersede],
  )

  return { progress, busy: progress !== null, supersede, run }
}

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
  /**
   * True while the bar is up, AS OF THE LAST RENDER — for drawing.
   *
   * ⚠️ **NOT FOR ADMISSION, AND IT WAS** (2026-09-13 audit, #98, round 3). This
   * said "what a route reads to decide policy", and the folder route read it
   * before its picker and again after it. State lags: two choices landing in
   * one turn both read the render from before either had raised the bar. A
   * route deciding policy asks `reserve` or `supersede`, which answer as of
   * the moment they are called.
   */
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
   *
   * ANSWERS WHETHER IT RETIRED AN IMPORT WHOSE BAR WAS UP, as of now, so a
   * route can say what it replaced. The drop route read `busy` for that, and a
   * run started in the same turn was replaced in silence (round 3, #98).
   */
  supersede(): boolean
  /**
   * Retire whatever is running AND WAIT FOR IT TO LET GO — what a teardown
   * needs, where `supersede` is what a newer intake needs.
   *
   * ⚠️ **THE SHUTDOWN DRAINED THE WRITE QUEUE AND NEVER ASKED THE IMPORT**
   * (2026-09-13 audit, #96). A copy in flight goes on copying while the window
   * closes, and the handover is chained one batch BEHIND the copying — so the
   * books already copied had their shelf writes queued after the drain had
   * finished, or not queued at all. The bytes land on disk with no record: a
   * book the library cannot see and removal cannot reach.
   *
   * The abort is immediate; the promise resolves once the run has flushed its
   * handover and settled it, which is the point at which there is nothing left
   * for a drain to miss. It resolves rather than rejects — `run` never rejects
   * — and resolves at once when nothing is running.
   *
   * ⚠️ **EVERY RUN, AND NOTHING AFTER** (round 3, #96). It waited on the newest
   * run's promise only, so a run a later one had superseded — still flushing
   * what it copied — was abandoned to the drain; and it left the coordinator
   * taking work, so a drop landing while the window closed started a copy
   * after the teardown had been told the import was stopped. It waits for
   * every run still settling now, and from its first call `run` and `reserve`
   * refuse for the rest of this coordinator's life: the teardown it serves
   * ends the window.
   */
  stop(): Promise<void>
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
  /**
   * Hold the next run across an await — for a route that REFUSES a second
   * import rather than superseding one. `null` while a run's bar is up, while
   * another reservation is held, or once stopped.
   *
   * ⚠️ **A RESERVATION, BECAUSE A READ IS NOT ONE** (2026-09-13 audit, #98,
   * round 3). The folder route read `busy` before its picker and again after
   * it; `busy` is state, and two choices landing in one turn both read the
   * render from before either had started — so the second superseded the run
   * the first had been admitted to. Taken before the await and spent by its
   * own `run`, in the same synchronous turn as the check, nothing between the
   * two can read a stale answer.
   */
  reserve(): ImportReservation | null
}

/** The next run, held for one route — see `Imports.reserve`. */
export interface ImportReservation {
  /**
   * Spend it on a run. `null`, running nothing, when any intake has come since
   * it was taken — the drop route supersedes rather than reserving, so one can
   * start while the reader is choosing, and FINISH, which is still an import
   * the choice was made before — when it was released, or once stopped. Spent
   * either way.
   */
  run(work: Parameters<Imports['run']>[0], say: Parameters<Imports['run']>[1]): Promise<boolean> | null
  /** Give it back unspent — a cancelled picker. Idempotent. */
  release(): void
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

  /* THE BAR, AS OF NOW — `progress !== null` without waiting for the render
     that draws it. What `reserve` and `supersede` answer from; see `busy`. */
  const raised = useRef(false)
  /* The one route holding the next run — see `reserve`. */
  const reserved = useRef<object | null>(null)
  /* Set by `stop`, for the rest of this coordinator's life — see `stop`. */
  const stopped = useRef(false)

  /* A NEW INTAKE RETIRES THE OLD ONE'S WORK, not just its reporting: the
     token stops it REPORTING and the signal stops it COPYING. */
  /* Stryker disable ArrayDeclaration: its empty dependency list is the only
     array in it, and it reads only refs, which never change — a list holding one
     constant re-creates it no more often, so no test can tell the two apart. */
  const supersede = useCallback((): boolean => {
    const replaced = raised.current
    abort.current?.abort()
    abort.current = null
    // Stryker disable next-line AssignmentOperator: the generation is only ever compared for equality, with a value it held after an intake, and a count stepping down never repeats any more than one stepping up does.
    generation.current += 1
    return replaced
  }, [])
  // Stryker restore ArrayDeclaration

  /**
   * EVERY run still settling, as something to WAIT for — see `stop`.
   *
   * The lifecycle's own promises rather than a second flag: each settles
   * exactly when its handover has been flushed and settled, which is what a
   * teardown has to outlast. Never rejects, because `run` does not.
   *
   * ⚠️ **A SET, AND IT WAS ONE PROMISE** — the newest run's (round 3, #96). A
   * run superseded by a later one is still shelving what it copied, and a
   * teardown that waited for the newest let the drain go under it.
   */
  const running = useRef(new Set<Promise<boolean>>())

  const perform = useCallback<Imports['run']>(
    async (work, say) => {
      supersede()
      const controller = new AbortController()
      abort.current = controller
      const mine = generation.current
      const current = (): boolean => generation.current === mine

      bar.current = mine
      raised.current = true
      setProgress({ done: 0, total: 0 })
      const handed = createHandover<ImportOutcome>(batch, shelve)
      // Stryker disable next-line ArrayDeclaration: only the summary reads this, and it runs only when nothing failed — so the work returned, and its outcomes replaced this seed before anything could read it.
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
         orphan this pipeline exists to avoid. `settled()` hands over what is
         pending before it waits — `importHandover.test.ts` pins that — so the
         `handed.flush()` that stood here handed over nothing, and went. */
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
        if (bar.current === mine) {
          raised.current = false
          setProgress(null)
        }
        return false
      }
      raised.current = false
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

  /* THE ONE PLACE THE RUN'S OWN PROMISE IS HELD. An async function cannot
     record the promise it is itself producing, so the lifecycle stays whole in
     `perform` and this thin wrapper is what `stop` has something to wait on. */
  const run = useCallback<Imports['run']>(
    (work, say) => {
      /* NOTHING NEW ONCE STOPPED — see `stop`. False, as a run that was
         superseded before it could say anything answers. */
      if (stopped.current) return Promise.resolve(false)
      const started = perform(work, say)
      running.current.add(started)
      // Stryker disable next-line ArrowFunction: only a promise that has settled is deleted, and one left behind is found already settled by `stop`'s `Promise.all` — which resolves as it would without it, a microtask later; nothing else reads the set.
      void started.then(() => running.current.delete(started))
      return started
    },
    [perform],
  )

  const stop = useCallback(
    async (): Promise<void> => {
      stopped.current = true
      supersede()
      await Promise.all([...running.current])
    },
    // Stryker disable next-line ArrayDeclaration: `supersede` is memoised over nothing and never changes, so listing it re-creates nothing and leaving it out keeps the same one.
    [supersede],
  )

  const reserve = useCallback((): ImportReservation | null => {
    if (stopped.current || raised.current || reserved.current !== null) return null
    const mine = {}
    reserved.current = mine
    /* ⚠️ **THE GENERATION IT WAS TAKEN AT, NOT WHETHER A BAR IS UP WHEN IT IS
       SPENT** (2026-09-14, #98, round 4). It refused on `raised`, which answers
       for the import running NOW — so a drop that started and finished while
       the reader was choosing left the bar down, and the stale choice started a
       walk behind it. Every intake advances the generation, a run and a bare
       `supersede` alike, and so does `stop`: one comparison answers for all of
       them, the run still up included, since a reservation is never granted
       while one is. */
    const taken = generation.current
    const release = (): void => {
      if (reserved.current === mine) reserved.current = null
    }
    return {
      release,
      run: (work, say) => {
        const held = reserved.current === mine
        release()
        /* THE CHECK AND THE RUN IN ONE TURN: `run` raises the bar before it
           returns, so nothing can be admitted between the two. */
        return held && generation.current === taken ? run(work, say) : null
      },
    }
  }, [run])

  return { progress, busy: progress !== null, supersede, stop, run, reserve }
}

/**
 * The downloads in flight, which OUTLIVE the pane that started them.
 *
 * ⚠️ **A 2.3 GB DOWNLOAD MUST NOT BELONG TO A PANEL.** The pane held its own
 * `AbortController` per pack and its own progress in React state, so closing
 * Settings — or a hot reload, which is how this was first seen on 2026-09-23 —
 * threw all of it away while the plugin went on fetching. Reopening showed
 * **Download** on a pack that was half here, with no progress and no way to
 * stop it. The download itself was never at risk; what was lost was every
 * means of seeing or ending it.
 *
 * ⚠️ **AND IT MUST NOT BE CANCELLED ON UNMOUNT EITHER**, which is the other
 * obvious answer and the wrong one: a reader who opens Settings, starts the
 * Chinese pack and goes back to their book has not changed their mind.
 *
 * Module-level, like `sync`'s storage model, because the thing it describes is
 * the app's and not a view's.
 */

import { notifyAll, type InstallProgress } from '../../../kernel'
import { StopFailed } from './port'

/**
 * What a reader is told when they stop a download themselves.
 *
 * ⚠️ **HERE AND NOT IN THE PANE, BECAUSE ONLY THIS KNOWS WHO ASKED.** The pane
 * used to read `signal.aborted` to tell a stop from a failure; the signal
 * belongs to the registry now, so the translation does too — and it is done
 * where a `StopFailed` can be told apart from it, which is the one case where
 * "Nothing was left half-installed" would be false.
 */
export const STOPPED = 'Download stopped. Nothing was left half-installed.'

/** What a reader is told about one pack, whether or not a pane is open. */
export interface Download {
  readonly progress: InstallProgress | null
  readonly error: string | null
}

/** Every pack with something to say about it. */
export type DownloadStates = Readonly<Record<string, Download>>

export interface Downloads {
  /** What every pack is doing. A new object whenever anything changes. */
  states(): DownloadStates
  /**
   * Run a download, or join the one already running for this pack.
   *
   * Joining rather than starting a second is the point: two panes, or one pane
   * mounted twice across a reload, must not fetch the same gigabytes twice.
   */
  begin(
    packId: string,
    bytes: number,
    run: (report: (p: InstallProgress) => void, signal: AbortSignal) => Promise<void>,
  ): Promise<void>
  /** Ask the download for this pack to stop, if there is one. */
  stop(packId: string): void
  /** Forget what a finished pack said, so a retry starts clean. */
  clear(packId: string): void
  /** Called whenever `states()` would answer differently. Returns an unsubscribe. */
  watch(listener: () => void): () => void
}

/** Make a registry. One per app; `theDownloads` is that one. */
export function makeDownloads(): Downloads {
  let states: DownloadStates = {}
  const running = new Map<string, { controller: AbortController; work: Promise<void> }>()
  const listeners = new Set<() => void>()

  const publish = (packId: string, state: Download | null) => {
    const next = { ...states }
    if (state) next[packId] = state
    else delete next[packId]
    states = next
    /* ⚠️ **`notifyAll`, NOT A LOOP OF MY OWN.** Calling each subscriber
       straight out of a loop was found and fixed in five files before anybody
       wrote this helper, and in four more after — a throwing subscriber
       silences every later one and throws back into the operation that had
       already succeeded. `notify.test.ts` walks `src/` for that shape and
       found this file the first time it ran.

       ⚠️ **AND THEN FOUND THIS COMMENT**, which spelled the loop out: the walk
       reads raw source, so prose about the rule breaks the rule. The same
       lesson `test-environment.test.mjs` records — when explaining a shape a
       scanner looks for, do not write the shape. */
    notifyAll(listeners, 'voice download')
  }

  return {
    states: () => states,
    begin(packId, bytes, run) {
      const already = running.get(packId)
      if (already) return already.work
      const controller = new AbortController()
      /* Seeded with the size the catalogue already states, so the first line a
         reader sees is "0 MB of 2.3 GB" rather than a count with no whole. */
      publish(packId, { progress: { kind: 'downloading', received: 0, total: bytes }, error: null })
      const work = run(
        (progress) => {
          /* Only while it is OURS. A report arriving after a stop would put a
             progress line back under a row that has finished with it. */
          if (running.get(packId)?.controller === controller) publish(packId, { progress, error: null })
        },
        controller.signal,
      )
      const done = work.then(
        () => {
          running.delete(packId)
          publish(packId, { progress: null, error: null })
        },
        (cause: unknown) => {
          running.delete(packId)
          publish(packId, { progress: null, error: whyItEnded(cause, controller.signal) })
          throw cause
        },
      )
      /* ⚠️ **ONE `set`, AND THERE WERE TWO.** The first stored the raw promise
         and was overwritten by this line in the same synchronous run — nothing
         between them can observe it, so it was a write no test could ever
         reach. What the registry keeps is the SETTLED promise, so a second
         `begin` joins this work and sees its outcome rather than attaching a
         second pair of handlers to the raw one. */
      running.set(packId, { controller, work: done })
      return done
    },
    stop(packId) {
      running.get(packId)?.controller.abort()
    },
    clear(packId) {
      if (running.has(packId)) return
      publish(packId, null)
    },
    watch(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * The app's registry.
 *
 * ⚠️ **MODULE-LEVEL ON PURPOSE.** A download that belongs to a React tree dies
 * with it, which is the defect this file exists for. `makeDownloads` is
 * exported so a case gets its own and they cannot leak into each other.
 */
export const theDownloads = makeDownloads()

/**
 * What to tell a reader about a download that did not finish.
 *
 * A stop is the reader's own doing, so it says so rather than reading as a
 * failure — but only where the stop actually worked. `StopFailed` is the port's
 * answer for a stop the plugin refused, which leaves the download running to
 * completion; saying nothing was left half-installed over that is the one
 * sentence here that would be false.
 */
function whyItEnded(cause: unknown, signal: AbortSignal): string {
  if (cause instanceof StopFailed) return cause.message
  if (signal.aborted) return STOPPED
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Searching an open book, as a stream of plain hits.
 *
 * Out of `session.ts` because it holds none of the session's state: it is
 * handed the view and the abort signal, and everything it knows about foliate's
 * search is here.
 */

import type { SearchYield, View } from 'foliate-js/view.js'

/** One hit, flattened from foliate's mixed yield shapes. */
export interface SearchHit {
  readonly cfi: string
  readonly label: string
  readonly pre: string
  readonly match: string
  readonly post: string
}

/**
 * Flatten foliate's search stream into plain hits.
 *
 * It yields four different shapes — a progress record, a per-section group, a
 * bare hit, and finally the string 'done' — so the shape has to be narrowed
 * before anything downstream can render it. Section labels arrive on the group
 * and are carried onto the hits inside it, which is what lets a result say
 * which chapter it came from.
 */
export async function* runSearch(
  view: View,
  query: string,
  signal: AbortSignal,
): AsyncGenerator<SearchHit> {
  let label = ''
  /* Checked BEFORE the iterator exists. `view.search()` clears foliate's own
   * results and starts walking the book, so entering it on an already-aborted
   * signal threw away the results still on screen and began work whose every
   * outcome is discarded. The caller aborts on each keystroke, so this is the
   * common path, not the rare one. */
  if (signal.aborted) return

  const results = view.search({ query })
  /* Raced against the abort, because an abort arriving while this is parked on
   * the next result would otherwise not be seen until that result arrived — so
   * the loop ran on after cancellation. The race lets the loop stop at once.
   * Closing foliate's generator, in the `finally`, still waits for the step it
   * is on: an async generator's pending step is the one thing nothing outside
   * it can interrupt. */
  const stopped = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))

  try {
    for (;;) {
      const step = (await Promise.race([results.next(), stopped])) as IteratorResult<SearchYield, void>
      /* THE SIGNAL, NOT ONLY THE RACE. An abort can lose the race and still
       * have happened — a result that settled in the same turn wins it — and
       * `stopped` settling is only ever an abort, so asking the signal covers
       * both roads out. It is also what makes the cast sound: with the signal
       * clear, `results.next()` is what won. */
      if (signal.aborted || step.done) return
      const result = step.value
      /* Only an object can be asked `in`. Everything else foliate yields
       * besides hits — `{ progress }`, and the closing `'done'` — has neither
       * `subitems` nor `cfi`, so it falls through both tests below and needs no
       * case of its own. */
      if (typeof result !== 'object' || result === null) continue
      if ('subitems' in result) {
        label = result.label ?? ''
        for (const hit of result.subitems) {
          if (signal.aborted) return
          yield toHit(hit, label)
        }
        continue
      }
      if ('cfi' in result) yield toHit(result, label)
    }
  } finally {
    await results.return(undefined)
  }
}

function toHit(
  raw: { cfi: string; excerpt: { pre: string; match: string; post: string } },
  label: string,
): SearchHit {
  return {
    cfi: raw.cfi,
    label,
    pre: raw.excerpt?.pre ?? '',
    match: raw.excerpt?.match ?? '',
    post: raw.excerpt?.post ?? '',
  }
}

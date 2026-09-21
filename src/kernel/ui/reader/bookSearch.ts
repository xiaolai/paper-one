/**
 * Searching an open book, as a stream of plain hits.
 *
 * Out of `session.ts` because it holds none of the session's state: it is
 * handed the view and the abort signal, and everything it knows about foliate's
 * search is here.
 */

import type { View } from 'foliate-js/view.js'

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
 * It yields four different shapes — a progress number, a per-section group, a
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
  /* Closed on the way out, however we leave. A `for await` that returns early
   * does call `results.return()`, but an abort arriving while we are parked on
   * the next result is not observed until that result arrives — so the search
   * runs on after cancellation. Racing the iterator against the abort lets the
   * cancellation win immediately, and `finally` closes the generator foliate
   * gave us rather than leaving it walking the book. */
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })

  try {
    for (;;) {
      const step = await Promise.race([results.next(), aborted])
      if (step === 'aborted' || step.done) return
      const result = step.value
      if (signal.aborted) return
      if (result === 'done') return
      if (typeof result !== 'object' || result === null) continue
      if ('progress' in result) continue
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
    await results.return?.(undefined)
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

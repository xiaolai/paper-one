/**
 * Standing aside, for a pass that has work to do and no reason to hurry.
 *
 * Two background passes fill a freshly imported library in: the enrichment
 * pass parses every book for its title, author and jacket, and sync's
 * backfill hashes every book's bytes. Both are long, both are unwatched, and
 * both must yield to a reader who is scrolling a shelf or turning a page.
 *
 * BOTH USED A FIXED SLEEP, and that is the wrong shape for the job. A sleep
 * pays the same price whether the app is busy or completely idle, so its
 * length has to be chosen as a compromise between "gets out of the way" and
 * "finishes this decade" — and at two thousand books the compromise lands
 * badly at both ends. The enrichment pass spent 120ms per book standing aside
 * from nothing at all, which is nearly four minutes of an idle app doing
 * nothing; sync's backfill rested three seconds between every four books,
 * which is twenty-five minutes for a library this size.
 *
 * What both actually wanted was IDLE, which is a thing the platform can
 * answer and a timer cannot. `requestIdleCallback` returns as soon as the
 * main thread has nothing better to do and defers while it has — so the pass
 * runs flat out when the reader is not there and backs off the instant they
 * are, without either behaviour being guessed at in advance.
 *
 * The ceiling is what keeps it honest in the other direction: an app that
 * never goes idle would otherwise starve the pass for ever, and a library
 * that never finishes filling in is worse than one that fills in slowly.
 */

/** `requestIdleCallback`, as much of it as this module uses. */
type IdleRequest = (callback: () => void, options?: { timeout: number }) => unknown

/**
 * Resolve when the main thread is free, or when `ceilingMs` has passed —
 * whichever comes first.
 *
 * FALLS BACK TO THE OLD SLEEP where `requestIdleCallback` is missing, which
 * is jsdom and any WebView old enough not to carry it. That is deliberately
 * the previous behaviour exactly: a platform this cannot ask about is a
 * platform whose passes should keep the pacing they were tuned with, and it
 * means the fallback path is the one the tests exercise, so their timing
 * stays as predictable as it was.
 *
 * Never rejects. A breath that could fail would need a caller that handled
 * failing to wait, which is not a thing a caller can do.
 */
export function breathe(ceilingMs: number): Promise<void> {
  const idle = (globalThis as { requestIdleCallback?: IdleRequest }).requestIdleCallback
  if (typeof idle !== 'function') {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ceilingMs)
    })
  }
  return new Promise<void>((resolve) => {
    idle(() => resolve(), { timeout: ceilingMs })
  })
}

/**
 * Resolve no sooner than `floorMs`, and then not until the thread is free.
 *
 * For a pass whose work is NOT on the main thread — sync's backfill hashes in
 * Rust — where idleness alone is the wrong gate: an idle app grants an idle
 * callback every frame, so a pass that only waited for idle would read the
 * whole library off disk as fast as the disk could serve it. The floor is the
 * rate limit; the idle wait on top of it is the courtesy.
 *
 * The ceiling applies to the idle wait, so the longest this can take is
 * `floorMs + ceilingMs`.
 */
export async function restThenBreathe(floorMs: number, ceilingMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, floorMs)
  })
  await breathe(ceilingMs)
}

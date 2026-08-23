import type { CapabilityContext } from './capability'

/**
 * Everything a capability's `start` acquired, released once and in order.
 *
 * # The shape this exists to remove
 *
 * Both shipped capabilities that hold resources wrote the same thirty lines: a
 * `stopped` flag, a `signal.removeEventListener`, a hand-rolled try/catch per
 * teardown step, and a list of nullable `let`s to release. And both got it
 * wrong in their own way — one ran a `dispose()` bare after the guarded step,
 * so a throw there escaped the abort listener with `stopped` already true (the
 * registry's later cleanup then returns immediately and can neither retry nor
 * report it); the other simply forgot a resource for months, which is the
 * defect that showed the ownership was too hard to audit by reading.
 *
 * Both are the same missing thing: nothing owned the list.
 *
 * # What it guarantees
 *
 * - **Released once.** `stop` is idempotent, and it detaches its own abort
 *   listener, so a stop that arrives twice — `onCleanup` and an abort — does
 *   the work once.
 * - **Every step runs.** A step that throws is reported by name through the
 *   capability's own diagnostics and the rest still run. A teardown that stops
 *   at its first failure leaks everything after it.
 * - **Reverse order.** Last acquired, first released — a resource taken later
 *   may depend on one taken earlier, and never the other way round.
 */
export interface CapabilitySession {
  /**
   * Register something to release, by a name a diagnostic can carry.
   *
   * `release` may be null-returning or throw; both are handled.
   */
  own(label: string, release: () => void): void
  /** Release everything, once. */
  stop(): void
}

/**
 * Open a session bound to `api.onCleanup` and `signal`.
 *
 * `event` names the diagnostic a failed step is reported under —
 * `<capability>.teardown-step-failed`, which is what both call it already.
 */
export function openSession(api: CapabilityContext, signal: AbortSignal, event: string): CapabilitySession {
  const steps: { label: string; release: () => void }[] = []
  let stopped = false

  const stop = (): void => {
    if (stopped) return
    stopped = true
    signal.removeEventListener('abort', stop)
    /* Reverse: the last thing taken may depend on an earlier one. */
    for (const { label, release } of [...steps].reverse()) {
      try {
        release()
      } catch (error) {
        /* REPORTED AND CONTINUED. A teardown that stops at its first failure
           leaks every resource after it, and the failure surfaces as an
           unhandled error during shutdown naming nothing. */
        api.diagnostics.warn(event, {
          label,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    steps.length = 0
  }

  api.onCleanup(stop)
  signal.addEventListener('abort', stop, { once: true })
  return {
    own: (label, release) => {
      /* A resource acquired AFTER teardown has run belongs to nobody, so it is
         released at once rather than recorded into a list nothing will read
         again. `start` throwing part-way is the case this covers. */
      if (stopped) {
        release()
        return
      }
      steps.push({ label, release })
    },
    stop,
  }
}

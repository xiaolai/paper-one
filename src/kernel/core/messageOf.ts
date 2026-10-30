/**
 * Whatever text a rejection carries, from either shape it arrives in.
 *
 * ⚠️ **`String(cause)` IS NOT ENOUGH, and it is the trap this exists to avoid:**
 * a plugin rejection is `{ kind, message }`, a plain object, so `String` gives
 * `[object Object]` — throwing away the exact sentence the log is being written
 * to preserve. The `Error` branch alone has the mirror problem, since that
 * object is not an `Error` either.
 *
 * MEASURED, not inferred. `plugin:peer|peer_circle_mine` on a device with no
 * circle role rejects with:
 *
 * ```json
 * { "kind": "identity", "message": "this device has no circle role" }
 * ```
 *
 * — a perfectly good sentence, and every caller using the idiom above printed
 * `[object Object]` instead.
 *
 * ## Why this is in the KERNEL and not beside its first caller
 *
 * ⚠️ **IT WAS WRITTEN ONCE, CORRECTLY, AND THEN REINVENTED WRONG THREE TIMES —
 * because it was confined where nobody else could reach it.** It lived inside
 * one capability, and a capability may not import from another, so a second
 * grew a local copy that was the `Error`-only half, and a third spelled the
 * broken idiom inline at **22 sites**.
 *
 * Those copies are how `circle.shelf.publish-failed` and
 * `circle.opinion.publish-failed` came to record `message: "[object Object]"`
 * in `diagnostics.jsonl` — the surface written for the express purpose of
 * saying what went wrong, saying nothing. Found 2026-09-05 by reading the
 * Marginalia pane of a running app, which showed a reader the same string.
 *
 * Its own header already said *"ONE COPY. This sat in six modules as two
 * different implementations."* It was right about the disease and wrong about
 * the cure: one copy per capability is not one copy. The kernel is the only
 * place every caller can reach.
 */
/**
 * What is returned when the rejection cannot be described at all.
 *
 * A sentence rather than an empty string, because this lands in a log line and
 * in reader-facing copy, and "" there reads as a bug in the caller.
 */
export const UNDESCRIBABLE = 'an error that could not be described'

export function messageOf(cause: unknown): string {
  /* ⚠️ **NOTHING IN HERE MAY THROW.** This runs in `catch` blocks and in
   * rejection handlers, so a throw would replace the error being reported with
   * a second one and lose the first. Two real inputs do throw: a `message`
   * getter that throws, and `Object.create(null)`, which has no `toString` and
   * makes `String(cause)` throw. Both were found by audit, both reproduced.
   *
   * ⚠️ **AND THE TWO STEPS ARE GUARDED SEPARATELY, which one `try` around the
   * whole function got wrong.** A throwing `message` getter jumped straight to
   * the outer `catch`, so an object whose `toString()` said something perfectly
   * useful was reported as undescribable — the extraction failing took the
   * fallback down with it. Reading and converting are two failures, not one. */
  let message: unknown
  try {
    /* NO SEPARATE `Error` BRANCH: an `Error` IS an object, so this reads
     * `err.message` for it too, and one path means one set of rules. */
    if (typeof cause === 'object' && cause !== null) message = (cause as { message?: unknown }).message
  } catch {
    /* The getter threw. `message` stays undefined and the value itself is
       still worth asking. */
  }

  /* ⚠️ **READ ONCE, THEN DECIDE — the check and the return must not be two
   * reads.** `typeof cause.message === 'string' ? cause.message : …` calls the
   * getter twice, and a getter that answers a string and then a number returns
   * the NUMBER from a signature promising a string. Reproduced by audit. */
  if (typeof message === 'string') return message

  /* A NON-STRING PRIMITIVE MESSAGE IS COERCED, and that is not tidiness: two
   * hand-rolled copies this replaced spelled `String(x?.message ?? x)`, so
   * `{ message: 503 }` read "503". Folding them in without this made a status
   * code render as `[object Object]` — narrowing the behaviour of the thing
   * being unified, which is the one outcome a unification must not have. */
  if (message !== undefined && message !== null && typeof message !== 'object' && typeof message !== 'function') {
    try {
      return String(message)
    } catch {
      /* A symbol-like message that will not convert. Fall through to the value. */
    }
  }

  try {
    return String(cause)
  } catch {
    return UNDESCRIBABLE
  }
}

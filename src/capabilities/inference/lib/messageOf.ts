/**
 * Whatever text a rejection carries, from either shape it arrives in.
 *
 * ⚠️ `String(cause)` IS NOT ENOUGH, and it is the trap this exists to avoid: a
 * plugin rejection is `{ kind, message }`, a plain object, so `String` gives
 * `[object Object]` — throwing away the exact sentence the log is being written
 * to preserve. The `Error` branch alone has the mirror problem, since that
 * object is not an `Error` either.
 *
 * ONE COPY. This sat in six modules as two different implementations — four
 * of them the `Error`-only half — and the cancel log in `plugin.ts` and the
 * kind-less path in `glossProvider.ts` each used `String(cause)` directly,
 * which is the defect the richer copy was written against.
 */
export function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'object' && cause !== null) {
    const { message } = cause as { message?: unknown }
    if (typeof message === 'string') return message
  }
  return String(cause)
}

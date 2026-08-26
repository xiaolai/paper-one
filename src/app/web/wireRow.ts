/**
 * Reading somebody else's JSON, one field at a time.
 *
 * ## Why this file exists
 *
 * Three of this client's four stores parsed a wire answer by checking one or
 * two fields and then casting the rest:
 *
 *     if (typeof row['id'] !== 'string' || row['id'] === '') continue
 *     out.push(asMark(row as unknown as MarkRow))
 *
 * The cast is the bug. `asMark` copies thirteen fields straight across, so a
 * `text` that arrived as an object, a `createdAt` that arrived as a string, or
 * a `kind` the client has never heard of all reached React — which renders an
 * object child by throwing, sorts a string timestamp lexically, and switches on
 * an unknown kind by falling through to nothing. The row LOOKED valid because
 * the one field anybody had thought about was.
 *
 * `books.ts` already did it properly, field by field, with a note explaining
 * why a coerced value is worse than a missing one. This is that idiom, shared,
 * so the other stores cannot drift from it.
 *
 * ## Null for the wrong type, never a coerced value
 *
 * `String(x)` on a number turns a shelf that disagrees with this client about
 * the wire into a plausible-looking row. The disagreement is the thing worth
 * seeing: it means one side has been upgraded and the other has not, and a
 * silently repaired row hides that until something downstream behaves oddly for
 * a reason nobody can trace back here.
 */

/** A string, or null for anything else. */
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** A finite number, or null. `NaN` and `Infinity` are not numbers a row means. */
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** Every string in an array, or none — never a partially-typed list. */
export const strings = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/**
 * A value from a CLOSED set, or null.
 *
 * The set is the client's own idea of the domain, so a value the shelf has
 * added since this build shipped reads as unknown rather than as itself. That
 * is the honest answer: this client cannot render a kind it has no case for.
 */
export const oneOf = <T extends string>(allowed: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null

/** A non-empty string — an identity field, which an empty string is not. */
export const id = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null

/**
 * Keep only the first row for each id.
 *
 * ⚠️ **A DUPLICATE ID IS NOT A HARMLESS DUPLICATE.** Every list in this client
 * is keyed on it, and React's reconciler resolves a repeated key by rendering
 * one of the two and quietly discarding the other — so a shelf sending the same
 * id twice loses a row somewhere three screens from the cause. Dropping the
 * second here makes the answer deterministic; the alternative is a rendering
 * bug that depends on order.
 */
export function byFirstId<T>(rows: readonly T[], idOf: (row: T) => string): readonly T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    const key = idOf(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

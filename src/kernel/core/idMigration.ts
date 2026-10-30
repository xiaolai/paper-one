/**
 * Carrying a reader's existing work across a change of book identity.
 *
 * `bookIdFor` changed shape: it hashes content rather than a file's ends, and
 * it reads a URL rather than trusting its address. Both were necessary — the
 * old scheme gave two different files one id, and gave one file two ids
 * depending on how it was opened — and both mean every mark, card and library
 * row already on disk is filed under an id nothing will ever compute again.
 *
 * The old id CANNOT be derived from the new one; they are different digests of
 * different bytes. What can be done is to compute both from the same source at
 * the moment a book is opened, and move anything found under the old one. So
 * the migration is per-book and happens exactly once per book, the first time a
 * reader opens it after upgrading.
 *
 * A book never reopened keeps its rows under the legacy id indefinitely, which
 * is the correct outcome: they are not lost, they are waiting, and nothing can
 * rekey them without the file itself.
 */

/** How long the ends-sample was, in the scheme this migrates from. */
const LEGACY_SAMPLE_BYTES = 64 * 1024

/**
 * The id a source WOULD have had under the previous scheme.
 *
 * A faithful copy of the old implementation, deliberately duplicated rather
 * than shared: it must not follow `bookIdFor` when that changes again, or the
 * next migration would look for rows under an id that never existed.
 */
export async function legacyBookIdFor(source: File | string): Promise<string> {
  if (typeof source === 'string') return `url:${source}`

  const head = source.slice(0, LEGACY_SAMPLE_BYTES)
  const tail = source.slice(Math.max(0, source.size - LEGACY_SAMPLE_BYTES))
  const sample = new Blob([`${source.size}:`, head, tail])
  const digest = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer())
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
  return `file:${hex.join('').slice(0, 32)}`
}

/**
 * Move every row from one book id to another.
 *
 * Returns the SAME array when there is nothing under the old id, which is the
 * ordinary case on every open after the first — this runs on each book that is
 * opened, and a new array each time would re-render and re-persist the whole
 * store for a migration that already happened.
 */
export function rekeyBook<T extends { readonly bookId: string }>(
  items: readonly T[],
  from: string,
  to: string,
): readonly T[] {
  if (from === to) return items
  if (!items.some((item) => item.bookId === from)) return items
  return items.map((item) => (item.bookId === from ? { ...item, bookId: to } : item))
}

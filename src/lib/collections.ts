/**
 * Collections — named scopes over the shelf.
 *
 * Decision 2: a collection CONFINES what is in play rather than being a query
 * you run. Selecting one restricts the shelf, and the search box, the chip
 * counts and the sort then all operate inside it.
 *
 * WHAT IS NOT HERE IS A LIST OF BOOKS, and that is the whole design. A
 * collection stores a predicate — a tag, or a series — not membership. So a book
 * tagged `Philosophy` is in the Philosophy collection the moment it is tagged,
 * with nothing to keep in step and nothing to go stale; removing a book cannot
 * leave a dangling id behind; and a collection cannot silently disagree with the
 * tags a reader can see on the row.
 *
 * Calibre's manual argues the same point from the other end — a virtual library
 * beats splitting a collection because you can still search the whole thing —
 * and its virtual libraries are stored exactly this way, as saved restrictions
 * rather than as membership lists.
 */

import type { Scope } from './library'

export const COLLECTIONS_STORAGE_KEY = 'paper.collections.v1'

export interface Collection {
  /** Stable across renames, so a rename is not a delete and a create. */
  readonly id: string
  readonly label: string
  readonly tag?: string
  readonly series?: string
}

/** How many collections one reader may have. A bound, not a design limit. */
const MAX_COLLECTIONS = 200
const MAX_LABEL = 60

/** The scope a collection stands for. */
export function scopeOf(collection: Collection): Scope {
  return {
    label: collection.label,
    ...(collection.tag ? { tag: collection.tag } : {}),
    ...(collection.series ? { series: collection.series } : {}),
  }
}

/**
 * Save the current scope under a name.
 *
 * Refuses a duplicate by PREDICATE rather than by label: two collections named
 * differently over the same tag are the same shelf twice, and a reader who saves
 * `Philosophy` twice by accident should get one collection, not two rows that
 * always agree.
 */
export function addCollection(
  collections: readonly Collection[],
  scope: Scope,
  id: string,
): readonly Collection[] {
  const label = scope.label.trim().slice(0, MAX_LABEL)
  if (!label) return collections
  if (collections.length >= MAX_COLLECTIONS) return collections
  const already = collections.some(
    (one) => one.tag === scope.tag && one.series === scope.series,
  )
  if (already) return collections
  return [
    ...collections,
    {
      id,
      label,
      ...(scope.tag ? { tag: scope.tag } : {}),
      ...(scope.series ? { series: scope.series } : {}),
    },
  ]
}

export function removeCollection(
  collections: readonly Collection[],
  id: string,
): readonly Collection[] {
  const next = collections.filter((one) => one.id !== id)
  return next.length === collections.length ? collections : next
}

/**
 * Read the store back, dropping anything malformed.
 *
 * Same trust boundary as the library itself: a bad row is dropped and the rest
 * survive, because losing every collection to one corrupt entry is a far worse
 * failure than losing the entry.
 */
export function parseCollections(raw: string | null): Collection[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isCollection).slice(0, MAX_COLLECTIONS).map((one) => ({
    id: one.id,
    label: one.label.slice(0, MAX_LABEL),
    ...(typeof one.tag === 'string' && one.tag ? { tag: one.tag } : {}),
    ...(typeof one.series === 'string' && one.series ? { series: one.series } : {}),
  }))
}

function isCollection(value: unknown): value is Collection {
  if (typeof value !== 'object' || value === null) return false
  const one = value as Record<string, unknown>
  // A collection with neither predicate would restrict nothing while claiming
  // to — a shelf that says "Philosophy" and shows the whole library.
  const hasPredicate =
    (typeof one['tag'] === 'string' && one['tag'] !== '') ||
    (typeof one['series'] === 'string' && one['series'] !== '')
  return (
    typeof one['id'] === 'string' &&
    one['id'] !== '' &&
    typeof one['label'] === 'string' &&
    one['label'] !== '' &&
    hasPredicate
  )
}

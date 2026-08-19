import { TAG_MAX, normalizeTag, tagKey } from './library'

/**
 * What the reader has decided ABOUT their tags, as opposed to which books carry
 * them.
 *
 * A tag on a book is a fact about that book and lives in its `book.json`. That
 * a tag is pinned, or purple, or that a publisher's subject should never be
 * shown, is a fact about the LIBRARY — it belongs to no book, and writing it
 * onto every book that happens to carry the tag would mean four hundred writes
 * to change one colour, and no way at all to record a preference about a tag
 * that is currently on nothing.
 *
 * KEYED BY `tagKey`, NOT BY SPELLING, which is the plan's own instruction and
 * the reason a rename does not lose a colour: `Philosophy` and `philosophy` are
 * one tag, so they are one row here. The display spelling stays on the books.
 *
 * PURE. Every operation returns a new value or the same one — `useTagPrefs`
 * owns the storage, and returning the SAME object when nothing changed is what
 * lets that hook decide not to write.
 */

/**
 * The one key. Versioned in the name, like the settings and the marks.
 *
 * NOT `paper.library.v1` — that name is TAKEN, by the pre-folders book rows
 * that `MIGRATED_KEYS` still carries over from localStorage on first run. It
 * was the obvious name and it was already spoken for: writing here would have
 * overwritten a reader's shelf with a list of pins, and reading it back would
 * have found an array, parsed to nothing, and silently discarded every
 * preference on every launch. `storageKeys.test.ts` now refuses a repeat.
 */
export const TAG_PREFS_STORAGE_KEY = 'paper.tags.v1'

/**
 * The colours a tag may be given.
 *
 * §01's three mark tints and no more. A tag's colour and a highlight's colour
 * are the same vocabulary — a reader who files in green and marks in green
 * means the same green — and inventing a second palette here would put two
 * unrelated sets of colour words in one app.
 */
export const TAG_COLOURS = ['yellow', 'green', 'purple'] as const
export type TagColour = (typeof TAG_COLOURS)[number]

/** A query the reader kept. `is:reading -tag:Abandoned` is the motivating one. */
export interface SavedView {
  /** Stable across renames, so a row can be edited without becoming a new row. */
  readonly id: string
  readonly name: string
  readonly query: string
}

export interface TagPrefs {
  /** Tag keys the reader pinned, in the order they pinned them. */
  readonly pinned: readonly string[]
  /** Tag key to colour. Absent means no colour, which is not the same as yellow. */
  readonly colours: Readonly<Record<string, TagColour>>
  /** Subject keys the reader never wants offered. Their own tags are never here —
   *  a tag they do not want, they remove. */
  readonly hiddenSubjects: readonly string[]
  readonly views: readonly SavedView[]
}

export const NO_TAG_PREFS: TagPrefs = { pinned: [], colours: {}, hiddenSubjects: [], views: [] }

/**
 * Bounds, because this is a file a reader can edit by hand.
 *
 * Far past where anyone meets them — the point is that a corrupt or hostile
 * file cannot make the panel unrenderable, not that a reader with sixty pinned
 * tags is doing something wrong.
 */
const MAX_ROWS = 2_000
const MAX_VIEWS = 200
const MAX_QUERY = 500

const keyList = (value: unknown, limit = MAX_ROWS): readonly string[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const one of value) {
    if (typeof one !== 'string') continue
    const key = tagKey(one)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= limit) break
  }
  return out
}

function colourMap(value: unknown): Readonly<Record<string, TagColour>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, TagColour> = {}
  let n = 0
  for (const [raw, colour] of Object.entries(value as Record<string, unknown>)) {
    const key = tagKey(raw)
    if (!key || !TAG_COLOURS.includes(colour as TagColour)) continue
    out[key] = colour as TagColour
    if ((n += 1) >= MAX_ROWS) break
  }
  return out
}

function viewList(value: unknown): readonly SavedView[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: SavedView[] = []
  for (const one of value) {
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const id = typeof row['id'] === 'string' ? row['id'].slice(0, 64) : ''
    const name = typeof row['name'] === 'string' ? normalizeTag(row['name']) : ''
    const query = typeof row['query'] === 'string' ? row['query'].slice(0, MAX_QUERY).trim() : ''
    /* A view with no query scopes to nothing and a view with no name cannot be
       chosen; either way it is a row the reader could never use. */
    if (!id || !name || !query || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, query })
    if (out.length >= MAX_VIEWS) break
  }
  return out
}

/**
 * Read the file, keeping what survives.
 *
 * The same rule as every other store here: one bad field costs that field. A
 * library preference file that threw would take the shelf down with it, and
 * these are conveniences — the tags themselves are on the books.
 */
export function parseTagPrefs(raw: string | null): TagPrefs {
  if (!raw) return NO_TAG_PREFS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NO_TAG_PREFS
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_TAG_PREFS
  const doc = parsed as Record<string, unknown>
  return {
    pinned: keyList(doc['pinned']),
    colours: colourMap(doc['colours']),
    hiddenSubjects: keyList(doc['hiddenSubjects']),
    views: viewList(doc['views']),
  }
}

/** Pin or unpin. Appended, so the order is the order they were pinned in. */
export function togglePinned(prefs: TagPrefs, tag: string): TagPrefs {
  const key = tagKey(tag)
  if (!key) return prefs
  const has = prefs.pinned.includes(key)
  return {
    ...prefs,
    pinned: has ? prefs.pinned.filter((one) => one !== key) : [...prefs.pinned, key],
  }
}

/** Give a tag a colour, or take it away with `null`. */
export function setTagColour(prefs: TagPrefs, tag: string, colour: TagColour | null): TagPrefs {
  const key = tagKey(tag)
  if (!key) return prefs
  if (prefs.colours[key] === colour) return prefs
  const colours = { ...prefs.colours }
  if (colour === null) delete colours[key]
  else colours[key] = colour
  return { ...prefs, colours }
}

/**
 * Hide a publisher's subject, or show it again.
 *
 * ONLY SUBJECTS. A tag the reader does not want, they remove — hiding their own
 * tag would leave it on the books, out of sight, filing them under something
 * they can no longer see or undo.
 */
export function toggleHiddenSubject(prefs: TagPrefs, subject: string): TagPrefs {
  const key = tagKey(subject)
  if (!key) return prefs
  const has = prefs.hiddenSubjects.includes(key)
  return {
    ...prefs,
    hiddenSubjects: has
      ? prefs.hiddenSubjects.filter((one) => one !== key)
      : [...prefs.hiddenSubjects, key],
  }
}

/**
 * Keep a query.
 *
 * The id comes from the caller so this stays pure and testable — `useTagPrefs`
 * is where `crypto.randomUUID` lives. A name that already exists is REPLACED
 * rather than duplicated: saving "Reading" twice means the reader is revising
 * it, and two rows with one name is a list nobody can use.
 */
export function saveView(prefs: TagPrefs, id: string, name: string, query: string): TagPrefs {
  const label = normalizeTag(name)
  const text = query.trim().slice(0, MAX_QUERY)
  if (!label || !text) return prefs
  const key = tagKey(label)
  const without = prefs.views.filter((one) => tagKey(one.name) !== key)
  if (without.length >= MAX_VIEWS) return prefs
  return { ...prefs, views: [...without, { id, name: label, query: text }] }
}

export function removeView(prefs: TagPrefs, id: string): TagPrefs {
  if (!prefs.views.some((one) => one.id === id)) return prefs
  return { ...prefs, views: prefs.views.filter((one) => one.id !== id) }
}

export function renameView(prefs: TagPrefs, id: string, name: string): TagPrefs {
  const label = normalizeTag(name).slice(0, TAG_MAX)
  if (!label) return prefs
  return {
    ...prefs,
    views: prefs.views.map((one) => (one.id === id ? { ...one, name: label } : one)),
  }
}

export const isPinned = (prefs: TagPrefs, tag: string): boolean =>
  prefs.pinned.includes(tagKey(tag))

export const colourOf = (prefs: TagPrefs, tag: string): TagColour | null =>
  prefs.colours[tagKey(tag)] ?? null

export const isHidden = (prefs: TagPrefs, tag: string): boolean =>
  prefs.hiddenSubjects.includes(tagKey(tag))

/**
 * Pinned rows first, each group keeping the order it arrived in.
 *
 * A STABLE PARTITION, not a sort with a comparator: the rows come in already
 * ordered by count or by name, and pinning must not disturb that within either
 * group. Pinned tags keep the order the READER pinned them in, which is the
 * only order they have a reason to expect.
 */
export function pinnedFirst<T extends { tag: string }>(
  rows: readonly T[],
  prefs: TagPrefs,
): T[] {
  if (prefs.pinned.length === 0) return [...rows]
  const rank = new Map(prefs.pinned.map((key, at) => [key, at]))
  const pinned: T[] = []
  const rest: T[] = []
  for (const row of rows) {
    if (rank.has(tagKey(row.tag))) pinned.push(row)
    else rest.push(row)
  }
  pinned.sort((a, b) => (rank.get(tagKey(a.tag)) ?? 0) - (rank.get(tagKey(b.tag)) ?? 0))
  return [...pinned, ...rest]
}

/** Subject rows the reader has not hidden. */
export function shownSubjects<T extends { tag: string }>(
  rows: readonly T[],
  prefs: TagPrefs,
): T[] {
  if (prefs.hiddenSubjects.length === 0) return [...rows]
  return rows.filter((row) => !prefs.hiddenSubjects.includes(tagKey(row.tag)))
}

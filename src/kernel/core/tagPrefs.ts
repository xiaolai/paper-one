import { normalizeTag, tagKey } from './library'

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

/**
 * ⚠️ **A COLLECTION THAT IS THERE AND IS NOT A COLLECTION THROWS — ALL THREE
 * READERS BELOW USED TO ANSWER IT EMPTY.** The record around them was made to
 * throw by the 2026-09-13 audit; these went on turning an object-valued
 * `pinned` or a list-valued `colours` into "none", with `useTagPrefs` still
 * persistent — so the reader's next pin wrote that pin and an empty collection
 * over the file. `voicePort.ts`'s bindings had the same line and the same fix
 * (2026-09-13 verify). ABSENT is empty; one bad ROW is still dropped alone.
 */
const keyList = (value: unknown, name: string, limit = MAX_ROWS): readonly string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`the stored tag preferences have a ${name} list that will not read`)
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
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the stored tag preferences have a colours map that will not read')
  }
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
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('the stored tag preferences have a views list that will not read')
  const seen = new Set<string>()
  const out: SavedView[] = []
  for (const one of value) {
    if (
      one === null ||
      // Stryker disable next-line ConditionalExpression: a string, number or boolean row has no `id`, so the test below drops it either way; `one === null` is the clause that decides, and it is a line of its own.
      typeof one !== 'object'
    ) {
      continue
    }
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
 * The same rule as every other store here: one bad ROW costs that row — a pin
 * that is not a string, a view with no query. Refusing the file over one would
 * cost every decision beside it, and these are conveniences — the tags
 * themselves are on the books. (This said one bad FIELD costs that field, and a
 * field here is a whole collection: see `keyList` for what that cost.)
 *
 * ⚠️ **A FILE NOTHING CAN READ IS NOT ONE BAD FIELD, AND IT ANSWERED
 * `NO_TAG_PREFS` — WHICH IS WHAT A READER WHO HAS DECIDED NOTHING GETS.** So
 * `useTagPrefs` came up healthy over damaged bytes and the first pin wrote
 * "nothing plus this pin" over every colour, hidden subject and saved view in
 * the file (2026-09-13 audit). It throws for those bytes now, the hook holds
 * the session's decisions in memory and says they are not being saved, and the
 * file is left for whatever can recover it. ONLY `null` — no file — is nothing
 * set. `parseLookups`' rule, and `parseCards`' after it.
 */
export function parseTagPrefs(raw: string | null): TagPrefs {
  if (raw === null) return NO_TAG_PREFS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error('the stored tag preferences are not JSON', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the stored tag preferences are not a record')
  }
  const doc = parsed as Record<string, unknown>
  return {
    pinned: keyList(doc['pinned'], 'pinned'),
    colours: colourMap(doc['colours']),
    hiddenSubjects: keyList(doc['hiddenSubjects'], 'hidden subjects'),
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
  /* ⚠️ **`normalizeTag` IS THE CUT, AND THIS CUT A SECOND TIME.** It read
   * `normalizeTag(name).slice(0, TAG_MAX)` — but `normalizeTag` already cuts at
   * `TAG_MAX` BY CODE POINT, and `slice` counts UTF-16 units. So a name whose
   * sixtieth character was astral kept half a surrogate pair, a name of astral
   * characters lost half its length, and renaming a view stored something
   * different from saving it under the same name, which `saveView` never cut
   * twice. `tags.ts` records the same defect. Found by mutation testing. */
  const label = normalizeTag(name)
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
  /* ⚠️ **THE SHORTCUT WAS DELETED AS UNOBSERVABLE AND IT IS NOT** (2026-09-14).
     It was taken out because the walk below answers the same list with an empty
     `rank`, so removing the branch looked like a mutant no test could catch.
     A review then COUNTED the work: without it every row's `tag` is read and
     folded, on a shelf of about two thousand books, on every prune — and a
     `tag` getter that throws escapes from a call that used to be skipped. The
     branch is observable, so the gate can hold it: `if (true)` loses the
     reader's pins, `if (false)` reads every tag, and a test kills each. */
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
  /* The shortcut is observable for `pinnedFirst`'s reason: with nothing hidden
     it reads no row's tag. */
  if (prefs.hiddenSubjects.length === 0) return [...rows]
  return rows.filter((row) => !prefs.hiddenSubjects.includes(tagKey(row.tag)))
}

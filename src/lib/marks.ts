/**
 * Marks — the annotation store.
 *
 * §15's lexicon is the vocabulary here, in code as well as in the interface: a
 * **mark** is a highlight in the text, a **note** is a written annotation. So a
 * mark carries an optional note rather than the two being separate records —
 * writing a note about a passage always highlights it, and there is no way to
 * have a note anchored to nothing.
 *
 * The anchor is a foliate CFI, which is what makes a mark survive a reflow: it
 * addresses a position in the book's own markup rather than an offset into a
 * rendered layout, so changing the reading step, the theme or the window width
 * moves the highlight with the words instead of stranding it.
 *
 * Everything here is pure except the two storage functions, which is what lets
 * the anchoring and merge rules be tested without a DOM or a book.
 */

/**
 * §01 gives marks two provenances and draws them differently: your own
 * highlight is a gold fill, the companion's is an amber underline. They are one
 * type rather than two because everything else about them — anchor, note,
 * lifecycle, the Notes list — is identical.
 */
export type MarkKind = 'highlight' | 'companion'

export interface Mark {
  readonly id: string
  /** Which book this belongs to. See `bookIdFor`. */
  readonly bookId: string
  /** foliate CFI. The anchor, and the sort key within a book. */
  readonly cfi: string
  /**
   * Which spine item the mark is in.
   *
   * Recorded at creation rather than derived from the CFI, because deriving it
   * needs foliate's CFI parser. foliate hands the renderer's annotations to the
   * overlay one section at a time (`create-overlay` carries an index), so
   * without this every mark in the book would have to be offered for every
   * section and resolved to find out where it belongs.
   */
  readonly sectionIndex: number
  /** The marked words, for the Notes list and the margin. */
  readonly text: string
  /** The written note. Empty when the mark is a bare highlight. */
  readonly note: string
  readonly kind: MarkKind
  /** TOC label at the time of marking, for "Ch. 1" in the Notes list. */
  readonly chapter: string
  readonly createdAt: number
}

/** A mark being created — the store assigns identity and time. */
export type NewMark = Omit<Mark, 'id' | 'createdAt'>

export const MARKS_STORAGE_KEY = 'paper.marks.v1'

/**
 * Stable identity for a book across sessions.
 *
 * A File has no durable identifier — the same book re-picked from disk is a
 * different File object — so name and size stand in for one. It is not perfect:
 * two different books with the same name and byte count would collide. The
 * alternative is hashing the whole file on every open, which costs a full read
 * of a 50MB EPUB to disambiguate a case that essentially does not arise.
 *
 * A string source is already a stable URL and is used as-is.
 */
export function bookIdFor(source: File | string): string {
  if (typeof source === 'string') return `url:${source}`
  return `file:${source.name}:${source.size}`
}

/**
 * Sort by CFI, so the Notes list reads in book order rather than in the order
 * the reader happened to make the marks.
 *
 * CFIs are compared as strings, which is *approximately* document order and
 * exactly right for the common case of marks within one spine item. A true
 * comparison needs foliate's CFI parser; string order puts `/2/4` after
 * `/2/10` because it compares digit by digit. Wrong ordering is cosmetic here,
 * so it is not worth pulling the parser across the module boundary — but it is
 * why this is `compareMarks` and not `compareCfi`, so the sharper rule has an
 * obvious home if the Notes list ever needs it.
 */
export function compareMarks(a: Mark, b: Mark): number {
  if (a.cfi === b.cfi) return a.createdAt - b.createdAt
  return a.cfi < b.cfi ? -1 : 1
}

/** Every mark belonging to one book, in book order. */
export function marksForBook(marks: readonly Mark[], bookId: string | null): Mark[] {
  if (!bookId) return []
  return marks.filter((mark) => mark.bookId === bookId).sort(compareMarks)
}

/**
 * The marks that earn a place in the margin column.
 *
 * A bare highlight does not: it is already visible as a fill on the words
 * themselves, and repeating it in the margin would fill the column with dots
 * that say nothing the text does not. What goes there is what cannot be read
 * off the page — a written note, and the companion's own marks.
 *
 * This is also what `markCount` counts, so the column is reserved exactly when
 * there is something to put in it. Counting every highlight instead would open
 * a 250px column to display nothing.
 */
export function marginMarks(marks: readonly Mark[]): Mark[] {
  return marks.filter((mark) => mark.note !== '' || mark.kind === 'companion')
}

/**
 * Add a mark, replacing any existing mark on the same book at the same anchor.
 *
 * Re-highlighting an already-highlighted passage should not stack two marks at
 * one anchor: foliate would draw both, and the Notes list would show the
 * passage twice. Replacing keeps the newer note and colour.
 */
export function upsertMark(marks: readonly Mark[], mark: Mark): Mark[] {
  const without = marks.filter(
    (existing) => !(existing.bookId === mark.bookId && existing.cfi === mark.cfi),
  )
  return [...without, mark]
}

export function removeMark(marks: readonly Mark[], id: string): Mark[] {
  return marks.filter((mark) => mark.id !== id)
}

export function updateNote(marks: readonly Mark[], id: string, note: string): Mark[] {
  return marks.map((mark) => (mark.id === id ? { ...mark, note } : mark))
}

/** Identity. `randomUUID` needs a secure context, which a file:// build is not. */
export function newMarkId(): string {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return globalThis.crypto.randomUUID()
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createMark(draft: NewMark): Mark {
  return { ...draft, id: newMarkId(), createdAt: Date.now() }
}

/**
 * Validate one stored record.
 *
 * Storage is a trust boundary: the value is whatever is in localStorage, which
 * includes records written by an older build of this app and anything a user
 * pasted into devtools. A malformed row is dropped rather than thrown on —
 * losing one mark is recoverable, refusing to start the reader is not.
 */
function isMark(value: unknown): value is Mark {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return (
    typeof m['id'] === 'string' &&
    typeof m['bookId'] === 'string' &&
    typeof m['cfi'] === 'string' &&
    typeof m['sectionIndex'] === 'number' &&
    typeof m['text'] === 'string' &&
    typeof m['note'] === 'string' &&
    (m['kind'] === 'highlight' || m['kind'] === 'companion') &&
    typeof m['chapter'] === 'string' &&
    typeof m['createdAt'] === 'number'
  )
}

/** Parse a stored payload, keeping only the rows that survive validation. */
export function parseMarks(raw: string | null): Mark[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isMark)
}

/**
 * The storage surface this module needs, which is the part of the Storage
 * interface it actually calls. Narrow on purpose: it is what lets the tests
 * pass a plain object instead of standing up a localStorage double.
 */
export interface MarkStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function loadMarks(storage: MarkStorage): Mark[] {
  try {
    return parseMarks(storage.getItem(MARKS_STORAGE_KEY))
  } catch {
    // Safari throws on getItem when storage is disabled entirely.
    return []
  }
}

/**
 * Persist, reporting failure to the caller rather than throwing.
 *
 * Writing can fail for reasons the reader cannot fix — a full quota, private
 * browsing, storage switched off — and none of them should take the reader
 * down mid-highlight. The boolean exists so the caller can tell the user their
 * mark will not survive a reload, which is the honest thing to do and is
 * strictly better than a silent no-op.
 */
export function saveMarks(storage: MarkStorage, marks: readonly Mark[]): boolean {
  try {
    storage.setItem(MARKS_STORAGE_KEY, JSON.stringify(marks))
    return true
  } catch {
    return false
  }
}

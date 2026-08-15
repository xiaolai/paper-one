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

import { compare } from 'foliate-js/epubcfi.js'

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
 * different File object — so the identity has to come from the content.
 *
 * It is derived from the size plus the first and last 64KB rather than from the
 * name and size, which is what this used to be. Name and size collide in ways
 * that are not exotic: two files named `book.pdf` in different folders, or the
 * same title from two sources, and the reader silently gets the other book's
 * marks, cards and reading position. Revising a file without changing its
 * length does the same thing in reverse.
 *
 * Bounded on purpose: hashing a whole 50MB EPUB on every open to settle this
 * would be the obvious over-correction. 128KB spans an EPUB's mimetype,
 * container and opening spine item, or a PDF's header, xref and trailer, which
 * no two different books share; it costs a couple of milliseconds and is
 * stable across copying, moving and re-downloading, which an mtime is not.
 *
 * A string source is already a stable URL and is used as-is.
 */
const SAMPLE_BYTES = 64 * 1024

export async function bookIdFor(source: File | string): Promise<string> {
  if (typeof source === 'string') return `url:${source}`

  const head = source.slice(0, SAMPLE_BYTES)
  const tail = source.slice(Math.max(0, source.size - SAMPLE_BYTES))
  const sample = new Blob([`${source.size}:`, head, tail])
  const digest = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer())
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
  // Half the digest. This is an identity, not a security boundary, and 128 bits
  // of it makes an accidental collision impossible in a personal library.
  return `file:${hex.join('').slice(0, 32)}`
}

/**
 * Sort by CFI, so the Notes list reads in book order rather than in the order
 * the reader happened to make the marks.
 *
 * The comparison is foliate-js's own `epubcfi.compare`, not one written here.
 * Two attempts came before it and both were wrong:
 *
 *   Plain string order walks digit by digit, so `/2/10` sorts before `/2/4`
 *   and chapter 10's marks appear among chapter 4's. Any book with more than
 *   nine of anything hits it.
 *
 *   Natural order — numeric runs compared as numbers — fixes that and is still
 *   wrong, because a CFI is not a string with numbers in it. It carries
 *   ASSERTIONS: `/6/4[chap01ref]!/4` addresses the same place as `/6/4!/4`, and
 *   the bracketed part must not participate in ordering. `view.getCFI`
 *   generates assertions whenever the element it anchors to has an id, so this
 *   is what real books produce, not an exotic case. Checked against
 *   foliate-js's own test vectors, the hand-rolled version failed two of seven.
 *
 * It is a dependency we already ship, under MIT, exporting exactly this. There
 * was never a reason to reimplement the spec beside it.
 */
export function compareMarks(a: Mark, b: Mark): number {
  /* The SECTION first, because it is the one part of a mark's position that is
   * a plain number and is known to be right. Two CFIs from different spine
   * items are not comparable as strings at all — they address positions in
   * different documents — so a book whose sections carry structurally
   * different CFIs could interleave two chapters' marks. Comparing the section
   * first makes that unrepresentable, and leaves the CFI to do the only job it
   * is good at: ordering within one section. */
  if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex
  if (a.cfi === b.cfi) return a.createdAt - b.createdAt
  const order = compareCfi(a.cfi, b.cfi)
  return order !== 0 ? order : a.createdAt - b.createdAt
}

/**
 * Order two CFIs, tolerating one that will not parse.
 *
 * Measured rather than assumed, because the obvious guess is wrong: a malformed
 * STRING does not throw. `epubcfi.compare` parses `''`, `'not a cfi'` and
 * `'epubcfi('` alike into a degenerate path that simply sorts first. Only a
 * non-string throws, and `isMark` already refuses to load one of those.
 *
 * So the catch is not load-bearing today — it is a boundary guard for a
 * comparator that is exported and sorts data coming out of storage, where one
 * bad row must never take the whole Notes list down with it. Equal, so the
 * pair falls through to creation time, which is what an unorderable pair has
 * always done here.
 */
export function compareCfi(a: string, b: string): number {
  try {
    return compare(a, b)
  } catch {
    return 0
  }
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
  /* The right TYPE is not the same as a usable value, and every one of these
   * three gets through a type check while breaking something specific:
   *
   *   empty id       React keys collide, and `remove(id)` deletes both marks
   *   empty cfi      nothing to resolve, so the mark can never be drawn — it
   *                  sits in the Notes list forever pointing at nothing
   *   bad index      a fractional or negative sectionIndex matches no section,
   *                  so `drawSection` never offers the mark to an overlay
   *   bad createdAt  NaN/Infinity sorts unpredictably, scrambling the order of
   *                  every OTHER mark on the same anchor — and a NEGATIVE one
   *                  is finite, so it passes that check while still sorting
   *                  before every real mark, which is the same bug wearing a
   *                  plausible number. These are epoch milliseconds; there is
   *                  no such thing as one from before 1970 here.
   *
   * Dropping the row loses one mark. Keeping it corrupts a list. */
  return (
    typeof m['id'] === 'string' &&
    m['id'] !== '' &&
    typeof m['bookId'] === 'string' &&
    m['bookId'] !== '' &&
    typeof m['cfi'] === 'string' &&
    m['cfi'] !== '' &&
    typeof m['sectionIndex'] === 'number' &&
    Number.isInteger(m['sectionIndex']) &&
    m['sectionIndex'] >= 0 &&
    typeof m['text'] === 'string' &&
    typeof m['note'] === 'string' &&
    (m['kind'] === 'highlight' || m['kind'] === 'companion') &&
    typeof m['chapter'] === 'string' &&
    typeof m['createdAt'] === 'number' &&
    Number.isFinite(m['createdAt']) &&
    m['createdAt'] >= 0
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
  return dedupeById(parsed.filter(isMark))
}

/**
 * One row per id, keeping the first.
 *
 * Everything downstream addresses a mark BY ID and assumes that is unique:
 * `remove` drops every row matching an id and `setNote` rewrites every one of
 * them. Nothing enforced it. A store carrying duplicate ids — a legacy write, a
 * hand-edited value, a merge across two devices — therefore turned one delete
 * into several, across books, silently. Enforced here because this is the only
 * door stored data comes through, so a single check makes the assumption true
 * for every caller rather than asking each of them to defend itself.
 *
 * First wins: it is the oldest surviving row, and a later duplicate is the more
 * likely corruption.
 */
function dedupeById(marks: readonly Mark[]): Mark[] {
  const seen = new Set<string>()
  const kept: Mark[] = []
  for (const mark of marks) {
    if (seen.has(mark.id)) continue
    seen.add(mark.id)
    kept.push(mark)
  }
  return kept
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

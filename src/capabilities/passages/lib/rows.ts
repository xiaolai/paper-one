import type { PassageHit, PassageIndexStatus, UnreadableBook } from '../../../kernel'

/**
 * What the passages plugin answers with, and the pure part of reading it.
 *
 * ⚠️ **NOTHING HERE IMPORTS TAURI**, deliberately — `browser:check` is a
 * `pnpm verify` step and the defect it exists for has happened four times: a
 * pure value sharing a module with a platform binding takes the whole subtree
 * down with it. The binding is `wire.ts`, which is the only file in this
 * capability allowed to name `@tauri-apps` at all.
 *
 * ⚠️ **CHECKED, NEVER CAST.** Every value here arrives from outside
 * TypeScript's reach. A cast would make a malformed row render — a hit with no
 * quote draws an empty result the reader can click and that goes nowhere, and a
 * `sectionIndex` that is not a number parses as `NaN` and lands the reader in no
 * chapter at all.
 *
 * ## ⚠️ THE UNIT AT THE WIRE: `offset` IS UTF-16 CODE UNITS
 *
 * Not bytes, and not Rust `char`s — three different numbers for one position,
 * and picking the wrong one shifts every quote in a book by however many astral
 * characters preceded it. UTF-16 is what a JavaScript string is sliced by and
 * what `reanchor.ts` counts in, and it is the same convention
 * `tauri-plugin-voices`' `WordRow.start` already states: *"UTF-16 code units,
 * which is what a web front end counts in."*
 *
 * The conversion happens ONCE, on the Rust side, in `Store::search` — the only
 * place holding the string both units describe. Converting anywhere else would
 * mean walking the section a second time, and two walks of one string is two
 * chances to disagree. `"😀"` is four bytes, one `char` and TWO units;
 * `"春"` is three bytes, one `char` and ONE unit. `commands/tests.rs`'s
 * `an_offset_is_what_the_front_end_counts` pins both.
 */

/**
 * A count: whole, and not negative.
 *
 * ⚠️ **NO `typeof value === 'number'` IN FRONT OF THIS.** `Number.isInteger`
 * answers false for every value that is not a number, so a narrowing test ahead
 * of it could never be the clause that refused — an unkillable mutant, which
 * this repository removes rather than disables. The cast is what `tsc` needs
 * for the comparison, and it is sound precisely because `Number.isInteger` has
 * already answered.
 */
function counted(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

/** A score: any finite number, including zero and including a negative one. */
function scored(value: unknown): value is number {
  return Number.isFinite(value)
}

/**
 * Read one passage, refusing one that is not the shape it claims.
 *
 * ⚠️ **AN EMPTY QUOTE IS REFUSED.** It is not a hit — there is nothing to draw
 * and nothing for `reanchorIn` to look for, so it would render as a blank result
 * that navigates nowhere. `prefix` and `suffix` MAY be empty: a passage at the
 * very start of a chapter genuinely has nothing before it, and refusing that
 * would drop the first sentence of every book.
 */
export function hitOf(raw: unknown): PassageHit | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (typeof row.bookId !== 'string' || row.bookId === '') return null
  if (!counted(row.section)) return null
  if (!counted(row.offset)) return null
  if (typeof row.quote !== 'string' || row.quote === '') return null
  if (typeof row.prefix !== 'string' || typeof row.suffix !== 'string') return null
  if (!scored(row.score)) return null
  return {
    bookId: row.bookId,
    /* RENAMED AT THE SEAM. The plugin's field is `section`, which is what it is
     * inside an index; the kernel's vocabulary is `sectionIndex`, which is what
     * `reanchorPass` and `cfiFor` call the same number. One rename in one place
     * beats two names travelling together. */
    sectionIndex: row.section,
    offset: row.offset,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    score: row.score,
  }
}

/**
 * Read a list of passages.
 *
 * ⚠️ **A REPLY THAT IS NOT A LIST IS REFUSED, NOT READ AS EMPTY.** This is the
 * defect this repository has fixed in eighteen stores, and `voices/lib/port.ts`
 * records it for this exact seam: *present and wrong* answered as *absent*, so a
 * plugin returning something malformed looked exactly like a library with no
 * matches. One bad ROW is still dropped alone, which is the other half of the
 * same rule.
 */
export function hitsOf(raw: unknown): readonly PassageHit[] {
  if (!Array.isArray(raw)) {
    throw new Error('the passages plugin answered with something that is not a list of passages')
  }
  const hits: PassageHit[] = []
  for (const one of raw) {
    const hit = hitOf(one)
    if (hit) hits.push(hit)
  }
  return hits
}

/** One book that could not be read, as the plugin reports it. */
function unreadableOf(raw: unknown): UnreadableBook | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (typeof row.bookId !== 'string' || row.bookId === '') return null
  if (typeof row.why !== 'string' || row.why === '') return null
  if (!counted(row.at)) return null
  return { bookId: row.bookId, why: row.why, at: row.at }
}

/**
 * Read the index's status.
 *
 * ⚠️ **A STATUS THAT WILL NOT READ IS REFUSED.** Answered as zeroes it says
 * *"nothing is indexed"*, which is what a reader is told while the shelf is in
 * fact fully searchable — and it is what a backfill reads as *"start again"*.
 */
export function statusOf(raw: unknown): PassageIndexStatus {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('the passages plugin answered with something that is not a status')
  }
  const row = raw as Record<string, unknown>
  if (
    !counted(row.books) ||
    !counted(row.sections) ||
    !counted(row.chars) ||
    !counted(row.indexBytes) ||
    !counted(row.textBytes) ||
    typeof row.analysis !== 'string'
  ) {
    throw new Error('the passages plugin answered with a status this build cannot read')
  }
  /* ⚠️ **A LIST THAT IS NOT ONE IS REFUSED HERE TOO.** `unreadable` is the
   * field the whole shape exists for — *a search that quietly omits a fifth of
   * the library is worse than one that says it is still working* — so reading a
   * malformed one as "no books are missing" is the exact lie it exists to
   * prevent. */
  if (!Array.isArray(row.unreadable)) {
    throw new Error('the passages plugin answered with a status whose unreadable list is not a list')
  }
  const unreadable: UnreadableBook[] = []
  for (const one of row.unreadable) {
    const book = unreadableOf(one)
    if (book) unreadable.push(book)
  }
  return {
    books: row.books,
    sections: row.sections,
    chars: row.chars,
    indexBytes: row.indexBytes,
    textBytes: row.textBytes,
    analysis: row.analysis,
    unreadable,
  }
}

/**
 * Read the list of book ids a backfill still has to do.
 *
 * Same rule as everywhere else in this file: a reply that is not a list is
 * refused, and one bad entry is dropped alone. Answering `[]` for a malformed
 * reply would report a finished backfill over a library nothing had indexed.
 */
export function pendingOf(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new Error('the passages plugin answered with something that is not a list of book ids')
  }
  return raw.filter((one): one is string => typeof one === 'string' && one !== '')
}

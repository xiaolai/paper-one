import type { PassageHit } from '../../core/ports'

/**
 * The decidable half of searching the library from the Search pane.
 *
 * ⚠️ **PURE, AND IN ITS OWN FILE, BECAUSE A `<select>` FLATTENS ANSWERS.**
 * Phase 30 measured it: a control given a value no option carries reports the
 * empty string and shows its first row, so four distinct decisions collapse to
 * two in the DOM and no case that drives the pane can tell three of them apart.
 * The same is true here — *searching*, *nothing found*, *no index on this
 * device* and *the query cannot be asked* all render as a paragraph of text, and
 * `textContent` cannot say which state produced it. Exported and asked directly,
 * they can be.
 */

/** Which books a query is asked of. */
export type SearchScope = 'book' | 'library'

/**
 * What a library search is doing, as one value.
 *
 * ⚠️ **THERE IS NO `unavailable` ARM, AND THERE WAS ONE.** A device with no
 * index cannot reach this at all — the scope switch is not drawn without
 * `searchLibrary`, so the panel is exactly what it was before phase 31 — which
 * made that arm a state nothing could produce and a branch no case could reach.
 * An unreachable arm is a promise about a screen nobody will ever see, and it
 * reads as though the absent case were handled somewhere.
 */
export type LibraryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'done'; readonly hits: readonly PassageHit[] }
  /** The index refused the question — an unbalanced quote, a lone character. */
  | { readonly kind: 'rejected'; readonly why: string }
  /** Something else went wrong. */
  | { readonly kind: 'failed'; readonly why: string }

/**
 * A library result, and the query it belongs to, as ONE value.
 *
 * `SearchPanel`'s own `SearchResult` carries the same reasoning, and it was
 * earned: held apart, the hits and the status can disagree on the frame that
 * matters most, and the panel announced *"No matches for X"* before anything had
 * looked for X — for one frame per keystroke, which is exactly long enough to
 * read and impossible to catch in a test that waits for the search.
 */
export interface LibraryResult {
  readonly needle: string
  readonly state: LibraryState
}

/**
 * The two states with nothing in them, and the results that carry them.
 *
 * ⚠️ **NAMED HERE BECAUSE AN OBJECT LITERAL INSIDE A COMPONENT IS A SURVIVOR NO
 * TEST CAN REACH.** `useState<LibraryResult>({ needle: '', state: { kind:
 * 'idle' } })` is unobservable at mount — the scope starts on the open book, so
 * nothing renders the library half, and the effect overwrites it before
 * anything could. Six mutants sat on those two lines and on the `setLibrary`
 * calls beside them. Moved here, each is a value a unit test asks about
 * directly.
 */
export const IDLE: LibraryState = { kind: 'idle' }
export const SEARCHING: LibraryState = { kind: 'searching' }

/** Nothing has been asked yet — the panel's first state. */
export const NOTHING_ASKED: LibraryResult = { needle: '', state: IDLE }

/** This needle has been asked and has not answered. */
export function searchingAt(needle: string): LibraryResult {
  return { needle, state: SEARCHING }
}

/**
 * What to DRAW for `needle`, given the result the panel is holding.
 *
 * ⚠️ **NOTHING ON SCREEN MAY OUTLIVE THE QUERY IT ANSWERS**, and the window
 * where that matters is a SINGLE render — between the keystroke that changes
 * the needle and the effect that starts the new search. A component test
 * flushes past it, so the guard survived every case that drove the pane.
 * Exported so it can be asked directly, which is the rule phase 30 states for
 * `voicePickerValue`: when a pure function's answers are flattened by what
 * draws them, ask the function.
 */
export function shownState(result: LibraryResult, needle: string): LibraryState {
  return result.needle === needle ? result.state : SEARCHING
}

/** How many library hits are drawn. */
export const MAX_LIBRARY_HITS = 100

/**
 * Whether a refusal is the CALLER'S to fix.
 *
 * ⚠️ **`malformed` AND EVERYTHING ELSE ARE DIFFERENT SENTENCES.** An unbalanced
 * quotation mark is a query a reader can correct; an index that will not open is
 * not, and telling them to try another spelling would send them to retype a
 * perfectly good question for ever.
 *
 * ⚠️ **AND THE SAME REFUSAL ARRIVES IN TWO VOCABULARIES, BECAUSE IT TRAVELS BY
 * TWO ROADS.** This panel is mounted over both:
 *
 * | road | shape |
 * |---|---|
 * | the app — straight to the plugin through `PassagesPort` | `{ kind: 'badQuery' }`, the plugin's own |
 * | a browser session — over the envelope through `passage.search` | `{ code: 'malformed' }`, the handler's translation |
 *
 * Reading only the second is a defect this file shipped for exactly as long as
 * it took to re-read: on the DESKTOP — the only platform that has an index —
 * every refused query would have been reported as *"Your library could not be
 * searched"*, which is the sentence for a broken index and the one that makes a
 * reader stop trusting the feature. Both are read, and neither is translated
 * into the other: two transports genuinely do have two vocabularies, and
 * flattening them somewhere in the middle is how one of them comes to be the
 * one nobody tests.
 */
export function rejectedByQuery(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  const refusal = cause as { code?: unknown; kind?: unknown }
  return refusal.code === 'malformed' || refusal.kind === 'badQuery'
}

/** Whatever a rejection carries, as something a reader can read. */
export function whyOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const message = (cause as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The one-line summary above the results.
 *
 * ⚠️ **IT NAMES THE SCOPE, AND THAT IS NOT DECORATION.** Both scopes draw a list
 * of snippets into the same panel; without the count saying which question was
 * asked, a reader who switched scope and got fewer results cannot tell a
 * narrower search from a smaller library.
 */
export function countLine(hits: number, capped: boolean, searching: boolean): string {
  const shown = Math.min(hits, MAX_LIBRARY_HITS)
  return `${shown}${capped ? '+' : ''} in your library${searching ? ' · searching…' : ''}`
}

/**
 * The hits grouped by book, in the order the books first appear.
 *
 * ⚠️ **GROUPED, BECAUSE A FLAT LIST OF PASSAGES LOSES WHICH BOOK IS WHICH.** The
 * index answers best-passage-first across the whole shelf, so two hits from one
 * book commonly sit either side of a hit from another — and a reader scanning
 * for *where did I read that?* is looking for the book before the sentence.
 * Ranking is preserved: a book's position is where its BEST hit fell.
 */
export function byBook(hits: readonly PassageHit[]): readonly (readonly [string, readonly PassageHit[]])[] {
  const grouped = new Map<string, PassageHit[]>()
  for (const hit of hits) {
    const held = grouped.get(hit.bookId)
    if (held) held.push(hit)
    else grouped.set(hit.bookId, [hit])
  }
  return [...grouped.entries()]
}

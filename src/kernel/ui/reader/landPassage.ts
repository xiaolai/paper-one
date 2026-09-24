import { bodyOf } from './passageText'
import { cfiFor, indexText, reanchorIn, type ResolvedCfi, type TextIndex } from './reanchor'

/**
 * Turning a library hit back into a place in a book — the landing.
 *
 * ## ⚠️ NO RENDERING, AND `view.search()` IS NEVER CALLED
 *
 * A hit carries the quote, a little of the text either side of it, and the
 * section it came from. Landing it is `section.createDocument()` on that one
 * section and the canonical walk `reanchor.ts` already implements. Three things
 * follow, and each is a decision rather than an accident:
 *
 * - **No open book is required**, so a hit in chapter 40 of a book opened at
 *   chapter 1 resolves like any other. A CFI is a PATH, not a node reference.
 * - **`view.search()` is never called.** It is stateful and destructive — it
 *   calls `clearSearch()`, replaces one shared draw function and
 *   `addAnnotation()`s every candidate — which is the whole reason `reanchor.ts`
 *   exists. The phase plan's first draft proposed the route that file was
 *   written to avoid.
 * - **ONE section is parsed, not the spine.** The index said which one, so the
 *   sweep `reanchorPass` does is exactly the work this does not have to do.
 *
 * ## Prefix and suffix are what disambiguate a repeated passage
 *
 * ⚠️ **A QUOTE ALONE JUMPS TO THE FIRST OCCURRENCE, WHICH IS A WRONG LANDING
 * THAT LOOKS LIKE A RIGHT ONE.** The section narrows it; the surrounding text
 * decides it. `reanchorIn` applies the same `distinguishable` rule it applies
 * everywhere else — exact canonical quote equality first, context only ever
 * choosing BETWEEN exact matches, never rescuing a near miss.
 *
 * ## A failed landing is reported by cause, never as one
 *
 * Stale generation, content evicted, quote absent and
 * ambiguous-after-prefix-and-suffix are four different sentences, and the pane
 * says four different things. ⚠️ **"The book changed edition" is the wrong
 * default** — `bookId` identifies the exact bytes, so another edition is
 * normally another book. Same-byte ambiguity is the common case and must not be
 * misdiagnosed as an edition change.
 */

/** A hit, as far as landing one cares. */
export interface LandablePassage {
  readonly sectionIndex: number
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  /**
   * Where the index found this, in the canonical text's own UTF-16 units.
   *
   * ⚠️ **OPTIONAL HERE AND REQUIRED ON THE WIRE, AND THAT ASYMMETRY IS THE
   * POINT.** `PassageHit.offset` always carries one; this type is also what
   * every test and the marks path hand in, and an offset they cannot supply
   * must not stop them landing. Absent, the landing behaves exactly as it did
   * before the offset was read at all.
   *
   * ⚠️ **AND `undefined` MUST NOT BECOME ZERO.** `startsWith(quote, undefined)`
   * means position 0, so an absent offset would silently claim the FIRST
   * occurrence is the one the index meant — a wrong landing where the honest
   * answer is a refusal, which is the one outcome this whole module exists to
   * avoid. It is tested for by name.
   */
  readonly offset?: number
}

/** Where a hit landed, or why it did not. */
export type Landing =
  | { readonly kind: 'landed'; readonly cfi: ResolvedCfi; readonly occurrences: number }
  /** The section parsed and the quote is not in it — the index is behind the book. */
  | { readonly kind: 'absent' }
  /** The quote is here several times and the context cannot choose. */
  | { readonly kind: 'ambiguous'; readonly occurrences: number }
  /** There is no such section in this build — the index is behind the book. */
  | { readonly kind: 'no-section' }
  /** The section would not parse. */
  | { readonly kind: 'unreadable'; readonly why: string }

/**
 * Land one hit in one section's document.
 *
 * `documentFor` is the caller's, so this module needs no book, no view and no
 * renderer — which is what makes the whole of it testable against a plain
 * `DOMParser` document.
 */
export async function landPassage(
  passage: LandablePassage,
  documentFor: (index: number) => Promise<Node | null>,
): Promise<Landing> {
  if (!Number.isInteger(passage.sectionIndex) || passage.sectionIndex < 0) {
    return { kind: 'no-section' }
  }
  let doc: Node | null
  try {
    doc = await documentFor(passage.sectionIndex)
  } catch (cause) {
    /* ⚠️ **NAMED, NOT SWALLOWED.** A section that will not parse and a quote
     * that is not there are different facts, and the reader is told which: the
     * first is worth reopening the book for and the second is not. */
    return { kind: 'unreadable', why: cause instanceof Error ? cause.message : String(cause) }
  }
  /* A SECTION THAT IS NOT THERE. The index is describing a build of this book
   * that this device does not have — which is the index being behind, not the
   * book being wrong. */
  if (!doc) return { kind: 'no-section' }

  /* ⚠️ **`bodyOf` IS NOT A COURTESY HERE EITHER.** Given a whole `Document`,
   * `indexText` walks nothing and every quote comes back `absent` — a landing
   * that fails for every hit in the library, with no error anywhere. See
   * `passageText.bodyOf`. */
  const index = indexText(bodyOf(doc))
  const found = reanchorIn(index, passage)
  if (found.kind === 'absent') return { kind: 'absent' }
  if (found.kind === 'ambiguous') {
    /* ⚠️ **THE INDEX RECORDED EXACTLY WHERE IT FOUND THIS, AND NOTHING READ
     * IT.** `PassageHit.offset` crosses the wire and says in its own docstring
     * *"where the quote starts in that section's canonical text"* — and the
     * landing disambiguated on prefix and suffix alone, so a passage in a
     * repetitive section was refused with *"Paper cannot tell which one this
     * is"* while the answer was in the hit. A field with no consumer, which is
     * the shape `paper/share-notes/1` and `books_in_index` already cost this
     * repository twice.
     *
     * Measured on the real 1 962-book library, 2026-09-24: **5 of 216**
     * landings were refused this way — `memory` 96 times in one section,
     * `algorithm` 22 times, `"once upon a time"` 4 — and over 50 hits the
     * offset landed on the quote **50 times out of 50**, in the resolver's own
     * canonical text, including in exactly those sections. Re-run against the
     * same three queries with this in place: **54 of 54 landed, none refused**.
     *
     * ⚠️ **VERIFIED BEFORE IT IS USED, WHICH IS WHAT MAKES IT SAFE.** The
     * offset describes the bytes the index was built from, and this device may
     * have different ones — the second-writer limit `freshness.ts` records. So
     * the text AT that offset has to be the quote before anything is built from
     * it; when it is not, this falls through to the refusal exactly as before.
     *
     * No `offset >= 0` guard, deliberately: a negative one makes `slice` count
     * from the end, and anything that then matched still fails in
     * `rangeAtOffset`, whose node lookup comes back undefined. A guard here
     * would be a clause no test could reach. */
    const at = passage.offset
    const range =
      at !== undefined && index.text.startsWith(passage.quote, at)
        ? rangeAtOffset(index, at, passage.quote.length)
        : null
    if (range) {
      return { kind: 'landed', cfi: cfiFor(passage.sectionIndex, range), occurrences: found.occurrences }
    }
    return { kind: 'ambiguous', occurrences: found.occurrences }
  }
  return {
    /* MINTED WHILE THE RANGE'S NODES ARE STILL IN A LIVE DOCUMENT. The
     * document is thrown away the moment this returns, and a `Range` kept
     * across that is a pair of references into a document nobody holds. */
    kind: 'landed',
    cfi: cfiFor(passage.sectionIndex, found.range),
    occurrences: found.occurrences,
  }
}

/**
 * The range the canonical offsets `[start, start + length)` cover.
 *
 * `reanchorIn` builds its own range from the occurrence IT chose; this builds
 * one at a position somebody else chose, which is the whole difference. The
 * arithmetic is the same and is kept here rather than exported from
 * `reanchor.ts`, because that file is source-pinned and a resolver shared with
 * every mark has no business learning about passage offsets.
 *
 * Answers `null` rather than throwing for a position the index does not cover —
 * an offset past the end, or one whose node the walk never recorded.
 */
function rangeAtOffset(index: TextIndex, start: number, length: number): Range | null {
  const last = start + length - 1
  const head = index.nodes[index.node[start] ?? -1]
  const tail = index.nodes[index.node[last] ?? -1]
  const from = index.from[start]
  const to = index.to[last]
  const doc = head?.ownerDocument
  if (!head || !tail || !doc || from === undefined || to === undefined) return null
  const range = doc.createRange()
  range.setStart(head, from)
  range.setEnd(tail, to)
  return range
}

/**
 * What to tell a reader when a landing failed.
 *
 * One sentence per cause, in this module rather than in the pane, because the
 * pane is not the only caller — the CLI reports the same four facts — and a
 * sentence written twice is a sentence that drifts.
 */
export function whyNotLanded(landing: Landing): string | null {
  switch (landing.kind) {
    case 'landed':
      return null
    case 'absent':
      /* NOT "the book changed edition". `bookId` identifies the exact bytes, so
       * another edition is normally another book — see the header. What this
       * really means is that the index is describing text these bytes no longer
       * have, which a re-index fixes. */
      return 'This passage is not in the book any more. Paper will look again the next time it indexes it.'
    case 'ambiguous':
      return `Those words appear ${landing.occurrences} times here and Paper cannot tell which one this is.`
    case 'no-section':
      return 'That chapter is not in this copy of the book.'
    case 'unreadable':
      return 'That chapter could not be opened.'
  }
}

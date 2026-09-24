import { bodyOf } from './passageText'
import { cfiFor, indexText, reanchorIn, type ResolvedCfi } from './reanchor'

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
  const found = reanchorIn(indexText(bodyOf(doc)), passage)
  if (found.kind === 'absent') return { kind: 'absent' }
  if (found.kind === 'ambiguous') {
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

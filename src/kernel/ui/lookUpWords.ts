import type { GlossState } from './hooks/useGloss'

/**
 * What Look up SAYS in each of its states — one set of words for both surfaces.
 *
 * ⚠️ **THE FOUR SENTENCES WERE WRITTEN TWICE** (#124): once in
 * `reader/LookUpFace.tsx`'s `Said`, the face of the selection popup, and once in
 * `pane/DictionaryView.tsx`'s `LiveLookUp`, the same lookup as a row in
 * Marginalia. Two copies of the sentence a reader is shown when there is no
 * definition, each needing the other edited with it — and the surfaces are in
 * different directories, so nothing brought them to mind together.
 *
 * THE WORDS, NOT THE LAYOUT. Each surface still decides its own elements, its
 * own classes and its own controls: the popup wraps a failure's cause in its own
 * line and offers **Choose one**; the row runs the two together and offers
 * neither. What they must not differ about is what Paper says happened.
 *
 * `core/gloss.ts`'s doctrine is what shapes these and is NOT expressible here:
 * a provider *"must never resolve with an apology, because an apology rendered
 * in amber reads as a definition"*. So a refusal says "couldn't" rather than a
 * bare clause that scans as a gloss — and whether it is drawn in amber is the
 * surface's own decision, made from `kind`, not from these words.
 *
 * ⚠️ **THE PART OF SPEECH IS DELIBERATELY NOT HERE** (2026-09-18), and that is
 * two decisions rather than an omission:
 *
 * - **It is not a sentence Paper says.** These are the words Paper writes when
 *   it has something to explain; a part of speech is a FIELD of the model's
 *   answer, carried on `GlossState.ready`. Threading it through `said` would put
 *   the model's own text and Paper's own voice in one string.
 * - **So the popup draws it and Marginalia's row does not.** The row is the same
 *   lookup with a fraction of the width, and it sits directly above HISTORY
 *   rows drawn from the lookups store — which has no part of speech and is not
 *   getting one in this change. A live row carrying a line every row beneath it
 *   lacks would read as the older lookups having lost something. The popup has
 *   no such neighbour: it draws one answer, alone, beside the word.
 *
 * `DictionaryView`'s `LiveLookUp` is where that second half is visible, and
 * `DictionaryView.test.tsx` holds it.
 */
export interface LookUpWords {
  /** The line in place of a definition — or the definition, when there is one. */
  readonly said: string
  /**
   * Why, where Paper knows — the provider's own reason for a failure, kept
   * apart because one surface gives it a line of its own and the other does
   * not. Null for every state that has no cause to give.
   */
  readonly because: string | null
}

/**
 * The words for a lookup that is not idle — an idle one is not a lookup, and
 * neither surface draws one.
 */
export function lookUpSays(state: Exclude<GlossState, { readonly kind: 'idle' }>): LookUpWords {
  switch (state.kind) {
    case 'asking':
      /* IN THE DEFINITION'S OWN ELEMENT on both surfaces: "Looking…" cannot be
         mistaken for a definition, and moving it would make every lookup jump
         between two shapes on its way to an answer. */
      return { said: 'Looking…', because: null }
    case 'ready':
      return { said: state.text, because: null }
    case 'failed':
      return { said: `Paper couldn’t define “${state.term}”.`, because: state.reason }
    case 'unavailable':
      /* ⚠️ **IT SAID "Paper needs a language model"**, and the way out was a
         2.5 GB download. Since 2026-09-18 an endpoint, Claude or Codex can answer
         too, and the local model is one opt-in choice among them — so the
         sentence names the need, not one way of meeting it, and the popup's
         control opens the section where the choice is. */
      return { said: `Look up needs something to answer with before it can define “${state.term}”.`, because: null }
    case 'tooLong':
      /* NAMES NO TERM, because there is no term — see `GlossState.tooLong`. The
         reader selected a paragraph and is looking at it. */
      return {
        said: 'That passage is too long to look up — select a word or a short phrase.',
        because: null,
      }
  }
}

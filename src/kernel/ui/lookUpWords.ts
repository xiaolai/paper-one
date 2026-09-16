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
 * line and offers **Install one**; the row runs the two together and offers
 * neither. What they must not differ about is what Paper says happened.
 *
 * `core/gloss.ts`'s doctrine is what shapes these and is NOT expressible here:
 * a provider *"must never resolve with an apology, because an apology rendered
 * in amber reads as a definition"*. So a refusal says "couldn't" rather than a
 * bare clause that scans as a gloss — and whether it is drawn in amber is the
 * surface's own decision, made from `kind`, not from these words.
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
      return { said: `Paper needs a language model to define “${state.term}”.`, because: null }
    case 'tooLong':
      /* NAMES NO TERM, because there is no term — see `GlossState.tooLong`. The
         reader selected a paragraph and is looking at it. */
      return {
        said: 'That passage is too long to look up — select a word or a short phrase.',
        because: null,
      }
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlossProvider } from '../../core/gloss'

/**
 * One gloss at a time, for the word the reader is looking at.
 *
 * WI-15.13. A PROMISE rather than a stream, and the state below has three
 * shapes rather than a progress number, because two sentences arriving beside
 * a word is an appearance and not a download: streaming it would be jitter,
 * not progress.
 *
 * # It replaces rather than queues
 *
 * A reader looking up a second word has stopped caring about the first, so a
 * new request aborts the one in flight. Queueing would show them an answer
 * about a word they have moved on from, which is worse than showing nothing.
 */

export type GlossState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'asking'; readonly term: string }
  | { readonly kind: 'ready'; readonly term: string; readonly text: string }
  | { readonly kind: 'failed'; readonly term: string; readonly reason: string }

export interface Gloss {
  readonly state: GlossState
  /** Define `term`, in the sentence it sits in. */
  ask(term: string, sentence: string, bookTitle: string): void
  /** Put it away — the reader moved on. */
  dismiss(): void
}

export function useGloss(provider: GlossProvider): Gloss {
  const [state, setState] = useState<GlossState>({ kind: 'idle' })
  const abort = useRef<AbortController | null>(null)

  /* A gloss outliving the reader that asked for it is a request nobody will
   * read, and on a loaded machine that is a model still generating. */
  useEffect(
    () => () => {
      abort.current?.abort()
      abort.current = null
    },
    [],
  )

  const dismiss = useCallback(() => {
    abort.current?.abort()
    abort.current = null
    setState({ kind: 'idle' })
  }, [])

  const ask = useCallback(
    (term: string, sentence: string, bookTitle: string) => {
      if (!provider.available) return
      /* The previous one is abandoned, not queued — see the header. */
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      setState({ kind: 'asking', term })

      void provider
        .gloss(term, { sentence, bookTitle }, controller.signal)
        .then((text) => {
          if (controller.signal.aborted) return
          setState({ kind: 'ready', term, text })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          /* SAID, not swallowed. A lookup that silently did nothing is the
           * failure this whole path is easiest to get wrong in — the same
           * rule `lookUp` states for the system dictionary. */
          setState({
            kind: 'failed',
            term,
            reason: error instanceof Error ? error.message : 'That could not be defined.',
          })
        })
        .finally(() => {
          if (abort.current === controller) abort.current = null
        })
    },
    [provider],
  )

  return { state, ask, dismiss }
}

/**
 * The sentence `term` sits in, taken from the passage around it.
 *
 * THE WHOLE POINT OF THE FEATURE is the sense on this page, so the sentence
 * is what the model gets — not the paragraph, and not the word alone. A
 * dictionary gives every sense of *close*; this gives the one in front of the
 * reader.
 *
 * `prefix` and `suffix` are the selection's own context, which the session
 * already carries for mark anchoring — so this needs no second walk of the
 * document.
 */
export function sentenceAround(prefix: string, term: string, suffix: string): string {
  /* Backwards to the last terminator before the term, forwards to the first
   * after it. `[.!?。！？]` covers the CJK terminators too, which matters here:
   * this codebase carries CJK typography throughout and the model was chosen
   * for it. */
  const before = prefix.split(/(?<=[.!?。！？])\s+/).pop() ?? prefix
  const after = suffix.split(/(?<=[.!?。！？])/)[0] ?? suffix
  const sentence = `${before}${term}${after}`.trim().replace(/\s+/g, ' ')
  /* A selection with no context either side is its own sentence — better than
   * an empty string, which would ask the model to define a word in a vacuum
   * and get back the dictionary answer this feature exists to improve on. */
  return sentence === '' ? term : sentence
}

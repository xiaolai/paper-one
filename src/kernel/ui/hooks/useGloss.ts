import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlossProvider } from '../../core/gloss'
import type { Diagnostics } from '../../core/ports'
import { sentenceAt } from '../reader/wordSnap/sentenceAt'

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
  /**
   * Asked, with nothing installed to answer with.
   *
   * ⚠️ **THIS USED TO BE A SILENT `return`.** `ask` began `if
   * (!provider.available) return`, which was harmless while the reader had
   * Dictionary.app behind it — the lookup went to the system dictionary and
   * the gloss simply did not contribute. With the hand-off deleted the gloss
   * is the whole feature, and a press that does nothing at all is the exact
   * failure `lookUpTauri.ts` used to warn about in its own header: *a lookup
   * that silently did nothing is the failure this path is easiest to get wrong
   * in.*
   *
   * A STATE RATHER THAN A REDIRECT. `useGloss` is the kernel's, and it has no
   * business knowing that a models pane exists or how to open one — see
   * `GlossStrip`, which takes the action as a prop and draws nothing when
   * there is none.
   */
  | { readonly kind: 'unavailable'; readonly term: string }

export interface Gloss {
  readonly state: GlossState
  /**
   * Whether a definition can be produced right now — the provider's own
   * answer, forwarded.
   *
   * HERE SO THE CALLER CAN AVOID WORK, not so it can avoid `ask`: `ask`
   * handles an unavailable provider itself and must go on doing so, because it
   * is the only thing that can set `unavailable`. What this saves is the
   * document walk in `glossRequest` — see `askGloss`.
   */
  readonly available: boolean
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
      /* NOTHING TO ASK. Said, not swallowed — see `unavailable` above. The
       * request in flight still goes, because a reader who asked a second
       * question has stopped caring about the first either way. */
      if (!provider.available) {
        abort.current?.abort()
        abort.current = null
        setState({ kind: 'unavailable', term })
        return
      }
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
            /* NOT "That could not be defined" any more: since WI-16.3 the view
             * already says "Paper couldn't define …", and the two together read
             * as the same apology twice. This says only what the first line
             * cannot — which, when a rejection carried no message, is nothing. */
            reason: error instanceof Error ? error.message : 'No reason was given.',
          })
        })
        .finally(() => {
          if (abort.current === controller) abort.current = null
        })
    },
    [provider],
  )

  return { state, available: provider.available, ask, dismiss }
}

/** What a lookup actually sends: a sentence, and the term as that sentence
 *  spells it — see `sentenceAt` on why the two travel together. */
export interface GlossRequest {
  readonly term: string
  readonly sentence: string
}

/** The fields of a `SelectionSnapshot` a lookup reads. Named separately so this
 *  module does not depend on the reader session's whole shape. */
export interface GlossSelection {
  readonly text: string
  readonly prefix: string
  readonly suffix: string
  /** In the BOOK document's coordinate space. */
  readonly range: Range
}

export interface GlossRequestOptions {
  /**
   * The book cannot reflow — a PDF, or an EPUB declaring `pre-paginated`.
   *
   * These take the fallback, and WI-16.5 MEASURED why rather than assuming it —
   * separately for each format, because `fixedLayout` covers both and one
   * cannot justify the other. In a PDF a run is one visual LINE (pdf.js gives
   * every line its own absolutely positioned span); in the pre-paginated EPUB
   * measured, it is one WORD. Neither yielded a single vouched sentence in ten
   * samples, against two in ten for the reflowable control. Transcript:
   * `dev-docs/plans/evidence/wi-16-5-measurements.md`.
   */
  readonly fixedLayout?: boolean | undefined
  readonly diagnostics?: Diagnostics | undefined
}

/**
 * What to send for a lookup: the real sentence, or today's answer.
 *
 * **THE REUSE SITE, and the defect this phase exists to fix.** The fallback
 * below reads `prefix`/`suffix`, which are `markContext`'s 32 characters a
 * side — a budget sized for STORAGE, spent as a budget for MEANING. On one
 * ordinary sentence it handed the model 70 characters out of 183, beginning
 * `"en the bait"`, cut out of the middle of `taken`.
 *
 * `sentenceAt` walks the document instead and returns `null` rather than
 * anything it cannot vouch for, which makes this a strict improvement by
 * construction: **the worst outcome here is exactly what shipped before.** It
 * is called ONLY from the Look up gesture and never from `publish()` — a
 * second walk per `selectionchange` would be a walk per pointer move.
 *
 * The TERM comes back too, because a sentence with ruby readings filtered out
 * of it no longer contains the term the reader selected: `漢かん字` is what
 * `flatten` produces and `漢字` is what the sentence holds. Sending the raw
 * selection would ask the model to define a word that is not there.
 */
/**
 * What the Look up handler needs, with the one field that must not be forgotten
 * spelled REQUIRED.
 *
 * `fixedLayout` is optional on `glossRequest`, which is a primitive a test may
 * reasonably call with nothing. It is required HERE because this is the app's
 * own handler, and a caller that omitted it would silently start walking PDFs —
 * where a run is one visual line and the walk cannot vouch for anything (§16.5).
 * Required, that mutation is a compile error rather than a case somebody has to
 * have thought to write.
 */
export interface AskGlossOptions extends GlossRequestOptions {
  readonly fixedLayout: boolean
  readonly bookTitle: string
}

/**
 * The Look up handler, out of the component so it can be driven.
 *
 * `Reader` cannot be mounted cheaply — sixteen props, and it renders foliate —
 * so anything left inside it can only be checked by reading its source back,
 * and a source scan cannot tell a working wiring from a plausible-looking one.
 * Everything that turns a SELECTION INTO A REQUEST is here.
 *
 * ⚠️ **What is still not pinned by a test, precisely.** `Reader` keeps the
 * routing (`decideLookUp`), the `isLookUpTerm` guard, and the condition that
 * decides whether this is called at all — so deleting the call survives every
 * case in `useGloss.test.ts`. The field-level mutation is closed by the type
 * above; the call-level one is not, and closing it means mounting `Reader` or
 * extracting a smaller UI action boundary. Said here rather than left for
 * someone to assume otherwise.
 *
 * It got NARROWER when the system dictionary went. The gap used to include
 * `gloss || both` — a branch that decided whether the gloss fired alongside
 * Dictionary.app, mutable to `gloss` alone or to neither with nothing red.
 * There is one behaviour now, so that particular mutation no longer exists to
 * be missed.
 */
export function askGloss(
  gloss: Pick<Gloss, 'ask' | 'available'>,
  selection: GlossSelection | null,
  options: AskGlossOptions,
): void {
  if (!selection) return
  /*
   * ⚠️ **NO DOCUMENT WALK FOR A LOOKUP THAT CANNOT REACH A MODEL**, and the
   * reason is the DIAGNOSTIC rather than the cycles.
   *
   * `glossRequest` calls `sentenceAt`, which records `gloss.sentence` with the
   * outcome — the §F4 counter that exists because *"a build where every lookup
   * silently falls back looks identical to a working one"*. With the
   * Dictionary.app hand-off deleted, the button now also fires on a machine
   * with NO model installed, where it can only ever produce the install
   * prompt. Walking there would file a sample per press for a lookup that
   * never happened — and on a machine with no model that is EVERY sample, so
   * the one instrument that can answer "is the walk working" would be reading
   * pure noise exactly where it is hardest to check by hand.
   *
   * `ask` still decides what an unavailable provider does; this only declines
   * to prepare an argument it will not use. The raw selection is passed
   * because the message names what the reader tried to look up, and the
   * sentence-spelled term is a thing only the walk could have produced.
   */
  if (!gloss.available) {
    gloss.ask(selection.text, '', options.bookTitle)
    return
  }
  const request = glossRequest(selection, options)
  gloss.ask(request.term, request.sentence, options.bookTitle)
}

export function glossRequest(
  selection: GlossSelection,
  options: GlossRequestOptions = {},
): GlossRequest {
  if (options.fixedLayout) {
    /* Guarded for the reason `sentenceAt` guards its own: `Diagnostics` has no
     * no-throw contract, and a counter that can abort the lookup it counts is
     * worse than no counter. */
    try {
      options.diagnostics?.info('gloss.sentence', { outcome: 'fallback', gap: 'fixed-layout' })
    } catch {
      /* Nothing to report it to — see above. */
    }
  } else {
    const found = sentenceAt(selection.range, { diagnostics: options.diagnostics })
    if (found) return found
  }
  return {
    term: selection.text,
    sentence: sentenceAround(selection.prefix, selection.text, selection.suffix),
  }
}

/**
 * The sentence `term` sits in, taken from the passage around it.
 *
 * THE FALLBACK, since WI-16.4 — `glossRequest` reaches this only when
 * `sentenceAt` could not vouch for a sentence, which is the first and last
 * sentence of every block, a selection spanning two of them, a `<br>` in the
 * middle of one, and a fixed-layout book. Kept exactly as it was, because
 * "no worse than today" is the rule and rewriting it would break that claim.
 *
 * **Two defects in it are measured and not fixed here.** It is a NO-OP on
 * Chinese — the split is `/(?<=[.!?。！？])\s+/`, and although the lookbehind
 * lists the CJK terminators the pattern still requires `\s+` after them, which
 * Chinese does not write; `'他说。然后'.split(…).pop()` returns the whole string.
 * And an abbreviation before the term erases the entire prefix:
 * `'He met Mr. '.split(…).pop()` is `''`. Both are reasons to prefer
 * `sentenceAt`, not reasons to patch a fallback whose value is that it is
 * unchanged.
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

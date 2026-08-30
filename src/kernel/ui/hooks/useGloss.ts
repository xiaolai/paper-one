import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlossProvider } from '../../core/gloss'
import type { Diagnostics } from '../../core/ports'
import { termVerdict } from '../lookUp'
import { localeAt, sentenceAt } from '../reader/wordSnap/sentenceAt'
import { sentenceOf } from '../reader/wordSnap/sentenceOf'

/**
 * One gloss at a time, for the word the reader is looking at.
 *
 * WI-15.13. A PROMISE rather than a stream, and the state below is a handful
 * of named shapes rather than a progress number, because two sentences
 * arriving beside a word is an appearance and not a download: streaming it
 * would be jitter, not progress.
 *
 * Five non-idle shapes since the system-dictionary hand-off went: `asking`,
 * `ready`, `failed`, `unavailable` and `tooLong`. The last two are both
 * presses that never reach a model, and both used to be impossible or silent:
 * `unavailable` because Dictionary.app was always behind the gesture, and
 * `tooLong` because `lookUpPress` simply `return`ed.
 *
 * # It replaces rather than queues
 *
 * A reader looking up a second word has stopped caring about the first, so a
 * new request aborts the one in flight. Queueing would show them an answer
 * about a word they have moved on from, which is worse than showing nothing.
 *
 * # It does not outlive the passage it describes
 *
 * A gloss is anchored to a word on a page, and every neighbouring surface is
 * taken down when that page stops being shown — `SelectionTools` on a page
 * turn and on leaving the reader, `FootnotePopover` on both. This one was
 * not: it had exactly one route out, the strip's own × button, so an amber
 * definition survived a page turn, a chapter change, a different book, and a
 * trip to the library and back. See `GlossAnchor`.
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
  /**
   * ⚠️ **`installable` IS READ AT THE PRESS AND CARRIED**, because the two
   * facts are answered a render apart. `decideLookUp` reads the provider when
   * the button is DRAWN; this state is reached when it is PRESSED, and
   * availability can drop in between — uninstalling the only text model is the
   * ordinary way. `Reader` passed `onInstall` to the strip unconditionally on
   * the argument that `unavailable` "can only be reached when `decideLookUp`
   * answered `install`", which is false for exactly that window: the strip
   * then offered **Install one** with no runtime to install into, which is the
   * WI-20.21 failure `GlossProvider.installable` exists to prevent. Answered
   * at the moment of use, like `available` beside it, so there is no snapshot
   * left for anything to go stale against.
   */
  | { readonly kind: 'unavailable'; readonly term: string; readonly installable: boolean }
  /**
   * Asked with a passage rather than a term.
   *
   * ⚠️ **THIS USED TO BE A SILENT `return` TOO**, in `lookUpPress`, and it
   * outlived the fix for its twin above by a whole phase. A reader who
   * selected more than `MAX_TERM` code points and pressed Look up got no
   * definition, no message and no diagnostic — a live button that did nothing,
   * indistinguishable from a broken feature.
   *
   * IT CARRIES NO TERM, and that is deliberate rather than an omission. The
   * term here is a paragraph: naming it back is what `.glossFailedSaid` and
   * `.glossAbsentSaid` had to be made shrinkable for, and neither of them
   * ellipsizes. The sentence needs no name — the reader is looking at what
   * they selected — and quoting a chapter into a one-line strip says nothing
   * the reader does not already know.
   */
  | { readonly kind: 'tooLong' }

export interface Gloss {
  readonly state: GlossState
  /**
   * Define the selection.
   *
   * ⚠️ **`request` IS A THUNK, AND THAT IS THE WHOLE POINT.** It used to be a
   * `(term, sentence)` pair, with the caller deciding whether to build one and
   * this deciding whether to send it — TWO reads of the provider's live
   * `available` getter, with a window between them. An audit found the window;
   * the first fix moved it rather than closing it, and the verify pass said so:
   * a press that arrived just as a model appeared was dropped instead of being
   * sent malformed.
   *
   * Deferring the build collapses both into ONE decision, made here, at the
   * moment of use. If there is a model, the thunk runs and the request is sent.
   * If there is not, the thunk never runs — which is also what keeps the
   * document walk (and its §F4 diagnostic) off a path that cannot reach a
   * model. There is no longer a snapshot for anything to go stale against.
   *
   * `fallbackTerm` is what the `unavailable` message names, and what the term
   * bound is measured against, because the thunk that would have produced the
   * sentence-spelled term is exactly what did not run. The raw selection is
   * the right thing to measure either way: it is what the READER chose, and a
   * walk that trimmed ruby out of a paragraph would not make that paragraph a
   * term.
   */
  ask(request: () => GlossRequest, fallbackTerm: string, bookTitle: string): void
  /** Put it away — the reader moved on. */
  dismiss(): void
}

/**
 * Where the gloss is anchored, or `null` when there is nowhere.
 *
 * An OPAQUE KEY, and the hook never reads inside it: a change means "the
 * passage this gloss describes has stopped being shown", and `null` means the
 * reader is not looking at a book at all. Both take the gloss down.
 *
 * ⚠️ **IT IS DELIBERATELY NOT THE READING POSITION**, and that is measured
 * rather than assumed. The strip is a flex child of the reader's column beside
 * `.stage`, which is `flex: 1` — so the strip APPEARING shrinks the stage,
 * foliate re-paginates, and a relocate lands with a new fraction and possibly a
 * new CFI. An anchor keyed on either would then dismiss the gloss that had just
 * caused the reflow, grow the stage back, and relocate again: a flicker loop,
 * driven by the fix. The spine item and the chapter cannot be moved by a
 * reflow, so they are what `Reader` builds the key from.
 *
 * That leaves ONE case uncovered and it is stated rather than glossed over: a
 * jump to a different place in the SAME chapter (a mark in this chapter, a
 * backlink within it) does not change the key, so the strip survives it. The
 * page turn — every route of it — is covered by `Reader` calling `dismiss()` at
 * `onPageIntent`, on the line `clearSelection()` is already on and for the
 * identical reason.
 */
export type GlossAnchor = string | null

export function useGloss(provider: GlossProvider, anchor: GlossAnchor = null): Gloss {
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

  /*
   * ⚠️ **THE PROMPT HAS TO GO AWAY WHEN ITS REASON DOES.**
   *
   * `unavailable` says "Paper needs a language model" and offers the download.
   * Nothing cleared it when the download finished, so a reader who took the
   * offer came back to a strip still telling them to take it — the app
   * reporting a state it was no longer in, which is the failure the whole
   * amber/grey provenance scheme exists to avoid in the other direction.
   *
   * Found by audit. Only this state is reconciled: a `ready` gloss stays,
   * because it is still the answer to the word they asked about, and a
   * `failed` one stays because a model appearing does not un-fail it.
   */
  useEffect(() => {
    if (!provider.available) return
    setState((current) => (current.kind === 'unavailable' ? { kind: 'idle' } : current))
  }, [provider.available])

  /*
   * ⚠️ **A GLOSS DOES NOT OUTLIVE THE PASSAGE IT DESCRIBES.**
   *
   * `dismiss` had exactly one caller — the strip's own × — so an amber
   * definition survived a page turn, a chapter change, opening another book,
   * and going to the library and back. Every surface beside it is taken down
   * on those events with the reasoning written out (`SelectionTools` on the
   * page intent and on `inert`, `FootnotePopover` on both); this one got none
   * of it, and it is the one drawing MACHINE-WRITTEN text in the reader's own
   * page, attributed to a word that is no longer there.
   *
   * The in-flight request goes with it, which is the other half: a gloss
   * requested just before a page turn used to land on the next page and
   * render. `dismiss` aborts, so the daemon is told too.
   *
   * HERE RATHER THAN IN `Reader`, so the rule can be RUN. `Reader` takes
   * sixteen props and renders foliate — nothing in it can be mounted cheaply,
   * which is the whole reason `lookUpPress` and `askGloss` were extracted —
   * and a rule left there could only ever be checked by reading the file back.
   */
  useEffect(() => {
    dismiss()
  }, [anchor, dismiss])

  const ask = useCallback(
    (request: () => GlossRequest, fallbackTerm: string, bookTitle: string) => {
      /* NOT A TERM, AND SAID SO. `lookUpPress` used to hold this bound and
       * `return` on it: a live button, an accepted press, and nothing at all.
       * It is decided HERE because the answer to it is a state, and states are
       * this hook's — see `termVerdict` for why the two false cases had to
       * come apart before either could be answered.
       *
       * FIRST, ahead of `available`, because it is a fact about what the
       * READER chose and is true whether or not a model exists. "Paper needs a
       * language model to define <a chapter>" is the wrong sentence twice
       * over. An EMPTY selection is the one thing that genuinely has nothing
       * to say — there is no passage to refuse and no message to write about
       * it — so it leaves the state alone rather than inventing a report. */
      const verdict = termVerdict(fallbackTerm)
      if (verdict === 'empty') return
      if (verdict === 'too-long') {
        abort.current?.abort()
        abort.current = null
        setState({ kind: 'tooLong' })
        return
      }
      /* THE ONLY READ OF `available` ON THIS PATH. Said, not swallowed — see
       * `unavailable` above. The request in flight still goes, because a
       * reader who asked a second question has stopped caring about the first
       * either way. */
      if (!provider.available) {
        abort.current?.abort()
        abort.current = null
        /* READ HERE, not at the draw — see `unavailable`. */
        setState({ kind: 'unavailable', term: fallbackTerm, installable: provider.installable })
        return
      }
      /* BUILT ONLY NOW, past the one check that decides. */
      const { term, sentence } = request()
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

  return { state, ask, dismiss }
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
 * ⚠️ **What is still not pinned by a test, precisely.** Deleting the CALL to
 * this from `Reader` survives every case in `useGloss.test.ts`, and closing
 * that means mounting `Reader` — sixteen props and foliate — or a
 * dependency-cruiser `reachable` rule over the call graph. Said here rather
 * than left for someone to assume otherwise.
 *
 * It is narrower than it was, twice over. The gap used to include
 * `gloss || both`, a branch deciding whether the gloss fired alongside
 * Dictionary.app; there is one behaviour now, so that mutation no longer
 * exists. And it used to include the whole lookup decision — draw a control or
 * not, guard the term or not — which now lives in `lookUpPress` and is RUN by
 * `lookUp.test.ts` rather than scanned for.
 *
 */
export function askGloss(
  gloss: Pick<Gloss, 'ask'>,
  selection: GlossSelection | null,
  options: AskGlossOptions,
): void {
  if (!selection) return
  /*
   * ⚠️ **THE WALK IS DEFERRED, NOT CONDITIONAL.** This used to read
   * `gloss.available` and skip `glossRequest` itself, which put a second
   * decision here and left a window against `ask`'s own check. Handing over a
   * thunk means the walk happens if and only if `ask` decides to send — one
   * decision, and no snapshot for it to disagree with.
   *
   * The walk stays off the no-model path for the reason it always did, and it
   * is the §F4 counter rather than the cycles: `glossRequest` files
   * `gloss.sentence` with its outcome, and on a machine with no model every
   * sample would be for a lookup that never happened. On such a machine that
   * is EVERY sample, so the one instrument that answers "is the sentence walk
   * working" would be reading pure noise.
   *
   * The raw selection text is what the `unavailable` message names — the
   * sentence-spelled term is a thing only the walk could have produced.
   */
  gloss.ask(() => glossRequest(selection, options), selection.text, options.bookTitle)
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
    /* THE LOCALE COMES FROM THE RANGE, not from the walk that did not happen.
     * It is one climb of the ancestor chain, and `localeAt` is total — a
     * document torn down between the selection and the press answers
     * `undefined`, which means the host's, rather than losing the lookup. */
    sentence: sentenceAround(selection.prefix, selection.text, selection.suffix, {
      locale: localeAt(selection.range),
    }),
  }
}

export interface SentenceAroundOptions {
  /** The document's own, from `localeAt`. `undefined` means the host's. */
  readonly locale?: string | undefined
}

/**
 * The sentence `term` sits in, taken from the passage around it.
 *
 * THE FALLBACK, since WI-16.4 — `glossRequest` reaches this only when
 * `sentenceAt` could not vouch for a sentence, which is the first and last
 * sentence of every block, a selection spanning two of them, a `<br>` in the
 * middle of one, and a fixed-layout book.
 *
 * ⚠️ **IT CARRIED A SECOND SEGMENTATION POLICY, AND BOTH OF ITS DEFECTS WERE
 * MEASURED.** The split was `/(?<=[.!?。！？])\s+/`, and phase 16 recorded what
 * that costs while deliberately leaving it alone — *"no worse than today"* was
 * that phase's rule, and rewriting the fallback would have broken the claim it
 * was making about the walk:
 *
 * - **A NO-OP on Chinese.** The lookbehind lists the CJK terminators, but the
 *   pattern still requires `\s+` after them and Chinese does not write one, so
 *   `'他说。然后'.split(…).pop()` returns the whole string. Every Chinese lookup
 *   that reached the fallback sent the raw 32-character window.
 * - **An abbreviation erased the whole prefix**: `'He met Mr. '.split(…).pop()`
 *   is `''`, so the model was told the term began the sentence.
 *
 * ⚠️ **AND IT LANDED HARDEST WHERE IT WAS ALWAYS USED.** A fixed-layout book —
 * a PDF, or an EPUB declaring `pre-paginated` — skips `sentenceAt` entirely
 * (WI-16.5 measured why: a run is one visual LINE in a PDF and one WORD in the
 * pre-paginated EPUB sampled). So for a Chinese PDF the two defects were not an
 * edge case, they were the whole feature.
 *
 * The fix is not a better regex. `sentenceOf` already holds THE segmentation
 * policy — `Intl.Segmenter`, which splits `。` correctly under every locale tag
 * (measured, including the `lang="en"` that `makePdf` stamps on a generated
 * page), plus the bounded merge that keeps `Mr.` with the name after it. What
 * this needed from it was the segmentation without §C1's completeness gate,
 * because a 32-character window is cut mid-sentence by construction and the
 * gate would decline every time. That is `requireComplete: false`, and one
 * policy with two tolerances is the point: a second copy is what was wrong.
 *
 * STILL NO SECOND WALK. `prefix` and `suffix` are the selection's own context,
 * which the session already carries for mark anchoring; only the LOCALE is read
 * from the document, by one climb of the ancestor chain.
 *
 * Never worse than the window it was given: when `sentenceOf` cannot answer at
 * all, the squeezed window is returned, which is what the regex produced on
 * every input it failed on.
 */
export function sentenceAround(
  prefix: string,
  term: string,
  suffix: string,
  options: SentenceAroundOptions = {},
): string {
  const raw = `${prefix}${term}${suffix}`
  const found = sentenceOf(raw, prefix.length, prefix.length + term.length, {
    locale: options.locale,
    /* THE ONE CALLER THAT PASSES THIS. See `SentenceOptions.requireComplete`:
     * declining is a real answer for `sentenceAt`, which has this function
     * behind it, and no answer at all here, which has nothing. */
    requireComplete: false,
  })
  if (found.ok) return found.sentence
  /* Everything `sentenceOf` refuses outright — an empty window, a term that
   * squeezes to nothing, a run past its bound — lands here, which is the
   * window as the regex would have left it. A selection with no context either
   * side is its own sentence: better than an empty string, which would ask the
   * model to define a word in a vacuum and get back the dictionary answer this
   * feature exists to improve on. */
  const squeezed = raw.trim().replace(/\s+/g, ' ')
  return squeezed === '' ? term : squeezed
}

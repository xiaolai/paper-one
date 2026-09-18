import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { AudioLines, ChevronLeft } from 'lucide-react'
import { ICON } from '../../core/metrics'
import type { Speaking, Voice } from '../../core/voice'
import type { GlossState } from '../hooks/useGloss'
import { lookUpSays } from '../lookUpWords'
import styles from './LookUpFace.module.css'

/**
 * The lookup, as a face of the selection popup (phase 17, L1).
 *
 * ## Why it is not a strip any more
 *
 * It was `GlossStrip`: a row at the foot of the reader's column, a flex sibling
 * of `.stage`. Its own appearance therefore shrank the stage, and foliate
 * re-paginated the book around it. Measured in the running app on 2026-09-13 —
 * Look up on `wharves`, on the last line of a page: the stage went from 802px to
 * 744px, the word moved from (200, 817) to the next page at (968, 95), and the
 * selection popup vanished with it. Closing the strip put it all back. The
 * answer made the question disappear, on exactly the words a strip's height can
 * push off a page.
 *
 * Phase 17 had already named the principle when it refused to open the pane on
 * a lookup — *"opening the pane re-lays-out the book, so auto-opening would move
 * the word the reader is looking at, at the exact moment they are looking at
 * it"* — and then shipped a surface that did the same thing at a smaller scale.
 *
 * The popup floats. It is placed by `place()` clear of every selected line, it
 * resizes nothing, and it is already the one surface beside the passage — which
 * is where §10's prototype draws Look up: *"the prototype's popup replaces its
 * own contents for Look up and Translate, with a back control"*.
 *
 * ## The doctrine this still keeps
 *
 * `core/gloss.ts`: a provider *"must never resolve with an apology, because an
 * apology rendered in amber reads as a definition."* So a failure is never
 * amber, never in the definition's element, and says "couldn't" rather than a
 * bare clause that scans as a gloss. `unavailable` and `tooLong` are not
 * failures and do not wear its words either, and neither is amber — Paper
 * speaking about itself is not a definition of anything.
 *
 * `asking` stays in the definition's element: "Looking…" is not mistakable for
 * a definition, and moving it would make every lookup jump between two shapes
 * on its way to an answer.
 *
 * ## What the reason gets that the strip could not give it
 *
 * The strip was one line, so a failure's reason was ellipsised — and it is the
 * only account the reader gets of why there is no definition. Here it wraps.
 */
export interface LookUpFaceProps {
  /** Never idle — an idle lookup is the bar, not this face. */
  readonly state: Exclude<GlossState, { readonly kind: 'idle' }>
  /** Back to the bar — which puts the lookup away. */
  readonly onBack: () => void
  /**
   * Take the reader to the settings section where they choose what answers
   * (`inference:gloss` in the app), or absent when this screen has nowhere to
   * send them. The section is the provider's answer, carried on the state — see
   * `GlossProvider.installAt`. (Named for the install it used to offer; the
   * section it opens is the one the provider names, whatever that holds.)
   */
  readonly onInstall?: ((section: string) => void) | undefined
  /**
   * The voice, for the pronunciation control beside the headword — the
   * machine's own in the app, `NO_VOICE` where nothing can speak.
   *
   * REQUIRED, unlike `onInstall`, and the difference is which way forgetting it
   * fails. An absent `onInstall` is a screen SAYING it has nowhere to send the
   * reader, which is a real answer a browser client gives. There is no "this
   * screen has no voice": either the machine can speak or it cannot, and the
   * port answers that. Optional, the omission would read as the second and be
   * the first — `hasDictionary` exactly, which `core/gloss.ts` records.
   */
  readonly voice: Voice
}

/**
 * The way back to the bar, on every face that has one — the marks, the ways to
 * copy, and the lookup.
 *
 * ONE DEFINITION BECAUSE IT IS ONE CONTROL (2026-09-13). `SelectionTools` and
 * this face each wrote it out, and the accessible name is the part that must not
 * differ: a screen-reader user who hears "Back to the selection tools" on one
 * face and anything else on another has been told there are two controls. Here
 * rather than there because the popup already imports this module and not the
 * other way round. The class stays the caller's — see `.back` in the stylesheet
 * for why the two rules are repeated rather than shared.
 */
export function BackToBar({
  onBack,
  className,
}: {
  readonly onBack: () => void
  /** The caller's own class — a CSS module's value, which may be undefined. */
  readonly className: string | undefined
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={onBack}
      title="Back"
      aria-label="Back to the selection tools"
    >
      <ChevronLeft size={ICON.control} strokeWidth={ICON.stroke} />
    </button>
  )
}

export function LookUpFace({ state, onBack, onInstall, voice }: LookUpFaceProps) {
  return (
    <div className={styles.lookUp}>
      <BackToBar className={styles.back} onBack={onBack} />
      <div className={styles.content}>
        <Said state={state} onInstall={onInstall} voice={voice} />
      </div>
    </div>
  )
}

/**
 * THE PRONUNCIATION, AS A STATE THE POPUP SUBSCRIBES TO.
 *
 * §10's prototype draws a pronunciation straight after the headword, and it was
 * going to be IPA. It cannot be: a language model has no
 * phonetic data and would invent a transcription the reader has no way to check.
 * So the reader HEARS the word — see `core/voice.ts`, which is the port this
 * reads and carries that argument in full.
 *
 * ⚠️ **THE UTTERANCE MUST NOT OUTLIVE THE POPUP, AND THE STOP CONTROL GOES WITH
 * THE POPUP.** The deleted neural voice's `Test voice` row had this defect in
 * miniature — removing the model took the control off the screen while the
 * audio carried on with no way left to end it — and here the thing that goes
 * off the screen is the whole face: the reader presses Back, selects another
 * word, turns the page, or leaves the book, and every one of those takes the
 * lookup to `idle`, which unmounts this. So the rule is an UNMOUNT rather than
 * a list of events.
 * That is `useGloss`'s own answer to the same question (`useEffect(() => cancel,
 * [])`), and it is the only spelling that cannot miss a route somebody adds
 * later.
 *
 * The cleanup also runs when `voice` itself changes — which is how a voice
 * bound or unbound while the popup is open stops mid-word: the control is
 * redrawn against the new port, and the old one's utterance is stopped in the
 * same commit rather than playing on with nothing left to press.
 *
 * `stop()` also clears a `failed`, which is what stops a failure from a previous
 * press being drawn over the NEXT word the reader looks up — `systemVoice`'s
 * `stop` writes `idle` unconditionally, and `systemVoice.test.ts` pins it.
 */
function useSaying(voice: Voice): {
  readonly said: Speaking
  readonly say: (text: string, lang: string | null) => void
  readonly stop: () => void
} {
  const subscribe = useCallback((listener: () => void) => voice.subscribe(listener), [voice])
  /* A STORE RATHER THAN LOCAL STATE, because the utterance is the capability's:
     it ends on its own when the audio finishes, and nothing in this component
     would hear that. The third argument is the server snapshot, which this app
     never renders on a server — it is required, and answering `idle` is the same
     answer the client gives before anything has been pressed. */
  const said = useSyncExternalStore(
    subscribe,
    () => voice.state(),
    () => 'idle' as const,
  )
  useEffect(() => () => voice.stop(), [voice])
  return { said, say: (text, lang) => voice.say(text, lang), stop: () => voice.stop() }
}

/**
 * Whether to draw the control at all — SUBSCRIBED, not read once.
 *
 * ⚠️ **A STORE FOR AN ANSWER THAT CHANGES WITHOUT A RENDER.** `canSay` reads the
 * engine's voice list, and that list arrives ASYNCHRONOUSLY: an empty one means
 * "not loaded yet", which the port answers optimistically, so a control drawn
 * against it has to disappear when the real list turns out to have no voice for
 * the passage's language. Nothing in this tree re-renders for that on its own —
 * the port notifies, and `useSaying`'s own store would not re-render, because
 * `state()` has not moved. A separate subscription with a BOOLEAN snapshot does:
 * `useSyncExternalStore` compares snapshots by identity, and a boolean that
 * flips is a new snapshot where an unchanged `'idle'` is not.
 *
 * SEPARATE FROM `useSaying` and not folded into one composite snapshot, because
 * the decision has to be made by the component that renders `SayIt` rather than
 * inside it: the control's own unmount is what stops a live utterance (see
 * `useSaying`), and a `SayIt` that stayed mounted rendering nothing would leave
 * the word playing with nothing left to press.
 */
function useCanSay(voice: Voice, lang: string | null): boolean {
  const subscribe = useCallback((listener: () => void) => voice.subscribe(listener), [voice])
  return useSyncExternalStore(
    subscribe,
    () => voice.canSay(lang),
    /* The server snapshot, which this app never renders — and `false` is the
       safe answer for a surface with no engine behind it at all. */
    () => false,
  )
}

/**
 * The control: one glyph, two states, and nothing at all to say about a third.
 *
 * THE APP'S OWN SPEECH GLYPH. `TitleBar` draws Listen with lucide's
 * `AudioLines`, along with `data-on` and `aria-pressed` for "it is running now";
 * a second drawing for the same idea would be two icons a reader has to learn
 * separately. Pressed IS speaking, so the same button stops it — the Models
 * pane's `Test voice` row, while it existed, swapped Play for Stop because it
 * had a words-wide slot to do it in, and this has one glyph beside a headword.
 *
 * IT CANNOT TAKE FOCUS OR DISMISS THE POPUP. The popup cancels `pointerdown` on
 * itself (`SelectionTools`), which is what keeps the book's selection alive —
 * and suppressing the default there suppresses the focus that would follow it,
 * so a press here leaves the reader's focus exactly where it was. Nothing in
 * this handler turns a face or touches the lookup's state.
 *
 * ⚠️ **THE ACCESSIBLE NAME DOES NOT CHANGE WITH THE STATE, AND THAT IS ABOUT
 * THE BOX IT SITS IN.** The definition carries `role="status"`, which is a live
 * region with an implicit `aria-atomic` — so text that changes inside it is
 * re-announced WHOLE. A label that swapped to "Stop saying …" on every press
 * would read the entire definition back to a screen-reader user for pressing
 * play. `aria-pressed` is what a toggle says instead, which is the pattern the
 * title bar's own Listen control already uses; the `title` still swaps, because
 * a tooltip is a pointer affordance and says nothing to anybody else.
 *
 * The failure notice below DOES change the region's text, and should: it is the
 * one thing here worth interrupting for.
 */
function SayIt({
  voice,
  term,
  lang,
}: {
  readonly voice: Voice
  readonly term: string
  /**
   * The language the PASSAGE declared, or null where it declared none.
   *
   * THE BOOK'S, NOT THE INTERFACE'S — see `Voice.say`. It comes down on the
   * lookup's own state (`GlossState.ready.locale`), resolved by the same climb
   * of the range that decides what language to answer IN, rather than being
   * read from the document here: this component has no range, and a second
   * climb would be a second answer to one question.
   */
  readonly lang: string | null
}) {
  const { said, say, stop } = useSaying(voice)
  const speaking = said === 'speaking'
  return (
    <>
      <button
        type="button"
        className={styles.say}
        data-on={speaking}
        aria-pressed={speaking}
        title={speaking ? 'Stop' : 'Say it aloud'}
        /* THE TERM IS IN THE LABEL and not only in the tooltip, for the reason
           every control in the bar carries one: a tooltip is reachable by
           pointer only, and a bare "Say it aloud" among words says nothing about
           which word. */
        aria-label={`Say “${term}” aloud`}
        onClick={() => (speaking ? stop() : say(term, lang))}
      >
        <AudioLines size={ICON.control} strokeWidth={ICON.stroke} />
      </button>
      {/* SAID, NOT SWALLOWED — the rule the whole face is built on. A press that
          produced no sound and no sentence is indistinguishable from a broken
          button. NOT AMBER and not in the definition's voice: this is Paper
          speaking about itself, exactly like `.absent` and `.refused`. */}
      {said === 'failed' && <span className={styles.unspoken}>Paper couldn’t say that aloud.</span>}
    </>
  )
}

function Said({ state, onInstall, voice }: Pick<LookUpFaceProps, 'state' | 'onInstall' | 'voice'>) {
  /* THE WORDS ARE `lookUpWords`', THE LAYOUT IS THIS FILE'S (#124). Marginalia
     draws the same lookup as a row and had its own copy of all four sentences,
     which is two places to edit and one to forget. */
  const { said, because } = lookUpSays(state)
  /* THE PASSAGE'S LANGUAGE, and `null` for every state that has none to give —
     `tooLong` carries no term at all, and the three that are Paper speaking
     about itself draw no pronunciation either way. Asked unconditionally
     because a hook cannot be called after a `return`. */
  const lang = state.kind === 'ready' || state.kind === 'asking' ? (state.locale ?? null) : null
  const canSay = useCanSay(voice, lang)

  /* NOT A TERM, so nothing here names one — see `GlossState.tooLong`. */
  if (state.kind === 'tooLong') {
    return (
      <p className={styles.refused} role="status">
        {said}
      </p>
    )
  }

  if (state.kind === 'unavailable') {
    /* ⚠️ BOTH HALVES, AND IT USED TO BE ONE — see `GlossState.unavailable`.
       `onInstall` says whether this SCREEN was given somewhere to send the
       reader; `installAt` says whether the build has anywhere worth sending
       them, read at the press.

       **"Choose one", NOT "Install one"** (2026-09-18). The local model is an
       opt-in download and no longer the only thing that can answer, so the way
       out is the section where the reader chooses — an endpoint, Claude, Codex,
       or the download — rather than a button that reads as "fetch 2.5 GB". */
    const section = state.installAt
    return (
      <div className={styles.absent} role="status">
        <span>{said}</span>
        {section !== null && onInstall && (
          <button type="button" className={styles.install} onClick={() => onInstall(section)}>
            Choose one
          </button>
        )}
      </div>
    )
  }

  if (state.kind === 'failed') {
    return (
      <div className={styles.failed} role="status">
        <span>{said}</span>
        {/* THE CAUSE ON ITS OWN LINE, which is what this face has room for and
            the row in Marginalia does not — see `LookUpWords.because`. */}
        <span className={styles.failedReason}>{because}</span>
      </div>
    )
  }

  return (
    /* AMBER, ALWAYS — machine-written text in the reader's own page, and
       `marks.ts` reserves the companion kind and its amber for exactly it. */
    <div className={styles.definition} data-kind="companion" role="status">
      {/* THE HEADWORD AND ITS PRONUNCIATION, ON ONE LINE — a dictionary entry's
          own order, and the place the IPA this replaces would have sat.
          A ROW RATHER THAN A THIRD CHILD of the definition: this box is a flex
          COLUMN, so a button added beside the term as a sibling would be a line
          of its own between the headword and the part of speech, which is not
          what §10 draws and not what a dictionary does.
          DRAWN WHILE `asking` TOO. The term is known from the press, so the word
          can be heard while the definition is still coming — and the alternative
          would make the box change shape on arrival, which is the same thing
          `asking` shares this element to avoid. */}
      <div className={styles.headword}>
        <span className={styles.term}>{state.term}</span>
        {/* ABSENT ENTIRELY where nothing can speak, never disabled — §07: a
            control that cannot do anything is "disabled and says why" with
            nothing to say. There is no install offer here either; see
            `core/voice.ts`.
            ⚠️ **AND THE CONDITION ASKS ABOUT THE LANGUAGE NOW.** It was
            `voice.available` — "can anything speak" — which is the right
            question for reading a chapter aloud and the wrong one for a word: a
            machine with only English voices would have said a Chinese term in
            one, and the reader would have believed it. `canSay` asks whether
            THIS word can be said properly, and an unknown voice list is allowed
            rather than refused; see `core/voice.ts`. */}
        {canSay && <SayIt voice={voice} term={state.term} lang={lang} />}
      </div>
      {/* THE PART OF SPEECH, BETWEEN THE HEADWORD AND THE MEANING — §10's
          prototype's own order, and a dictionary's.

          DRAWN ONLY WHEN THERE IS ONE, and nothing at all when there is not:
          this is a flex column with a gap, so an element rendered empty would
          be a visible space under the term on every answer a model did not mark
          (see `GlossState.ready` on why the field is optional rather than '').

          `state.kind` is narrowed because `asking` reaches this element too —
          "Looking…" shares the definition's box deliberately, so every lookup
          does not jump between two shapes on its way to an answer — and an
          `asking` state has no part of speech to draw.

          NOT AMBER. The amber is the term's and stays the term's: §01 asks that
          a machine's words carry it, not that every element of them does, and
          `screens/Reader.layout.test.ts` is what holds this line to grey. */}
      {state.kind === 'ready' && state.partOfSpeech !== undefined && (
        <span className={styles.partOfSpeech}>{state.partOfSpeech}</span>
      )}
      <span className={styles.body}>{said}</span>
    </div>
  )
}

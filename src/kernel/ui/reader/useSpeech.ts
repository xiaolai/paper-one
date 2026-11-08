import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Speaker, speechAvailable, type DoneReason, type SpeakPrefs, type SpeakerCallbacks } from './speaker'
import {
  blockIndexAt,
  sentenceIndexAt,
  stepParagraph as paragraphStep,
  stepSentence as sentenceStep,
  type ReadingPlan,
} from './readingCursor'
import { EngineSpeaker } from './engineSpeaker'
import type { AudioHost } from './enginePlayer'
import { engineVoiceFor } from './engineVoice'
import { routedSpeaker, speakerFor, type SeekingSpeaker } from './speakerRouting'
import type {
  ClipKey,
  ReadingSurface,
  SpeechRequest,
  SpeechSkipPrefs,
  SpokenAudio,
  SpokenSection,
  VoicePack,
} from '../../core/ports'

/**
 * Reading the book aloud, with the spoken word followed on the page.
 *
 * The highlight goes into the book document for the same reason the ruler's
 * band does: it has to sit on the text, in the text's own coordinate space, and
 * the host cannot draw there. It reuses the band's placement helpers rather
 * than growing a second way to put a rectangle behind a line.
 *
 * A READING IS LONGER THAN A SECTION. It used to be one utterance per spine
 * document, stopped by the cleanup that ran whenever the document changed — so
 * the voice fell silent at every chapter break, and for a PDF, where every page
 * is a section, at every page. And in paginated flow it fell silent to the
 * reader long before that: the voice walked off the visible page after the
 * first column and the page never turned to follow it. Now the reading is the
 * unit: it starts with the reader's Listen and ends with their stop, the end of
 * the book, or the engine failing — and a section ending, or changing under
 * the voice, is a step inside it.
 */

/**
 * The downloaded voices, as the reading needs them.
 *
 * `packs` is a FUNCTION: the catalogue changes while the app runs, and a
 * reading holding a snapshot would keep the platform voice after a pack
 * arrived. `host` is one too — an `AudioContext` costs a device, so it is made
 * on the first passage that needs it and not on every book that is opened.
 */
export interface ReadingEngine {
  readonly packs: () => readonly VoicePack[]
  readonly render: (request: SpeechRequest) => Promise<SpokenAudio>
  readonly host: () => AudioHost | null
}

/**
 * The reader, as a reading is given it.
 *
 * `sectionKey` is what says the section changed, by render, so the change lands
 * in one commit with everything else. Everything else a reading wants to know is
 * `surface`'s to answer, as of the moment it is asked: see `ReadingSurface` for
 * what makes that safe from a child of the component that commits it.
 */
export interface ReadingContext {
  readonly sectionKey: unknown
  readonly surface: ReadingSurface
}

export interface Speech {
  readonly available: boolean
  readonly speaking: boolean
  /** Paused mid-sentence, with the engine holding its place. */
  readonly paused: boolean
  /** False once the engine has shown it does not report word boundaries. */
  readonly followsWords: boolean
  start: () => void
  stop: () => void
  /**
   * THE CONTROL THAT NOW HAS A CALLER — see the note this replaces.
   *
   * The hook used to publish `paused`/`pause`/`resume` that nothing consumed,
   * and an audit removed them on the rule that a public surface grows in the
   * change that mounts it (round 1, #845). This is that change: the transport in
   * `TitleBar` is the caller, and `Speaker`'s engine-level pair — kept all along
   * for exactly this — is what they reach.
   */
  pause: () => void
  resume: () => void
  /**
   * One sentence, one paragraph or one chapter, in reading order.
   *
   * ⚠️ **THESE ARE WHY THE READING IS SENTENCE-AT-A-TIME AT ALL.** Web Speech
   * cannot seek inside an utterance, so with a whole section queued as one
   * utterance none of them could exist — the only way to move was to cancel and
   * start the chapter again. A sentence-sized utterance makes every one of them a
   * cursor move followed by an ordinary `speak`.
   */
  stepSentence: (by: -1 | 1) => void
  stepParagraph: (by: -1 | 1) => void
  stepChapter: (by: -1 | 1) => void
  /**
   * Where the reading has got to, and how long it is — `null` while nothing is
   * playing, and on a reading the platform speaker is doing.
   *
   * ⚠️ **NULL RATHER THAN ZEROS DURING A RENDER, WHICH IS THE LONGEST WAIT THIS
   * APP HAS.** WI-34.0 measured 315 s for a real section. A transport showing
   * `0:00 / 0:00` for both *"nothing is playing yet"* and *"the reading is at the
   * start"* would be lying for five minutes, so the two are different answers.
   */
  readonly at: { readonly positionMs: number; readonly durationMs: number } | null
  /**
   * A section is being made into audio and there is nothing to hear yet.
   *
   * ⚠️ **AND IT IS NOT BUFFERING, WHICH IS WHY IT HAS A NAME OF ITS OWN.**
   * WI-34.0 measured a real section at 315 s on an idle M4 Max. Calling that
   * "loading" would be a lie about a five-minute wait — nothing is arriving over
   * a wire; the machine is synthesising a voice. The transport says so, and says
   * it with a stop.
   */
  readonly preparing: boolean
  /**
   * Why the reading stopped, where it was not the reader's doing — `null`
   * otherwise.
   *
   * ⚠️ **A SENTENCE AND NOT A FLAG, BECAUSE THERE IS NOWHERE ELSE FOR IT TO
   * GO.** A reading that ends on its own leaves the Listen control back where it
   * was and nothing said; before this, a chapter that could not be rendered
   * looked exactly like a chapter that had finished. `DoneReason` is what the
   * speakers report, so the sentence is derived from it here rather than plumbed
   * through a contract both speakers share and only one can fill.
   */
  readonly refusal: string | null
  /**
   * Go to a fraction of the way through the section — 0 the start, 1 the end.
   *
   * Answers whether it moved. False on the platform speaker, which cannot seek
   * inside an utterance at all, and false before the render lands.
   */
  seekToFraction: (fraction: number) => boolean
  /**
   * Go to the word covering a character offset in the section's collected text —
   * which is what a reader tapping a word in the book gives.
   *
   * ⚠️ **FALSE WHERE THERE ARE NO WORD TIMINGS, AND THAT IS THE CHINESE CASE.**
   * Qwen answers none, so a Chinese reading can be scrubbed by fraction and not
   * seeked by word. Answering `true` and doing nothing would be worse.
   */
  seekToOffset: (offset: number) => boolean
  /**
   * Which directions `stepChapter` can actually go.
   *
   * ⚠️ **PUBLISHED SO THE TRANSPORT CAN LEAVE THE BUTTON OUT RATHER THAN DRAW A
   * DEAD ONE.** Without it the control would have to guess, and the honest answer
   * is known only here — see `SurfacePaging.chapter`, which a book that cannot
   * place the reader in its own contents does not supply.
   *
   * ⚠️ **AND IT WAS ONE BOOLEAN FOR BOTH DIRECTIONS, WHICH IS A DEAD BUTTON BY
   * ANOTHER ROUTE.** True meant "at least one direction exists", so in the first
   * chapter of every book the transport drew a Previous control that could not
   * go anywhere, and in the last chapter a Next one — the exact thing the flag
   * was added to prevent, at the two places a reader is most likely to be. The
   * caller already knew both answers separately and threw one away.
   */
  readonly chapters: { readonly back: boolean; readonly forward: boolean }
}

/**
 * How long a page turn is given to land before the voice may ask for another.
 *
 * Word boundaries arrive every few hundred milliseconds and the paginator's
 * turn animates over three hundred; every boundary in between still measures
 * the word as off-page, and foliate takes a turn asked for mid-animation rather
 * than dropping it — so without this, one word off the page was two pages
 * turned. Longer than the animation, shorter than the gap between words on a
 * page with nothing to read, so a second turn — a full-page figure between the
 * voice and its next word — is asked for on the next boundary after it.
 */
export const TURN_SETTLE_MS = 500

/**
 * At the end of a section: how often `next` is asked for, and for how long,
 * while no new document arrives.
 *
 * The voice walks the readable text, and a section can end with pages still
 * to turn — plates, a figure, a colophon. `next` is a page, not a section, and
 * nothing reports whether it moved; so it is asked once per tick until the
 * document changes, which is the next section arriving and being spoken. The
 * grace is what ends the reading at the end of the book, where `next` moves
 * nothing at all and the control would otherwise stay lit over silence. A
 * section loads well inside it; a scanned PDF page decoding on pdf.js's
 * fallback is the slow case, and it is inside it too.
 */
export const CONTINUE_TICK_MS = 800
/**
 * ⚠️ **A HEURISTIC, AND AN AUDIT SAID SO — THE FIX IS THE ONE `chapter.go` GOT,
 * AND IT HAS NOWHERE TO LAND YET.** End of book is inferred from `next` moving
 * nothing for this long, because `SpeechPaging.next` returns nothing: a section
 * that takes longer than this to arrive reads as the book ending, and `next` is
 * re-asked every tick without knowing whether the last one is still in flight.
 *
 * The chapter step had the same shape and was fixed by making `go` answer
 * whether it moved. `next` cannot be fixed that way from here: it is the
 * session's page turn over foliate's paginator, which does not report a
 * position change, so a boolean returned by this layer would be a guess wearing
 * a type. The number is sized against the slow case that was measured — a
 * scanned PDF page decoding on pdf.js's JS fallback — which is why it is four
 * seconds and not one. When the paginator reports whether a turn landed, this
 * grace and the tick both go, and `next` becomes `(): boolean` beside `go`.
 */
export const CONTINUE_GRACE_MS = 4000

/**
 * The preferences an absent argument stands for.
 *
 * A MODULE CONSTANT rather than a `{}` default, so the identity is stable across
 * renders. Nothing here puts it in a dependency array today — it is read through
 * a ref, like the paging — but a fresh literal per render is a trap left lying
 * for whoever does, and it costs one line not to leave it.
 */
const NO_PREFS: SpeakPrefs = {}

/**
 * What a section is read with: the reader's own skip choice.
 *
 * ⚠️ **ASKED OF THE REF, BY THE TWO THAT ASK**, because both run from callbacks
 * built once: an audit found a captured `prefs` read here, a reader turning notes
 * on mid-book got the old choice for every remaining section (2026-09-30).
 */
const skipOf = (prefs: SpeakPrefs): SpeechSkipPrefs => ({ notes: prefs.notesAloud ?? false })

/**
 * How often the position is sampled while a reading speaks.
 *
 * Four times a second: a scrubber that moves visibly without a tick per frame,
 * and `positionMs()` is two subtractions, so the cost is nothing. Off entirely
 * when nothing is playing — see the `at` state.
 */
export const POSITION_TICK_MS = 250


/**
 * ⚠️ **AN IMPLICIT STATE MACHINE, AND AN AUDIT ASKED FOR AN EXPLICIT ONE — THE
 * ANSWER IS NOT YET, AND HERE IS WHY IT IS NOT "NO".**
 *
 * The finding is right about the shape: speaking, engine-paused, gap-paused,
 * continuing and stopped are combinations of flags spread across state and a
 * dozen refs, so a combination nothing intends is representable. Several of this
 * branch's own fixes were exactly such a combination being reached — `paused`
 * left set across a stop, a continuation surviving a pause, a gap destroyed by a
 * chapter step that went nowhere.
 *
 * What a reducer alone would NOT fix is why the refs exist. The engine's
 * callbacks, the gap timer and the continuation tick all fire OUTSIDE React's
 * render, and each needs the value as of now — a reducer's state read from one
 * of them is the value as of the last render, which is the stale-closure class
 * this file documents again and again. So the real change is a reducer for the
 * PHASE, with the refs reduced to mirrors of it, and every timer and engine
 * callback dispatching a transition instead of writing flags. That is a rewrite
 * of the reading's core with timing as the whole of its risk, and it is worth
 * doing as its own change with its own measurement against a real engine — not
 * folded into a cleanup where the tests it would be judged by are the ones it
 * is rewriting.
 *
 * Until then each illegal combination found gets a test that names it, which is
 * what the eight in `useSpeech.test.tsx` about pause, stop and stepping are.
 */
export function useSpeech(
  { sectionKey, surface }: ReadingContext,
  prefs: SpeakPrefs = NO_PREFS,
  engine: ReadingEngine | null = null,
): Speech {
  const [speaking, setSpeaking] = useState(false)
  const [paused, setPaused] = useState(false)
  const [followsWords, setFollowsWords] = useState(true)
  /**
   * The position, sampled while a reading runs.
   *
   * ⚠️ **POLLED AND NOT PUSHED, BECAUSE THE SOUND HAS NOTHING TO PUSH WITH.**
   * `AudioBufferSourceNode` reports no progress; the only event it has is
   * `onended`. The word timers fire at word boundaries, which is several hundred
   * milliseconds apart and stops entirely on a Chinese reading, so a transport
   * driven by them would freeze. A tick while a reading speaks is the honest
   * shape, and it is off whenever nothing is playing.
   */
  const [at, setAt] = useState<Speech['at']>(null)
  /**
   * A section render in flight.
   *
   * ⚠️ **STATE AND NOT DERIVED FROM `at`, BECAUSE `at` IS NULL ON THE PLATFORM
   * SPEAKER TOO.** Web Speech reports no position at all, so `speaking && at ===
   * null` is *rendering* on one unit and *ordinary* on the other, and a transport
   * that could not tell them apart would tell a Windows reader their chapter was
   * being made for the whole of it.
   */
  const [preparing, setPreparing] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  /* Which section this hook last rendered with, for the walk that has to see the
   * next one arrive: see `continueReading`. */
  const sectionKeyRef = useRef(sectionKey)
  /* ⚠️ **THROUGH A REF, FOR THE REASON EVERY VALUE HERE IS.** `speakDocument` and
   * the speaker's callbacks are built once, and `ReadingSurface` is one object for
   * the life of its host, so nothing here should ever see this change. If it did,
   * a captured one would read a reader that had gone. */
  const surfaceRef = useRef(surface)
  /* READ AT `speak` TIME, never captured — see `SpeakPrefs`. A reading walks
   * many sections and each one is its own utterance, so a voice or rate the
   * reader changes mid-chapter takes effect at the next section rather than
   * needing the reading stopped and started again. */
  const prefsRef = useRef(prefs)
  /* THE DOWNLOADED VOICES, read at `speak` time for the reason above and one
   * more: the catalogue changes while the app runs. A reader who downloads a
   * pack mid-chapter gets it at the next sentence, where a captured snapshot
   * would keep the platform voice until the reading was restarted — which is
   * not something anybody would guess to do. */
  const engineRef = useRef(engine)
  /* The section AND what was worked out from it, together.
   *
   * Kept as one value on purpose. A boundary event arriving after the section
   * changed must not resolve offsets from the OLD chapter against the NEW document,
   * which is how the highlight ends up on an unrelated word. The section is bound
   * to the document its text came from, so that state is unrepresentable: it paints
   * there, and does nothing once that is no longer the document on screen. */
  const spokenRef = useRef<{
    section: SpokenSection
    /** The sentences and paragraphs of `section.text` — see `ReadingPlan`. */
    plan: ReadingPlan
    /** `documentLang`'s answer, kept so each sentence is spoken in it. */
    lang: string | null
    /**
     * Which section this is, for the artifact that will be kept of it.
     *
     * ⚠️ **DERIVED FROM THE SAME VALUE THE TEXT COMES FROM, WHICH IS WHY IT IS
     * HERE AND NOT IN A REF OF ITS OWN.** `EngineSpeakerDeps.clip` reads it at
     * `speak` time; held apart from `section`, the two could name different
     * sections, and the failure would be a whole chapter of audio filed under the
     * wrong key. Paired, that state is unrepresentable.
     */
    clip: ClipKey
    /**
     * Whether the whole section goes to the speaker, or one sentence at a time.
     *
     * ⚠️ **THE ENGINE TAKES A SECTION AND THE PLATFORM TAKES A SENTENCE, AND
     * BOTH ARE RIGHT.** Phase 34 renders a section once and keeps it, which makes
     * a seek a search in one `words` array — and Web Speech cannot seek inside an
     * utterance at all, so a section-long one there would take `stepSentence`,
     * `stepParagraph` and both gap settings with it. `speakerFor` is the same pure
     * function `routedSpeaker` uses to choose, so the unit and the routing cannot
     * disagree about which speaker is about to read.
     */
    unit: 'section' | 'sentence'
  } | null>(null)
  /**
   * Which sentence of the plan is being spoken.
   *
   * ⚠️ **THE WORD OFFSETS THE ENGINE REPORTS ARE RELATIVE TO THE UTTERANCE, AND
   * THE UTTERANCE IS NOW ONE SENTENCE.** So a boundary at index 0 is the first
   * word of THIS sentence, not of the section, and resolving it against the
   * collected text without adding the sentence's own start puts the highlight at
   * the top of the chapter for every sentence after the first. That is the same
   * trap `narrate`'s `byteSampleOffset` records — offsets that restart per
   * segment and read as absolute — and it is why this ref exists rather than the
   * cursor living only in state.
   *
   * A ref because the boundary handler is created once per utterance and reads
   * it as of now, exactly as `followsRef` and `readingRef` are.
   */
  const cursorRef = useRef(0)
  /**
   * Where the text of the CURRENT utterance begins in the section's text.
   *
   * ⚠️ **THE REBASE USED TO LOOK THE SENTENCE UP BY CURSOR, WHICH MEANT ASKING A
   * QUESTION THAT SOMETIMES HAS NO ANSWER.** A section the segmenter finds no
   * sentence in is spoken whole — see `speakDocument` — and the cursor then
   * points at a sentence that does not exist, so the handler needed a guard, and
   * the guard's only outcome was that such a section lost its follow-along
   * entirely. An OFFSET is what the arithmetic actually needs: the sentence's
   * start when there is one, and zero when the utterance is the whole text.
   * Nothing to look up, nothing to be undefined, and the band follows either.
   */
  const baseRef = useRef(0)
  /**
   * Speaks sentence `at`, answering whether there was one to speak.
   *
   * Written in the layout effect below rather than here, for the reason the rest
   * of these are (#505): the `Speaker` is memoised so that the engine is not
   * rebuilt under a live utterance, so its `onDone` cannot close over a callback
   * that changes — it reaches the committed one through this.
   */
  /* Stryker disable next-line ArrowFunction,BooleanLiteral: the layout effect below writes this on every commit, before anything can read it. */
  const advanceRef = useRef<(at: number) => boolean>(() => false)
  /* Stryker disable next-line ArrowFunction,BooleanLiteral: the same layout effect writes this on every commit, before a tap can arrive. */
  const seekRef = useRef<(offset: number) => boolean>(() => false)
  /** The tap listener on the section being read, while one is. */
  const tapOff = useRef<(() => void) | null>(null)
  /** This reading's hold on the book's pace, while it is reading. */
  const paceHold = useRef<(() => void) | null>(null)
  /** `endReading`, committed — see `advanceRef` for why this is a ref. */
  const endRef = useRef<() => void>(() => {})
  /** `continueReading`, so `resume` can restart a walk `pause` suspended. */
  const continueRef = useRef<() => void>(() => {})
  /** A section walk `pause` took down, waiting for `resume` to start it again. */
  const heldContinuation = useRef(false)
  /**
   * The silence between two sentences, while it is being waited out.
   *
   * ⚠️ **A GAP IS A STATE THE READING CAN BE INTERRUPTED IN**, which is the whole
   * difficulty: the reader can stop, pause, step or turn a chapter during it, and
   * every one of those must cancel it rather than let a sentence begin afterwards.
   * `pendingNext` is what the timer was going to speak, kept separately so that a
   * PAUSE can hold the gap and `resume` can pick it up — clearing the timer alone
   * would lose the reader's place at the one moment they asked not to lose it.
   */
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingNext = useRef<number | null>(null)
  /* Read inside the boundary handler, which is created once per utterance —
   * a captured `followsWords` would be the value at the time speech started. */
  /* SEEDED FROM THE STATE IT MIRRORS rather than from a literal of its own: the
   * layout effect below overwrites it at every commit, before any utterance can
   * report a boundary, so a separate initial value could never be read. */
  const followsRef = useRef(followsWords)
  /* THE READING: true from the reader's Listen until their stop, the end of
   * the book or an engine error. A ref, not state, because it is consulted
   * from engine callbacks and from the document effect, and both need the
   * value as of now rather than as of the last render. `speaking` is what the
   * controls show; this is what the hook is doing. */
  const readingRef = useRef(false)
  /** When `next` was last asked for a word — see `TURN_SETTLE_MS`. */
  const turnedAt = useRef<number | null>(null)
  /**
   * Whether the reading is catching the page up to a place it has just seeked to.
   *
   * ⚠️ **THIS IS WHAT TELLS A SEEK FROM A PEEK**, which are the two ways a spoken
   * word ends up behind the page and want opposite things — see the boundary
   * handler. Set by every backward-capable seek, cleared by the first boundary
   * that lands on a visible word. A ref rather than state: it is read inside a
   * callback the speaker owns, where a render's value would be the one from
   * whenever that callback was built.
   */
  const chasingRef = useRef(false)
  /** The end-of-section tick, while it runs. */
  const continuing = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* COMMITTED, NOT ASSIGNED DURING RENDER (audit round 1, #505). These refs
   * used to be written in the render body, so a render React abandoned — or a
   * concurrent one it had not committed — left engine callbacks and the
   * continuation tick reading a document the tree never showed. A LAYOUT
   * effect runs after commit and before the passive document effect below, so
   * the continuation's own ordering claim — "sectionKeyRef is reassigned before
   * that effect runs" — stays true, now of committed values only.
   *
   * ⚠️ **AND IT MAY NOT ASK `surface` ANYTHING.** This hook runs in a child of
   * whatever commits the surface, and a child's layout effects run first: here the
   * surface still answers for the previous commit. By the passive document effect
   * below it answers for this one, because React flushes every layout effect of a
   * commit before any passive one. */
  useLayoutEffect(() => {
    sectionKeyRef.current = sectionKey
    surfaceRef.current = surface
    prefsRef.current = prefs
    engineRef.current = engine
    followsRef.current = followsWords
  })

  // Stryker disable next-line ArrayDeclaration: `speechAvailable` reads nothing from this component, so whatever the list holds the memo is computed once.
  const available = useMemo(() => speechAvailable(), [])

  /**
   * Abandon a pause that has not finished, and what it was going to say.
   *
   * ⚠️ **NO `!== null` IN FRONT OF THE `clearTimeout`.** It read that way, and
   * the guard could not change the answer: clearing a handle that is not there
   * is specified to do nothing, so the branch and the straight line behaved
   * identically on every input and no test could tell them apart. The coalesce
   * is what the types need and the only thing left to get wrong — and getting it
   * wrong leaves a live timer, which the cases below do see.
   */
  const clearGap = useCallback(
    () => {
      clearTimeout(gapTimer.current ?? undefined)
      gapTimer.current = null
      pendingNext.current = null
    },
    // Stryker disable next-line ArrayDeclaration: this reads only refs, so a constant list is a constant identity whatever is in it.
    [],
  )

  /** End the section walk, if one is running — no `!== null` guard, for `clearGap`'s reason. */
  const clearContinuation = useCallback(
    () => {
      clearTimeout(continuing.current ?? undefined)
      continuing.current = null
    },
    // Stryker disable next-line ArrayDeclaration: this reads only a ref, so a constant list is a constant identity whatever is in it.
    [],
  )

  /** Take the spoken word off the page, if a section is being read. */
  const clearBand = useCallback(
    () => spokenRef.current?.section.clearWord(),
    // Stryker disable next-line ArrayDeclaration: this reads only a ref, so a constant list is a constant identity whatever is in it.
    [],
  )

  /**
   * Stop answering taps.
   *
   * ⚠️ **HELD BY THE READING, BECAUSE A TAP MEANS SOMETHING ONLY DURING ONE.** With
   * nothing being read there is nowhere to go, so a tap does what it always did.
   */
  const retireTap = useCallback(
    () => {
      tapOff.current?.()
      tapOff.current = null
    },
    // Stryker disable next-line ArrayDeclaration: this reads only a ref, so a constant list is a constant identity whatever is in it.
    [],
  )

  /* TYPED AS `SpeakerLike`, WHICH IS WHAT THE READING ACTUALLY TALKS TO. The
     inferred union `Speaker | SpeakerLike` has none of the optional members —
     the platform speaker declares no `at` and no seek — so the transport's
     scrubber could not be asked for even optionally. `Speaker` satisfies this
     interface; the optional members are exactly the difference between them, and
     they are the ones Web Speech genuinely cannot answer. */
  const speaker = useMemo<SeekingSpeaker | null>(
    () => {
      if (!available) return null

      /** The reading is over — ONE transition, see `endReading`. */
      const finish = () => endRef.current()

      /**
       * The section's text ran out and the reading has not: walk forward until
       * the next section arrives — its document effect speaks it and cancels this
       * — or the grace runs out, which is the end of the book.
       */
      const continueReading = () => {
        clearBand()
        retireTap()
        spokenRef.current = null
        turnedAt.current = null
        const from = sectionKeyRef.current
        const started = Date.now()
        const tick = () => {
          continuing.current = null
          if (!readingRef.current) return
          /* Already moved: the new document's effect is about to speak it, or
           * has. Asking `next` again here would turn its first page away before
           * a word of it was read. `sectionKeyRef` commits in the layout effect
           * above, which runs before that document effect, so this sees the
           * arrival first. */
          if (sectionKeyRef.current !== from) return
          if (Date.now() - started >= CONTINUE_GRACE_MS) {
            finish()
            return
          }
          surfaceRef.current.turn(1)
          continuing.current = setTimeout(tick, CONTINUE_TICK_MS)
        }
        tick()
      }

      /* Published so `resume` can restart a walk `pause` suspended — the memo owns
       * `continueReading`, and everything outside it reaches in through a ref. */
      continueRef.current = continueReading

      const callbacks: SpeakerCallbacks = {
        onWord: (index, length) => {
          const current = spokenRef.current
          if (!current || !followsRef.current) return
          // The section changed under the utterance; the words being reported no
          // longer exist on screen.
          if (!current.section.live()) return
          /* REBASED ONTO THE UTTERANCE — see `baseRef`. `index` counts from the
           * start of what was spoken, which is one sentence, so without its own
           * offset every sentence after the first would highlight words at the top
           * of the chapter. */
          /* ⚠️ **THE CURSOR FOLLOWS THE VOICE ON THE SECTION UNIT, AND NOTHING
           * ELSE WOULD MOVE IT.** On the platform's sentence unit `speakSentence`
           * writes it once per utterance. One buffer has one utterance for the
           * whole section, so without this the cursor would sit at 0 for
           * forty-eight minutes and `stepSentence` would jump to the top of the
           * chapter. `index` is an offset into the whole text here — `baseRef` is
           * 0 on this unit — so the plan can be asked directly. */
          if (current.unit === 'section') {
            cursorRef.current = sentenceIndexAt(current.plan, index)
          }
          const placed = current.section.paintWord(baseRef.current + index, length)
          if (!placed) return

          if (placed === 'visible') {
            turnedAt.current = null
            /* CAUGHT UP. The reading is looking at the page the reader is, so a
               later `behind` is theirs again rather than the seek's. */
            chasingRef.current = false
            return
          }
          /* ⚠️ **A WORD BEHIND THE PAGE MEANS TWO DIFFERENT THINGS, AND ONLY ONE
           * OF THEM IS A REASON TO TURN BACK.**
           *
           * | how the word got behind the page | what the reader wants |
           * |---|---|
           * | they flipped FORWARD to peek at something | their page, left alone |
           * | the READING seeked backward — a tap above, a scrub left, a step back | the page to follow the voice |
           *
           * Before phase 34 only the first existed, because the voice could only
           * ever move forward: `behind` fell through a bare `return` and the case
           * that pins it says so in as many words. Every seek this phase adds can
           * go backward, and with no way back the reading carried on above the top
           * of the page while the reader looked at text nobody was reading (found
           * by an independent audit, 2026-09-30).
           *
           * `chasing` is what tells them apart: a seek sets it, and the first
           * boundary that lands on a VISIBLE word clears it. So the reading
           * follows itself back exactly as far as it needs to and then stops
           * competing with the reader for the page.
           *
           * The settle throttle covers both directions from the one timestamp: a
           * turn either way is a page that has just moved, and a boundary arriving
           * during the reflow must not turn it again. */
          const by = placed === 'ahead' ? 1 : chasingRef.current ? -1 : null
          if (by === null) return
          const now = Date.now()
          if (turnedAt.current !== null && now - turnedAt.current < TURN_SETTLE_MS) return
          turnedAt.current = now
          surfaceRef.current.turn(by)
        },
        onDone: (reason: DoneReason) => {
          /* ⚠️ **`taken` MUST NOT CONTINUE, AND IT USED TO ARRIVE AS `ended`.**
           * The lookup popup's pronunciation speaks through the same single
           * engine, and `speak` cancels whatever is on it — so the reading's
           * utterance ended, its `end` event fired, and this read it as "the
           * section finished" and called `continueReading()`: pages walking
           * forward hunting the next section while the reader listened to one
           * word being pronounced. `engineHeldBy` in `speaker.ts` is what tells
           * the two apart now. Treated as an end rather than an error, because
           * nothing failed — the reader asked for something else. */
          /* ⚠️ **`no-voice` ENDS THE READING, AND WOULD NOT HAVE BY ITSELF.** Every
             reason below this falls through to "that sentence finished, go on" —
             so a refusal would have walked the book sentence by sentence, then
             page by page, refusing each one. Nothing here can be read until the
             voices change, and the Listen control says so. */
          if (reason === 'error' || reason === 'taken' || reason === 'no-voice' || !readingRef.current) {
            /* ⚠️ **NAMED, WHERE IT USED TO BE SILENT.** A chapter that could not
             * be rendered left the Listen control back where it was and nothing
             * said — indistinguishable from a chapter that had finished. `taken`
             * is the one that gets no sentence: the reader asked for something
             * else on the same engine, which is not a refusal. */
            setRefusal(refusalFor(reason))
            finish()
            return
          }
          /* THE NEXT SENTENCE FIRST, AND THE NEXT SECTION ONLY WHEN THERE IS NONE.
           *
           * `speakSentenceRef` answers false for a cursor past the last sentence,
           * which is exactly the condition that used to be the whole of this
           * branch: before the reading was sentence-at-a-time, an utterance ending
           * WAS the section ending. Now it usually is not, and the distinction is
           * the one `continueReading` must not be asked to make — it walks pages
           * hunting the next section, which mid-section would turn the page away
           * from prose nobody had read. */
          /* ⚠️ **ONE BUFFER HAS NO NEXT SENTENCE, SO THIS IS THE SECTION
           * ENDING.** On the engine's unit the whole section was one utterance:
           * its end IS the section's end, which is what `onDone` used to mean
           * before the reading was sentence-at-a-time. `advance` is the platform
           * unit's road and answers false past the last sentence, which is how
           * the two stay one function rather than two. */
          /* `!` and not `?.`: `spokenRef` is null only during the section walk,
           * which begins after the last utterance has already reported done, and
           * inside the commit between a section's cleanup and its document effect,
           * which no callback can interleave with. So a reading under way always
           * has a section here, and the optional chain was a branch no case could
           * take. */
          if (spokenRef.current!.unit === 'sentence' && advanceRef.current(cursorRef.current + 1)) {
            return
          }
          continueReading()
        },
        onNoBoundaries: () => {
          // Reading continues; only the follow-along is dropped. Leaving the
          // band parked on the first word for the rest of the chapter would be
          // worse than not drawing one.
          setFollowsWords(false)
          clearBand()
        },
      }

      const platform = new Speaker(callbacks)
      /* ⚠️ **THE ROUTER IS ALWAYS BUILT, AND IT USED TO BE BUILT ONLY IF AN ENGINE
       * WAS ALREADY THERE — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** The guard
       * read `if (!engineRef.current) return platform`, inside a memo whose
       * dependencies never move, so the decision was taken ONCE at the first
       * render. And `useVoicePacks` says in its own words that the port *"binds
       * during `start`, which can land after this hook's first render"* — so on a
       * desktop with a pack installed, whether the reader got seeking at all
       * depended on which of the two happened first.
       *
       * What that looked like: `speakDocument` reads the LIVE packs to choose its
       * unit, so it picked `'section'` and handed a whole chapter to Web Speech.
       * No scrubber (`at` stays null), no tap-to-seek, sentence stepping
       * re-speaking instead of seeking — the whole of this phase, silently absent,
       * with nothing failing anywhere.
       *
       * Building it unconditionally costs a phone one unused object and one
       * indirection: `speakerFor` answers `'platform'` for an empty pack list, and
       * a build with no voices capability has an empty list for ever. The engine
       * speaker is constructed, never asked. */
      const downloaded = () => engineRef.current
      return routedSpeaker(
        new EngineSpeaker(callbacks, {
          /* ⚠️ **READ AT CALL TIME, WHICH IS THE WHOLE FIX.** A captured
             `engineRef.current` is the stale value this file exists to avoid; and
             a `render` that answers a refusal rather than throwing is what makes
             the unreachable case — routed to the engine with no engine — a
             reported failure instead of a crash in a reading. */
          /* ⚠️ **NON-NULL, BECAUSE THE ROUTER IS WHAT GUARANTEES IT — AND THE
           * GUARDS THAT USED TO STAND HERE WERE UNREACHABLE, WHICH THE MUTATION
           * SWEEP PROVED.** `routedSpeaker` sends a passage to this speaker only
           * when `speakerFor(packs(), …)` answers `'engine'`, and `packs()` is
           * this same reference: with no engine it is `[]`, which answers
           * `'platform'` for every language there is. So none of these three is
           * called without one, and a `!engine` branch in front of them could
           * never come back true — a guard against a state an invariant already
           * prevents, which this repository removes rather than keeps.
           *
           * If that invariant ever breaks, the `TypeError` is caught by
           * `EngineSpeaker.#render` and reported as `onDone('error')`, which is
           * the same sentence a named refusal would have produced. */
          render: (request) => downloaded()!.render(request),
          host: () => downloaded()!.host(),
          /* ⚠️ **`?? {}` WAS HERE AND IT IS `engineVoiceFor`'s OWN DEFAULT**, so
           * the two spellings answered alike and no test could tell them
           * apart — the shape this repository records as an option that is the
           * default. Passing the value through is the one instruction. */
          choose: (lang, speakPrefs) =>
            engineVoiceFor(downloaded()!.packs(), lang, speakPrefs.voices),
          /* READ AT `speak` TIME, from the same value the text came from — see
             `spokenRef.clip`. Non-null for the reason above: every road to `speak`
             sets `spokenRef` first, so the fallback that used to stand here —
             a sentinel key naming no book — was a value nothing could reach, and
             the sweep reported every string in it as a survivor. */
          clip: () => spokenRef.current!.clip,
        }),
        platform,
        /* A CALL, which is what keeps the catalogue live for a reader who
           downloads a pack mid-chapter — and now also for one whose port bound
           after this memo ran. */
        () => downloaded()?.packs() ?? [],
      )
    },
    // Stryker disable next-line ArrayDeclaration: all of these are built once — `available` from an empty list, the rest from no dependency — so this list never moves.
    [available, clearGap, clearContinuation, clearBand, retireTap],
  )

  /* ⚠️ **THE ONE PREFERENCE THAT DOES NOT WAIT FOR THE NEXT `speak`.** A downloaded
   * voice is a whole section in one sound, so "the next sentence" is the next
   * chapter; a gain can change under the sound as it plays. Web Speech has no such
   * thing, and takes it from `prefsRef` per sentence like the rest. */
  const volume = prefs.volume ?? 1
  useEffect(() => {
    speaker?.setVolume(volume)
  }, [speaker, volume])

  /**
   * Speak one sentence of the plan, and say whether there was one.
   *
   * FALSE IS A REAL ANSWER AND NOT A FAILURE: it means the cursor has run off
   * the end of the section, which is how `onDone` tells "that sentence finished"
   * from "this section finished" without either of them counting sentences.
   *
   * ⚠️ **`prefsRef` IS READ HERE, PER SENTENCE, AND THAT IS THE SPEED CONTROL.**
   * Web Speech fixes an utterance's rate when it is created, so a rate change
   * could never reach a section-long utterance — the old comment said as much,
   * and promised the change would land "at the next section". A sentence-sized
   * utterance means it lands at the next SENTENCE, a few seconds away, with no
   * code to make it happen. Re-speaking the current sentence to apply it sooner
   * was considered and rejected: the reader would hear the same words twice.
   */
  const speakSentence = useCallback(
    (at: number): boolean => {
      /* ⚠️ **ASSERTED RATHER THAN CHECKED, BECAUSE THE CHECKS COULD NOT ANSWER
         NO.** Three guards stood here — no engine, no plan, no sentence at `at`
         — and every caller had already settled all three: `start` refuses to
         mark a reading under way without an engine, `speakDocument` sets the
         plan before anything can ask for a sentence of it, and the three that
         pass an index (`speakDocument`, `moveTo` via the cursor functions,
         `resume` from a gap it set itself) each pass one the plan has. So they
         were lines no test could reach, and the mutation of each failed nothing.
         What they did instead was answer `false` — "there was nothing to speak"
         — for a state that means the hook's own bookkeeping has broken, which is
         the Listen control staying lit over silence. Wrong here now throws. */
      const current = spokenRef.current!
      const sentence = current.plan.sentences[at]!
      cursorRef.current = at
      baseRef.current = sentence.start
      turnedAt.current = null
      setPaused(false)
      /* ⚠️ **THE PREVIOUS SENTENCE'S BAND GOES BEFORE THIS ONE SPEAKS, AND IT USED
       * TO STAY.** The follow-along is only moved by a boundary event, and an
       * utterance can end without reporting one — `BOUNDARY_GRACE_MS` measures
       * 2.5 s of speech and a sentence is often shorter, so nothing concludes the
       * engine is silent and nothing clears the highlight. The band then sat on
       * the last word of the sentence BEFORE while a different one was read: a
       * highlight pointing confidently at the wrong place, which is worse than
       * none. Removed here rather than in the boundary handler, because the case
       * is a sentence that produces no boundary at all. */
      current.section.clearWord()
      const began = speaker!.speak(
        current.section.text.slice(sentence.start, sentence.end),
        current.lang,
        prefsRef.current,
      )
      /* ⚠️ **THE LOOK-AHEAD CALL THAT USED TO BE HERE IS GONE, AND THE OWNER
       * REFUSED ITS RETURN.** It asked `EngineSpeaker.prepare` to render the next
       * sentence while this one was read. Phase 34 renders a whole section at once
       * and keeps it on disk, and on 2026-09-30 — offered a smaller unit with a
       * look-ahead, against WI-34.0's measurements — the owner chose the whole
       * section and NO look-ahead. Nothing here renders anything the reader has
       * not asked for.
       *
       * This path is the PLATFORM speaker's now, and Web Speech never had
       * anything to prepare. */
      return began
    },
    // Stryker disable next-line ArrayDeclaration: `speaker` is memoised on values that never move, so this list and an empty one rebuild this callback equally often — never.
    [speaker],
  )

  /**
   * Move to sentence `at` after the silence that belongs before it.
   *
   * Answers whether there WAS a sentence there — false is how `onDone` tells a
   * sentence ending from a section ending without either of them counting.
   *
   * A PARAGRAPH BOUNDARY USES THE PARAGRAPH GAP ALONE, not both added: the
   * setting is labelled "between paragraphs", so a reader who sets it to zero
   * means no pause there, and adding the sentence gap underneath would make zero
   * impossible to ask for.
   *
   * A gap of zero speaks straight away rather than through a zero timer, because
   * `setTimeout(0)` still yields and a reader who turned the pause off asked for
   * the reading not to hesitate.
   */
  const advance = useCallback(
    (at: number): boolean => {
      const current = spokenRef.current
      if (!current || !current.plan.sentences[at]) return false

      /* ⚠️ **NO `at > 0` IN FRONT OF THIS.** It read that way, and `advance` has
         exactly one caller — the engine's own `onDone`, with
         `cursorRef.current + 1` — so `at` is never 0 and the guard could not
         change the answer for any reading. What it did do was hide the
         comparison beside it from measurement: an equivalent operand on the same
         line as a live one cannot be excused with a directive without excusing
         both. The first sentence of a section is spoken by `speakDocument`,
         which does not come through here. */
      const opensParagraph =
        blockIndexAt(current.plan, at) !== blockIndexAt(current.plan, at - 1)
      const prefs = prefsRef.current
      const ms = opensParagraph ? (prefs.paragraphGapMs ?? 0) : (prefs.sentenceGapMs ?? 0)
      if (ms <= 0) {
        speakSentence(at)
        return true
      }

      pendingNext.current = at
      gapTimer.current = setTimeout(() => {
        gapTimer.current = null
        pendingNext.current = null
        /* ⚠️ **NO `readingRef` CHECK HERE, AND IT USED TO READ ONE.** A reading
         * stopped during the pause must stay stopped — and what makes that true
         * is that every path which clears the flag clears this timer in the same
         * breath (`endReading` calls `clearGap`, and so do `moveTo`, the chapter
         * step and the document effect). So the check could not answer no, and a
         * mutation of it failed no test. The clear is the thing that must hold,
         * and 'says nothing more when the reader stops during a gap' is what
         * holds it. */
        speakSentence(at)
      }, ms)
      return true
    },
    // Stryker disable next-line ArrayDeclaration: `speakSentence` follows only `speaker`, which never moves — as above.
    [speakSentence],
  )

  /**
   * Speak one document, and say whether anything was queued.
   *
   * A section with no readable text — a plate, a full-page image — reports
   * `onDone('empty')` SYNCHRONOUSLY from inside `speak`, before this returns.
   * Mid-reading that is the continuation walking on past it, which is right;
   * on the reader's own Listen it is the reading never having begun, which is
   * why `start` marks the reading as under way only once this has answered.
   */
  const speakDocument = useCallback(
    (section: SpokenSection, from = 0): boolean => {
      /* NO `if (!speaker) return false`, AND THERE WAS ONE: both callers already
       * hold a speaker — `start` refuses without one, and the document effect runs
       * only inside a reading, which cannot begin without one. */
      const { lang } = section
      const plan: ReadingPlan = { sentences: section.sentences, blocks: section.blocks }
      const clip: ClipKey = {
        bookId: section.bookId,
        /* ⚠️ **NO `?? -1` HERE, AND THAT SENTINEL IS WHAT BROKE READING ALOUD ON
         * A REAL MACHINE.** The plugin's `section` is a `u32`; a negative is
         * refused at the IPC boundary, so every Listen died with *"This chapter
         * could not be made into audio"* and nothing in 3 007 tests could see it
         * because every one supplied a section. Null is the honest value and the
         * key carries it — see `ClipKey.section`. */
        section: section.sectionIndex,
        textDigest: section.digest,
      }
      /* WHICH SPEAKER IS ABOUT TO READ, asked with the same pure function
         `routedSpeaker` uses to choose — so the unit and the routing cannot
         disagree. Read through the refs rather than the props, because this runs
         from the document effect and from engine callbacks alike. */
      const unit =
        speakerFor(engineRef.current?.packs() ?? [], lang, prefsRef.current) === 'engine'
          ? 'section'
          : 'sentence'
      spokenRef.current = { section, plan, lang, clip, unit }
      turnedAt.current = null
      /* ⚠️ **THE SECTION UNIT ONLY.** The platform speaker is handed one sentence
       * and cannot seek inside it at all, so a tap there would report `false` and
       * leave the reader with a gesture that silently does nothing.
       *
       * ⚠️ **AND BEFORE `speak`, WHICH CAN END THE READING BEFORE IT RETURNS**: see
       * the note on `setPreparing` below. Subscribed afterwards, it would outlive
       * the reading it belongs to. */
      retireTap()
      if (unit === 'section') tapOff.current = section.onTap((offset) => seekRef.current(offset))

      /* ⚠️ **THE WHOLE SECTION, ONCE — WHICH IS THE PHASE.** One render, kept on
       * disk, one `words` array: the sentence plan above is still built, because
       * `stepSentence` and `stepParagraph` need to know where sentences ARE, but
       * it is a MAP now rather than a queue. Those two steps became seeks.
       *
       * The empty-section case below is the same call, which is why it needs no
       * branch of its own here. */
      /* ⚠️ **A NEW SECTION CLEARS `paused`, AND IT DID NOT — FOUND BY AN
       * INDEPENDENT AUDIT, 2026-09-30.** Both speakers' `speak` begins by
       * STOPPING, which clears the engine's own pause flag — so a chapter step
       * taken while the reading was paused started the new section's audio while
       * the transport still said *"Go on reading"*, and the only control that
       * could get back in step was Stop. `speakSentence` clears it on the
       * platform's unit and nothing cleared it on this one. */
      setPaused(false)
      /* ⚠️ **SET FROM THE UNIT, FOR EVERY SECTION — AND THE PLATFORM ROAD USED TO
       * SET NOTHING, SO IT LEAKED — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.**
       * An engine section leaves this true while it renders, and the effect below
       * clears it when a position arrives. Step from one of those to a section
       * routed to Web Speech — a different language, or a pack that reads one and
       * not the other — and no position ever arrives, because the platform speaker
       * has none to give. The transport then showed *"Making this chapter's
       * audio…"* with Stop as its only control, over a reading that was speaking
       * perfectly well.
       *
       * ⚠️ **AND IT IS SET BEFORE `speak`, NOT AFTER.** `speak` can refuse
       * synchronously — an empty section, no voice — and report `onDone` before it
       * returns, which clears this. Set afterwards it would survive that and leave
       * the transport claiming a render for a reading that never began. */
      setPreparing(unit === 'section')
      if (unit === 'section') {
        cursorRef.current = 0
        /* The whole text IS the utterance, so a boundary's index is already an
           offset into it. */
        baseRef.current = 0
        return speaker!.speak(section.text, lang, prefsRef.current)
      }

      /* ⚠️ **A SECTION WITH NO SENTENCES GOES TO THE ENGINE ANYWAY, AND SKIPPING
       * THAT STALLED THE READING ON EVERY PLATE.** `speakSentence` answers false
       * without queueing anything, so a plate or a full-page image queued no
       * utterance, `onDone('empty')` never fired, and the continuation that walks
       * past such a section was never started — the voice simply stopped, with
       * the Listen control still on. Caught by `reads through a section with
       * nothing to read`, which is the case that existed for it.
       *
       * Handing the collected text to `speak` is what the reading did before it
       * was sentence-at-a-time, so the empty section keeps its one tested path
       * instead of gaining a second. */
      if (plan.sentences.length === 0) {
        cursorRef.current = 0
        /* The whole text IS the utterance here, so a boundary's index is already
           an offset into it. */
        baseRef.current = 0
        return speaker!.speak(section.text, lang, prefsRef.current)
      }
      return speakSentence(from)
    },
    // Stryker disable next-line ArrayDeclaration: all three follow `speaker`, or nothing, and none moves — as above.
    [speaker, speakSentence, retireTap],
  )

  /* COMMITTED, like the refs above, and for the same reason: the `Speaker` is
   * memoised so a live utterance is never orphaned, so its `onDone` reaches this
   * through a ref rather than closing over a value that changes. */
  useLayoutEffect(() => {
    advanceRef.current = advance
    endRef.current = endReading
    seekRef.current = seekToOffset
  })

  /**
   * Whether a reading is under way, and with it who decides the book's pace.
   *
   * ⚠️ **SYNCHRONOUS, AND HELD THROUGH EVERY PAUSE AND GAP, WHICH IS WHY IT IS ONE
   * FUNCTION WITH THE FLAG.** The book must not turn itself while a reading is
   * between sentences, or paused and about to go on. A hold tied to `speaking`'s
   * next render would leave a window, and one tied to the sound would open at
   * every gap. This flag is true for exactly the reading.
   */
  const setReading = useCallback(
    (reading: boolean) => {
      readingRef.current = reading
      if (reading) {
        paceHold.current ??= surfaceRef.current.holdPace()
        return
      }
      paceHold.current?.()
      paceHold.current = null
    },
    /* Stryker disable next-line ArrayDeclaration: it reads only refs, so no dependency could change what it does. */
    [],
  )

  const start = useCallback(
    () => {
      /* THE READER'S SKIP CHOICE, from the same prefs the voice and the gaps come
         from — so the words the reading speaks and the words the export writes are
         decided by one value rather than two defaults. */
      const section = speaker && surfaceRef.current.speakable(skipOf(prefsRef.current))
      if (!section) return
      clearContinuation()
      setFollowsWords(true)
      /* THE READER'S OWN LISTEN CLEARS THE LAST REFUSAL. Left standing, a sentence
         about a chapter that could not be made would sit over the one that can. */
      setRefusal(null)
      /* Only claim to be reading if something was actually queued — see
       * `speakDocument`: the empty case has already reported done by the time
       * `speak` returns, and a flag set afterwards would overwrite it, leaving
       * the Listen control switched on with silence behind it. */
      const queued = speakDocument(section)
      setReading(queued)
      setSpeaking(queued)
    },
    /* Stryker disable next-line ArrayDeclaration: each of these is built once for the component's life, so with none listed it would still hold the same four. */
    [speaker, speakDocument, clearContinuation, setReading],
  )

  /**
   * The reading is over, however it ended.
   *
   * ⚠️ **FOUR PATHS USED TO DECIDE THIS INDEPENDENTLY AND THEY HAD DIVERGED.**
   * `finish` cleared the gap, the continuation, `speaking` and the band but NOT
   * `paused`, and never touched the engine; `stop` did all six; closing the book
   * left `paused` set and the band in place; unmount left both flags. So an
   * engine error, another speaker taking the engine, or the reader closing the
   * book WHILE PAUSED left `{ speaking: false, paused: true }` — which the public
   * type defines as "paused mid-sentence" and there was no sentence.
   *
   * ⚠️ **AND THE ENGINE IS STOPPED ON EVERY PATH, INCLUDING THE ONE WHERE THE
   * UTTERANCE HAS ALREADY ENDED.** `Speaker.stop` is what normalises the shared
   * engine's pause flag, which `cancel()` does not clear — so a terminal
   * transition that skipped it left the engine paused for whoever spoke next.
   * Where this speaker no longer holds the engine, `stop` returns without
   * touching it, which is the `taken` case and is right.
   */
  const endReading = useCallback(
    () => {
      setReading(false)
      retireTap()
      heldContinuation.current = false
      clearGap()
      clearContinuation()
      speaker?.stop()
      setSpeaking(false)
      setPaused(false)
      setPreparing(false)
      /* ⚠️ **THE POSITION GOES WITH THE READING.** Left behind, the transport
       * would show where the last reading got to as though this one were there —
       * and on the next Listen it would show that stale number for the whole of a
       * render, which WI-34.0 measured at 315 s. */
      setAt(null)
      clearBand()
    },
    // Stryker disable next-line ArrayDeclaration: `speaker` and the rest are all built once — as above.
    [speaker, clearGap, clearContinuation, clearBand, retireTap, setReading],
  )

  const stop = endReading

  /**
   * ⚠️ **PAUSING DURING A GAP HOLDS THE GAP, AND FORGETTING TO WOULD START THE
   * NEXT SENTENCE OVER A READER WHO HAD JUST ASKED FOR SILENCE.** The engine has
   * nothing to pause between two utterances, so the only thing holding the
   * reading there is our own timer: it is cancelled, and what it was going to say
   * is kept in `pendingNext` for `resume`.
   */
  const pause = useCallback(
    () => {
      if (!readingRef.current) return
      if (gapTimer.current !== null) {
        /* ⚠️ **THE ENGINE IS NOT TOUCHED DURING A GAP, AND TOUCHING IT WAS A BUG.**
         * Between two utterances nothing is being spoken, and
         * `speechSynthesis.pause()` sets a flag on the ENGINE rather than on an
         * utterance — so pausing here and then queueing the held sentence on
         * `resume` would queue it behind a paused engine and it would never start.
         * The only thing holding the reading in a gap is our own timer, so
         * cancelling it is the whole of the pause. */
        clearTimeout(gapTimer.current)
        gapTimer.current = null
        setPaused(true)
        return
      }
      /**
       * ⚠️ **A PAUSE BETWEEN SECTIONS USED TO CLAIM SUCCESS AND STOP NOTHING.**
       * `continueReading` walks pages looking for the next section, and while it
       * walks there is no live utterance — so `speaker.pause()` had nothing to
       * pause and returned quietly, `setPaused(true)` said it had worked, and the
       * timer went on turning pages under a reader who had asked for silence.
       * Worse, the next document then began speaking and cleared `paused` itself,
       * so the pause vanished without the reader touching anything.
       *
       * The walk is OURS, like the sentence gap, so pausing it means taking the
       * timer down and remembering that it was up.
       */
      if (continuing.current !== null) {
        clearContinuation()
        heldContinuation.current = true
        setPaused(true)
        return
      }
      /* `!` and not `?.`: `pause` has already returned unless a reading is under
         way, and a reading cannot be under way without an engine — `start`
         refuses to set the flag without one. An optional call here is a branch
         no test can take. */
      speaker!.pause()
      setPaused(true)
    },
    // Stryker disable next-line ArrayDeclaration: as above, for `speaker` and a clear that has no dependency.
    [speaker, clearContinuation],
  )

  /** Picks the held sentence up where the gap left it — see `pause`. */
  const resume = useCallback(
    () => {
      if (!readingRef.current) return
      const held = pendingNext.current
      setPaused(false)
      /* The section walk, if that is what was paused — a fresh grace, because the
         reader's pause is not evidence that the book has ended. */
      if (heldContinuation.current) {
        heldContinuation.current = false
        continueRef.current()
        return
      }
      /* HELD IN A GAP: the engine was never paused (see `pause`), so there is
         nothing to release — the sentence just begins. */
      if (held !== null) {
        /* SPOKEN NOW RATHER THAN AFTER THE REST OF THE GAP: the reader asked to go
           on, and making them wait out a silence they interrupted is answering a
           different question. */
        pendingNext.current = null
        speakSentence(held)
        return
      }
      /* `!` as in `pause`, and for the same reason. */
      speaker!.resume()
    },
    // Stryker disable next-line ArrayDeclaration: as above, for `speaker` and `speakSentence`.
    [speaker, speakSentence],
  )

  /**
   * Move the cursor and speak from there.
   *
   * ⚠️ **FORWARD OFF THE END OF A SECTION DOES NOTHING, DELIBERATELY.** The
   * sentence being spoken is still playing, and when it ends `onDone` finds no
   * next sentence and hands over to `continueReading`, which is the machinery
   * that crosses a section boundary correctly — walking pages until the next
   * document arrives, with the grace that tells the end of a book from a slow
   * turn. Duplicating that here would give two answers to one question, and
   * calling `paging.next()` instead would turn the page out from under prose
   * still being read.
   *
   * ⚠️ **BACKWARD OFF THE START RE-SPEAKS THE FIRST SENTENCE** rather than doing
   * nothing, on the same reasoning as `stepParagraph`'s back button: a reader
   * pressing back at the start of a chapter means "say that again".
   */
  const moveTo = useCallback(
    (next: number | null) => {
      if (!readingRef.current) return
      if (next === null) return
      clearGap()
      /* NO `clearContinuation()` HERE, for `stepBy`'s reason: a section walk sets
         `spokenRef` to null as it begins, and `stepBy` — the only caller — has
         returned at its first guard whenever it is null. */
      /* NO `setSpeaking(true)` HERE, AND THERE WAS ONE. `moveTo` has already
         returned unless a reading is under way, and the only writers of that
         flag — `start` and `endReading` — set `speaking` in the same breath, so
         it was already true: the call could not change anything, and neither
         its removal nor its argument could be told apart by any test. */
      speakSentence(next)
    },
    // Stryker disable next-line ArrayDeclaration: `speakSentence` and `clearGap` never move — as above.
    [speakSentence, clearGap],
  )

  /**
   * A step through the plan, by whichever unit `cursor` counts in.
   *
   * ⚠️ **ONE BODY, AND IT WAS TWO THAT DIFFERED BY A NAME.** `stepSentence` and
   * `stepParagraph` were copies whose only difference was which cursor function
   * they called — and the part they shared is the part with the decision in it:
   * falling off the START of the section replays the current sentence rather
   * than doing nothing, while falling off the END hands over to the continuation.
   * Two copies of that rule are two chances for one of them to be edited alone.
   */
  const stepBy = useCallback(
    (cursor: (plan: ReadingPlan, at: number, by: -1 | 1) => number | null, by: -1 | 1) => {
      const current = spokenRef.current
      if (!current) return
      const next = cursor(current.plan, cursorRef.current, by)
      /* ⚠️ **ON ONE BUFFER THIS IS A SEEK, AND THAT IS WHY THE PHASE EXISTS.**
       * The step used to cancel the utterance and speak a different sentence,
       * which on an engine voice meant a whole render per press — seconds of
       * silence for a button the reader taps repeatedly. One buffer makes it a
       * search in the `words` array and a new source node: instant.
       *
       * ⚠️ **AND THE CURSOR IS MOVED HERE, BECAUSE NOTHING ELSE WILL.** On the
       * sentence unit `speakSentence` writes it; on this one there is no
       * re-`speak`, so a step that did not write it would step from the same
       * place every time. */
      if (current.unit === 'section') {
        /* ⚠️ **-1 FOR "NOTHING THERE", WHICH NO PLAN HOLDS.** Past the last
         * sentence there is nothing to step to, and an index the plan does not
         * hold answers `undefined` — two ways of one ANSWER, *"there is no
         * sentence there"*, so one lookup asks it. This read
         * `to === null ? null : { index, sentence }`, and that ternary could not
         * change the result: `sentences[null]` is `undefined` too, so its `false`
         * mutant survived. */
        const to = next ?? (by === -1 ? cursorRef.current : -1)
        const sentence = current.plan.sentences[to]
        /* ⚠️ **ASKED FIRST, MOVED AFTER — AN INDEPENDENT AUDIT FOUND IT THE OTHER
         * WAY ROUND, 2026-09-30, AND IT IS `stepChapter`'s OWN LESSON ONE FLOOR
         * DOWN.** A seek ANSWERS FALSE where there are no word timings at all,
         * which on a Chinese pack is every reading: Qwen reports none. The cursor
         * moved anyway, so a press on a Chinese chapter silently advanced a
         * position nothing could act on.
         *
         * THE SENTENCE'S OWN START, through the word search rather than a
         * millisecond this layer computed: the words are what the sound is
         * indexed by, and a second arithmetic here would be a second answer.
         *
         * ⚠️ **AND THE TWO CHECKS ARE ONE CONDITION, WHICH IS A MUTATION-GATE
         * DECISION RATHER THAN A STYLE ONE.** Written as separate statements,
         * two mutants could not be killed: the ORDER of the seek and the cursor
         * write (with word timings present a seek never fails, so either order
         * behaves identically), and the *"there is no sentence at that index"*
         * half of the first guard (every index this receives comes from
         * `stepSentence`, `stepParagraph` or `sentenceIndexAt`, all of which
         * answer in range — only a null `to` is reachable). Both were
         * hand-applied on 2026-09-30 and both survived. Merged, neither mutant
         * exists to survive: there is no ordering to reverse, and removing either
         * operand fails a case.
         *
         * ⚠️ **AND THE `clearGap()` / `clearContinuation()` THAT STOOD HERE ARE
         * GONE, BECAUSE NEITHER COULD EVER DO ANYTHING.** The audit's finding had
         * a second half — that a failed step also tears down the pending work —
         * and following it produced two calls no test could tell from their
         * absence. They are unreachable on this unit, and the argument is short
         * enough to check: a GAP belongs to the platform's sentence unit, where
         * `advance` sets it and this branch is not taken; and a section
         * CONTINUATION is started by `continueReading`, which sets
         * `spokenRef.current` to null in its first line — so whenever
         * `continuing.current` is set, this function has already returned at its
         * own first guard. Hand-applied 2026-09-30, with the calls and without
         * them: the suite is green either way. A line that cannot be observed is
         * a line this repository removes rather than keeps for comfort. */
        if (!sentence || speaker!.seekToOffset(sentence.start) !== true) return
        chasingRef.current = true
        cursorRef.current = to
        return
      }
      moveTo(next ?? (by === -1 ? cursorRef.current : null))
    },
    // Stryker disable next-line ArrayDeclaration: every one of these follows only values that never move — as above.
    [moveTo, speaker],
  )
  // Stryker disable next-line ArrayDeclaration: `stepBy` follows only `moveTo`, which never moves — as above.
  const stepSentence = useCallback((by: -1 | 1) => stepBy(sentenceStep, by), [stepBy])
  // Stryker disable next-line ArrayDeclaration: as above, for the same `stepBy`.
  const stepParagraph = useCallback((by: -1 | 1) => stepBy(paragraphStep, by), [stepBy])

  /**
   * Go to a fraction of the way through the section.
   *
   * ⚠️ **THE CURSOR IS RE-DERIVED FROM WHERE THE SOUND LANDED, NOT FROM THE
   * FRACTION.** `stepSentence` after a scrub must step from where the reader now
   * is, and the only thing that knows that is the player — the fraction is a
   * request, and clamping happens inside it.
   */
  /* ⚠️ **`speaker!` IN THE FOUR SEEKS AND THE POSITION TICK, AND IT USED TO BE
     `speaker?.x?.(…)` — FOUND BY THE MUTATION SWEEP, ten unkillable mutants.**
     Two chains, neither of which could come back undefined where it stood:

     - **The speaker.** It is `null` only where `speechAvailable()` is false, and
       there `speakDocument` never queues anything — so `readingRef.current`, which
       every one of these tests FIRST, cannot be true without one. The position
       tick is guarded by `speaking`, which is the same fact.
     - **The member.** `routedSpeaker` defines all five and answers `false` or
       `null` where the speaker currently reading cannot seek. That is now in its
       type — `SeekingSpeaker` — so the second chain is gone rather than asserted.

     An assertion rather than a branch because the alternative is a branch no test
     can reach, which is the shape this repository removes. */
  const seekToFraction = useCallback(
    (fraction: number): boolean => {
      if (!readingRef.current) return false
      /* ⚠️ **A SCRUB THE SPEAKER REFUSES CHANGES NOTHING** — the platform voice,
       * or a render still in flight. It used to tear down the sentence gap and
       * the section continuation first, which left the reading lit over silence
       * with no timer to advance or end it. Found by an independent audit,
       * 2026-09-30; see below for why a scrub that lands has nothing to tear down
       * either.
       *
       * ⚠️ **THE CURSOR IS SET FROM WHERE THE SPEAKER LANDED, AND IT USED TO WAIT
       * FOR THE NEXT WORD BOUNDARY — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.**
       * A fraction says nothing about which SENTENCE it lands in, so the comment
       * that stood here argued the cursor should come from `onWord` a few hundred
       * milliseconds later, and that computing it from the duration would be a
       * second answer to a question the words already answer. The second half of
       * that is right and the conclusion was not: the SPEAKER already knows which
       * word it landed on, so asking it is that same answer rather than a new one.
       * Inside the window, a reader who scrubbed from sentence 2 to sentence 20 and
       * pressed Next Sentence stepped to sentence 3.
       *
       * A Chinese reading has no word timings to answer with: see below. */
      if (speaker!.seekToFraction(fraction) !== true) return false
      chasingRef.current = true
      /* THROUGH `sentenceIndexAt`, WHICH IS WHAT `onWord` USES, so a seek and a
       * word boundary cannot disagree about which sentence an offset is in.
       *
       * ⚠️ **`?? 0` RATHER THAN LEAVING THE CURSOR ALONE, AND NO CASE CAN TELL
       * THE TWO APART.** After a seek that landed, the offset is null only where
       * the reading has no word timings at all — a Chinese pack — and there
       * nothing reads the cursor: every step is a seek by offset, which refuses
       * without timings, and no boundary arrives to move it. The guard that
       * stood here, and one on `spokenRef` (which a seek that landed has already
       * answered), survived every mutation for exactly that reason.
       *
       * ⚠️ **NOTHING IS TORN DOWN, AND `clearGap()` / `clearContinuation()` STOOD
       * HERE.** A seek lands only while the engine is reading a section; a gap
       * belongs to the platform's sentence unit, and a walk begins only after the
       * engine's reading has ended — so either clear could only find nothing. */
      cursorRef.current = sentenceIndexAt(spokenRef.current!.plan, speaker!.spokenOffset() ?? 0)
      return true
    },
    // Stryker disable next-line ArrayDeclaration: `speaker` never moves — as above.
    [speaker],
  )

  /**
   * Go to the word covering a character offset in the section's collected text.
   *
   * This is the direction that was not expressible before phase 34: the
   * spoken-word band already lives in the book's own document, so a reader
   * tapping a word has always had an offset to give — what was missing was
   * anywhere to put it, because an utterance was one sentence and a position
   * inside another one meant nothing.
   */
  const seekToOffset = useCallback(
    (offset: number): boolean => {
      if (!readingRef.current) return false
      /* A REFUSAL CHANGES NOTHING, and a landing has nothing to tear down — both
         as in `seekToFraction`. No `spokenRef` guard either: a seek lands only
         while the engine reads a section, and `spokenRef` then holds it. */
      if (speaker!.seekToOffset(offset) !== true) return false
      chasingRef.current = true
      /* THE OFFSET IS KNOWN HERE, unlike a fraction, so the cursor can be set at
         once rather than at the next word — which matters for a reader who taps a
         word and then presses the sentence step. */
      cursorRef.current = sentenceIndexAt(spokenRef.current!.plan, offset)
      return true
    },
    // Stryker disable next-line ArrayDeclaration: as above.
    [speaker],
  )

  /**
   * A whole chapter away.
   *
   * The reading is not restarted here and the cursor is not moved: navigating
   * changes the spine document, and the document effect below is what speaks the
   * new one — the same path a reader taking a chapter from the contents already
   * goes down while listening. Nothing to do but ask.
   */
  const stepChapter = useCallback(
    (by: -1 | 1) => {
      if (!readingRef.current) return
      /* ASKED FIRST, TORN DOWN AFTER — and it used to be the other way round.
         A `chapter` that declines is a legitimate answer at either end of a
         book, and clearing ahead of it threw away the pending gap or the
         section continuation for a navigation that never happened: the voice
         went silent with `speaking` still true and no timer left to wake it.
         Nothing is cleared unless the document is actually changing, in which
         case the document effect below takes over the reading. */
      if (!surfaceRef.current.chapter.go(by)) return
      clearGap()
      clearContinuation()
    },
    // Stryker disable next-line ArrayDeclaration: neither clear has a dependency, so this list is constant either way.
    [clearGap, clearContinuation],
  )

  /**
   * Sample the position while a reading speaks, and stop when it does not.
   *
   * ⚠️ **THE INTERVAL IS TORN DOWN ON `paused` AS WELL AS ON `speaking`**, and it
   * has to be: `positionMs()` is constant while paused, so a tick would re-render
   * four times a second for an unchanging value — which is the cost this file's
   * `chapters` memo already exists to avoid, four times a second.
   */
  useEffect(() => {
    if (!speaking) return
    const tick = setInterval(() => {
      /* ⚠️ **BAILS OUT ON AN UNCHANGED VALUE RATHER THAN BEING SWITCHED OFF WHILE
       * PAUSED.** `positionMs()` is constant while paused, so a tick that always
       * set state would re-render four times a second for a value nobody can see
       * change — which is the cost the `chapters` memo in this file already exists
       * to avoid. Returning the previous value makes React bail out, and it keeps
       * the tick running through a pause, which is what lets a render that LANDS
       * during one be noticed. */
      setAt((was) => {
        const now = speaker!.at()
        /* `now`, and it read `was === now ? was : now`: with either side null
           the two are equal only when both are, and then they are one null. */
        if (was === null || now === null) return now
        return was.positionMs === now.positionMs && was.durationMs === now.durationMs ? was : now
      })
    }, POSITION_TICK_MS)
    return () => clearInterval(tick)
  }, [speaking, speaker])

  /* ⚠️ **THE RENDER IS OVER WHEN THERE IS A POSITION, AND NOT BEFORE.** A
   * separate writer for `preparing` would be a second answer to one question;
   * this is the same fact read once. */
  useEffect(() => {
    /* ⚠️ **NO `at !== null` TEST, AND THERE WAS ONE — FOUND BY THE MUTATION
       SWEEP.** It read as a guard against ending the wait before a position had
       arrived, and it could never do that: `at` is set back to null only when a
       reading ENDS, where `preparing` is already false, and a section that starts
       preparing does not change `at` at all — so this effect simply does not run
       until a position lands. The clause was a second statement of when the effect
       fires, and its `true` mutant behaved identically. `setPreparing(false)` is
       idempotent; the dependency is the whole of the logic. */
    setPreparing(false)
  }, [at])

  /* The spine document changing is a step INSIDE the reading, not its end.
   *
   * Two ways it happens while the voice is going: the reading's own `next`
   * walked into the next section, or the reader went somewhere — a chapter in
   * the contents, a link. Either way the words being read are no longer on
   * screen, and the answer to both is the same: read the document that is. A
   * null document is the book closing, which is an end.
   *
   * The surface takes the highlight out of the document that is LEAVING, because
   * its section can no longer do it, and nothing here touches the engine: the next
   * document's `speak` cancels the old utterance itself, and stopping here is what
   * used to make every chapter break a silence.
   *
   * ⚠️ **PASSIVE, WHICH IS WHAT LETS IT ASK THE SURFACE**: see the layout effect at
   * the top of this hook. */
  useEffect(() => {
    if (!readingRef.current) return
    clearGap()
    clearContinuation()
    /* ⚠️ **AND THE HELD WALK GOES WITH THE SECTION IT BELONGED TO — FOUND BY AN
     * INDEPENDENT AUDIT, 2026-09-30.** `pause` sets this when it takes down a
     * section walk, and `resume` reads it as *"restart the walk"*. Left standing
     * across a document change, a reader who paused during the OLD section's walk
     * and then resumed the NEW section's utterance restarted a page walk instead
     * of releasing the speaker: pages turned under a paused voice. The flag is
     * about a walk that no longer exists. */
    heldContinuation.current = false
    const section = surfaceRef.current.speakable(skipOf(prefsRef.current))
    if (!section) {
      /* The book closing is an END, and it used to leave `paused` set and the
         band drawn in a document that was going away. */
      endReading()
      return
    }
    /* NO `if (queued) setSpeaking(true)`, AND THERE WAS ONE — `moveTo`'s reason:
       this effect has returned unless a reading is under way, and `speaking` is
       written only beside `readingRef`, so it is already true. */
    speakDocument(section)
  }, [speaker, sectionKey, speakDocument, endReading, clearGap, clearContinuation])

  /* `clearBand` DOES NOTHING HERE FOR A DOCUMENT THAT WAS REPLACED, WHICH IS FINE:
   * the surface already took it out. It is what takes it out on an unmount, where
   * the document is still on screen and nothing else will. */
  useEffect(
    () => () => {
      clearBand()
      spokenRef.current = null
    },
    [sectionKey, clearBand],
  )

  /* Speech is a property of the window, not of the component: an utterance
   * outlives an unmount and would go on reading a book that has been closed. */
  useEffect(
    () => () => {
      endReading()
    },
    // Stryker disable next-line ArrayDeclaration: `endReading` follows only values that never move — as above.
    [endReading],
  )

  /* A SUBSCRIPTION, not a read through `surfaceRef`: this decides what is RENDERED,
   * so it has to be a value the render sees change. The ref exists for callbacks
   * that need the value as of now, which is the opposite problem. And it cannot be
   * read once per render either, because the surface commits AFTER this child
   * renders: it would be one commit behind until something else re-rendered it.
   *
   * MEMOISED ON THE TWO BOOLEANS rather than built inline, because `Speech` is
   * itself a memo and an object literal here would be a fresh identity on every
   * render — which would make every consumer of `Speech` re-render on every one
   * of the reading's own state changes, several a second while the voice runs. */
  const canBack = useSyncExternalStore(surface.chapter.subscribe, () => surface.chapter.can(-1))
  const canForward = useSyncExternalStore(surface.chapter.subscribe, () => surface.chapter.can(1))
  const chapters = useMemo(() => ({ back: canBack, forward: canForward }), [canBack, canForward])

  return useMemo<Speech>(
    () => ({
      available,
      speaking,
      paused,
      chapters,
      followsWords,
      at,
      preparing,
      refusal,
      start,
      stop,
      pause,
      resume,
      seekToFraction,
      seekToOffset,
      stepSentence,
      stepParagraph,
      stepChapter,
    }),
    [
      available,
      speaking,
      paused,
      chapters,
      followsWords,
      at,
      preparing,
      refusal,
      start,
      stop,
      pause,
      resume,
      seekToFraction,
      seekToOffset,
      stepSentence,
      stepParagraph,
      stepChapter,
    ],
  )
}

/**
 * What to tell the reader about a reading that stopped on its own.
 *
 * ⚠️ **`taken` GETS NOTHING, AND THAT IS THE ONE DECISION HERE.** It means
 * another speaker took the shared engine — the reader asked for something else —
 * which is not a refusal and must not be reported as one. `ended` and `empty`
 * never reach this: they are the reading finishing, which the transport shows by
 * going back to the Listen control.
 */
export function refusalFor(reason: DoneReason): string | null {
  if (reason === 'no-voice') {
    return 'No downloaded voice can read this book. Settings → Voices has the packs.'
  }
  if (reason === 'error') {
    /* ⚠️ **NOT "SOMETHING WENT WRONG".** The two things that actually happen are
     * a render that did not finish and a device with nowhere to play; both are
     * covered by saying the audio could not be made, and both leave the engine's
     * own words in the console and in `Paper.log`. */
    return 'This chapter could not be made into audio. Trying again may work.'
  }
  return null
}

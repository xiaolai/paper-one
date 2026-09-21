import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Speaker,
  collectText,
  documentLang,
  placeOfRange,
  rangeAt,
  speechAvailable,
  type DoneReason,
  type SpeakPrefs,
  type SpokenText,
} from './speech'
import { placeSpokenWord, removeSpokenWord } from './rulerBand'
import {
  blockIndexAt,
  stepParagraph as paragraphStep,
  stepSentence as sentenceStep,
  type ReadingPlan,
} from './readingCursor'
import { resolveSegmenterLocale } from './wordSnap/classify'
import { sentenceSpansOf } from './wordSnap/sentenceOf'

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
   * Which directions `stepChapter` can actually go.
   *
   * ⚠️ **PUBLISHED SO THE TRANSPORT CAN LEAVE THE BUTTON OUT RATHER THAN DRAW A
   * DEAD ONE.** Without it the control would have to guess, and the honest answer
   * is known only here — see `SpeechPaging.chapter`, which a book that cannot
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
 * What the reading needs from the reader.
 *
 * `next` is one page forward in READING order — not `goRight`, because the voice
 * is always ahead of where it was, and in a right-to-left book ahead is to the
 * left. The session's own `next` is exactly this and is what the arrow key runs.
 */
export interface SpeechPaging {
  next: () => void
  /**
   * A whole chapter away, or absent where the book cannot say.
   *
   * ⚠️ **OPTIONAL, AND THE TRANSPORT HIDES THE BUTTON RATHER THAN DRAWING A DEAD
   * ONE.** It needs the TOC and the reader's place in it — `stepChapter` in
   * `tocOrder.ts` over `position.chapterHref` — and a book whose current spine
   * item no contents entry points at genuinely has no next chapter to offer. A
   * control that navigates nowhere is worse than one that is not there.
   *
   * ⚠️ **`go` ANSWERS WHETHER IT MOVED, AND IT USED TO ANSWER NOTHING.**
   * Returning `void`, it could not be distinguished from a no-op — so
   * `stepChapter` tore down the pending sentence gap and the section
   * continuation BEFORE asking, and a press at either end of the book destroyed
   * the only future work the reading had while leaving `speaking` true. The
   * voice stopped, the transport went on showing a reading in progress, and
   * nothing could restart it but the reader pressing stop.
   *
   * `can` is the same question WITHOUT taking the step, which is what a render
   * needs and what an action cannot give it: asking by navigating is not asking.
   * Both live under one field so they cannot drift into disagreeing about the
   * same book — a separate `chapters` flag beside a `chapter` function is two
   * statements of one fact, and this file has just finished removing a set of
   * those.
   */
  chapter?:
    | {
        readonly can: (by: -1 | 1) => boolean
        readonly go: (by: -1 | 1) => boolean
      }
    | undefined
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
  doc: Document | null,
  paging: SpeechPaging,
  prefs: SpeakPrefs = NO_PREFS,
): Speech {
  const [speaking, setSpeaking] = useState(false)
  const [paused, setPaused] = useState(false)
  const [followsWords, setFollowsWords] = useState(true)

  const docRef = useRef<Document | null>(doc)
  const pagingRef = useRef(paging)
  /* READ AT `speak` TIME, never captured — see `SpeakPrefs`. A reading walks
   * many sections and each one is its own utterance, so a voice or rate the
   * reader changes mid-chapter takes effect at the next section rather than
   * needing the reading stopped and started again. */
  const prefsRef = useRef(prefs)
  /* The collected text AND the document it was collected from, together.
   *
   * Kept as one value on purpose. Held apart, `docRef` is reassigned during
   * render the moment the spine item changes, while `spokenRef` still holds the
   * previous section's node index — and a boundary event arriving in that gap
   * resolves offsets from the OLD chapter against the NEW document, which is
   * how the highlight ends up on an unrelated word. Pairing them makes that
   * state unrepresentable: the handler uses the document the text came from,
   * and does nothing once that is no longer the document on screen. */
  const spokenRef = useRef<{
    doc: Document
    spoken: SpokenText
    /** The sentences and paragraphs of `spoken.text` — see `ReadingPlan`. */
    plan: ReadingPlan
    /** `documentLang`'s answer, kept so each sentence is spoken in it. */
    lang: string | null
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
   * Speaks sentence `at`, answering whether there was one to speak.
   *
   * Written in the layout effect below rather than here, for the reason the rest
   * of these are (#505): the `Speaker` is memoised so that the engine is not
   * rebuilt under a live utterance, so its `onDone` cannot close over a callback
   * that changes — it reaches the committed one through this.
   */
  const advanceRef = useRef<(at: number) => boolean>(() => false)
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
  const followsRef = useRef(true)
  /* THE READING: true from the reader's Listen until their stop, the end of
   * the book or an engine error. A ref, not state, because it is consulted
   * from engine callbacks and from the document effect, and both need the
   * value as of now rather than as of the last render. `speaking` is what the
   * controls show; this is what the hook is doing. */
  const readingRef = useRef(false)
  /** When `next` was last asked for a word — see `TURN_SETTLE_MS`. */
  const turnedAt = useRef<number | null>(null)
  /** The end-of-section tick, while it runs. */
  const continuing = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* COMMITTED, NOT ASSIGNED DURING RENDER (audit round 1, #505). These refs
   * used to be written in the render body, so a render React abandoned — or a
   * concurrent one it had not committed — left engine callbacks and the
   * continuation tick reading a document the tree never showed. A LAYOUT
   * effect runs after commit and before the passive document effect below, so
   * the continuation's own ordering claim — "docRef is reassigned before that
   * effect runs" — stays true, now of committed values only. */
  useLayoutEffect(() => {
    docRef.current = doc
    pagingRef.current = paging
    prefsRef.current = prefs
    followsRef.current = followsWords
  })

  const available = useMemo(() => speechAvailable(), [])

  /** Abandon a pause that has not finished, and what it was going to say. */
  const clearGap = useCallback(() => {
    if (gapTimer.current !== null) {
      clearTimeout(gapTimer.current)
      gapTimer.current = null
    }
    pendingNext.current = null
  }, [])

  const clearContinuation = useCallback(() => {
    if (continuing.current !== null) {
      clearTimeout(continuing.current)
      continuing.current = null
    }
  }, [])

  const speaker = useMemo(() => {
    if (!available) return null

    /** The reading is over — ONE transition, see `endReading`. */
    const finish = () => endRef.current()

    /**
     * The section's text ran out and the reading has not: walk forward until
     * the next section arrives — its document effect speaks it and cancels this
     * — or the grace runs out, which is the end of the book.
     */
    const continueReading = () => {
      removeSpokenWord(docRef.current)
      spokenRef.current = null
      turnedAt.current = null
      const from = docRef.current
      const started = Date.now()
      const tick = () => {
        continuing.current = null
        if (!readingRef.current) return
        /* Already moved: the new document's effect is about to speak it, or
         * has. Asking `next` again here would turn its first page away before
         * a word of it was read. `docRef` commits in the layout effect above,
         * which runs before that document effect, so this sees the arrival
         * first. */
        if (docRef.current !== from) return
        if (Date.now() - started >= CONTINUE_GRACE_MS) {
          finish()
          return
        }
        pagingRef.current.next()
        continuing.current = setTimeout(tick, CONTINUE_TICK_MS)
      }
      tick()
    }

    /* Published so `resume` can restart a walk `pause` suspended — the memo owns
     * `continueReading`, and everything outside it reaches in through a ref. */
    continueRef.current = continueReading

    return new Speaker({
      onWord: (index, length) => {
        const current = spokenRef.current
        if (!current || !followsRef.current) return
        // The section changed under the utterance; the words being reported no
        // longer exist on screen.
        if (current.doc !== docRef.current) return
        const target = current.doc
        /* REBASED ONTO THE SENTENCE — see `cursorRef`. `index` counts from the
         * start of the utterance, and the utterance is one sentence, so without
         * its own offset every sentence after the first would highlight words at
         * the top of the chapter. */
        const sentence = current.plan.sentences[cursorRef.current]
        if (!sentence) return
        const range = rangeAt(current.spoken, target, sentence.start + index, length)
        if (!range) return
        const placed = placeOfRange(range, target)
        if (!placed) return
        // Viewport coordinates, unadjusted: `placeSpokenWord` converts into
        // body's space, which is invariant under scrolling.
        placeSpokenWord(target, placed.box)

        if (placed.place === 'visible') {
          turnedAt.current = null
          return
        }
        if (placed.place !== 'ahead') return
        const now = Date.now()
        if (turnedAt.current !== null && now - turnedAt.current < TURN_SETTLE_MS) return
        turnedAt.current = now
        pagingRef.current.next()
      },
      onDone: (reason: DoneReason) => {
        /* ⚠️ **`taken` MUST NOT CONTINUE, AND IT USED TO ARRIVE AS `ended`.**
         * The lookup popup's pronunciation speaks through the same single
         * engine, and `speak` cancels whatever is on it — so the reading's
         * utterance ended, its `end` event fired, and this read it as "the
         * section finished" and called `continueReading()`: pages walking
         * forward hunting the next section while the reader listened to one
         * word being pronounced. `engineHeldBy` in `speech.ts` is what tells
         * the two apart now. Treated as an end rather than an error, because
         * nothing failed — the reader asked for something else. */
        /* ⚠️ **`no-voice` ENDS THE READING, AND WOULD NOT HAVE BY ITSELF.** Every
           reason below this falls through to "that sentence finished, go on" —
           so a refusal would have walked the book sentence by sentence, then
           page by page, refusing each one. Nothing here can be read until the
           voices change, and the Listen control says so. */
        if (reason === 'error' || reason === 'taken' || reason === 'no-voice' || !readingRef.current) {
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
        if (advanceRef.current(cursorRef.current + 1)) return
        continueReading()
      },
      onNoBoundaries: () => {
        // Reading continues; only the follow-along is dropped. Leaving the
        // band parked on the first word for the rest of the chapter would be
        // worse than not drawing one.
        setFollowsWords(false)
        removeSpokenWord(docRef.current)
      },
    })
  }, [available, clearGap, clearContinuation])

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
      const current = spokenRef.current
      if (!speaker || !current) return false
      const sentence = current.plan.sentences[at]
      if (!sentence) return false
      cursorRef.current = at
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
      removeSpokenWord(current.doc)
      return speaker.speak(
        current.spoken.text.slice(sentence.start, sentence.end),
        current.lang,
        prefsRef.current,
      )
    },
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

      const opensParagraph =
        at > 0 && blockIndexAt(current.plan, at) !== blockIndexAt(current.plan, at - 1)
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
        /* ASKED WHEN IT FIRES, not when it was set: a reading stopped during the
         * pause must stay stopped, and the ref is what answers as of now. */
        if (!readingRef.current) return
        speakSentence(at)
      }, ms)
      return true
    },
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
    (target: Document, from = 0): boolean => {
      if (!speaker) return false
      /* THE READER'S SKIP CHOICE, from the same prefs the voice and the gaps
         come from — so the words the reading speaks and the words the export
         writes are decided by one value rather than two defaults. */
      const spoken = collectText(target, { notes: prefs?.notesAloud ?? false })
      const lang = documentLang(target)
      /* THE LOCALE IS RESOLVED, NOT PASSED THROUGH. `sentenceSpansOf` constructs
       * an `Intl.Segmenter` with it, and a book may declare anything at all in
       * `dc:language` — `resolveSegmenterLocale` is the function that already
       * answers which tags are safe to build one from, and `undefined` is its
       * answer for a book that declares none, which the segmenter reads as "let
       * each sentence speak for itself by script". */
      const plan: ReadingPlan = {
        sentences: sentenceSpansOf(spoken.text, resolveSegmenterLocale(lang)),
        blocks: spoken.blocks,
      }
      spokenRef.current = { doc: target, spoken, plan, lang }
      turnedAt.current = null

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
        return speaker.speak(spoken.text, lang, prefsRef.current)
      }
      return speakSentence(from)
    },
    [speaker, speakSentence],
  )

  /* COMMITTED, like the refs above, and for the same reason: the `Speaker` is
   * memoised so a live utterance is never orphaned, so its `onDone` reaches this
   * through a ref rather than closing over a value that changes. */
  useLayoutEffect(() => {
    advanceRef.current = advance
    endRef.current = endReading
  })

  const start = useCallback(() => {
    const target = docRef.current
    if (!speaker || !target) return
    clearContinuation()
    setFollowsWords(true)
    /* Only claim to be reading if something was actually queued — see
     * `speakDocument`: the empty case has already reported done by the time
     * `speak` returns, and a flag set afterwards would overwrite it, leaving
     * the Listen control switched on with silence behind it. */
    const queued = speakDocument(target)
    readingRef.current = queued
    setSpeaking(queued)
  }, [speaker, speakDocument, clearContinuation])

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
  const endReading = useCallback(() => {
    readingRef.current = false
    heldContinuation.current = false
    clearGap()
    clearContinuation()
    speaker?.stop()
    setSpeaking(false)
    setPaused(false)
    removeSpokenWord(docRef.current)
  }, [speaker, clearGap, clearContinuation])

  const stop = endReading

  /**
   * ⚠️ **PAUSING DURING A GAP HOLDS THE GAP, AND FORGETTING TO WOULD START THE
   * NEXT SENTENCE OVER A READER WHO HAD JUST ASKED FOR SILENCE.** The engine has
   * nothing to pause between two utterances, so the only thing holding the
   * reading there is our own timer: it is cancelled, and what it was going to say
   * is kept in `pendingNext` for `resume`.
   */
  const pause = useCallback(() => {
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
    speaker?.pause()
    setPaused(true)
  }, [speaker, clearContinuation])

  /** Picks the held sentence up where the gap left it — see `pause`. */
  const resume = useCallback(() => {
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
    speaker?.resume()
  }, [speaker, speakSentence])

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
      clearContinuation()
      speakSentence(next)
      setSpeaking(true)
    },
    [speakSentence, clearGap, clearContinuation],
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
      moveTo(next ?? (by === -1 ? cursorRef.current : null))
    },
    [moveTo],
  )
  const stepSentence = useCallback((by: -1 | 1) => stepBy(sentenceStep, by), [stepBy])
  const stepParagraph = useCallback((by: -1 | 1) => stepBy(paragraphStep, by), [stepBy])

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
      if (pagingRef.current.chapter?.go(by) !== true) return
      clearGap()
      clearContinuation()
    },
    [clearGap, clearContinuation],
  )

  /* The spine document changing is a step INSIDE the reading, not its end.
   *
   * Two ways it happens while the voice is going: the reading's own `next`
   * walked into the next section, or the reader went somewhere — a chapter in
   * the contents, a link. Either way the words being read are no longer on
   * screen, and the answer to both is the same: read the document that is. A
   * null document is the book closing, which is an end.
   *
   * The cleanup takes the highlight out of the document that is LEAVING —
   * `doc` from the closure, not `docRef.current`, which by then already names
   * the incoming one — and does not touch the engine: the next document's
   * `speak` cancels the old utterance itself, and stopping here is what used
   * to make every chapter break a silence. */
  useEffect(() => {
    if (!readingRef.current) return
    clearGap()
    clearContinuation()
    if (!doc) {
      /* The book closing is an END, and it used to leave `paused` set and the
         band drawn in a document that was going away. */
      endReading()
      return
    }
    const queued = speakDocument(doc)
    if (queued) setSpeaking(true)
  }, [speaker, doc, speakDocument, endReading, clearGap, clearContinuation])

  useEffect(() => {
    const leaving = doc
    return () => {
      removeSpokenWord(leaving)
      spokenRef.current = null
    }
  }, [doc])

  /* Speech is a property of the window, not of the component: an utterance
   * outlives an unmount and would go on reading a book that has been closed. */
  useEffect(
    () => () => {
      endReading()
    },
    [endReading],
  )

  /* READ FROM THE PROP, not from `pagingRef`: this decides what is RENDERED, so
   * it has to be a value the render sees change. The ref exists for callbacks
   * that need the value as of now, which is the opposite problem.
   *
   * MEMOISED ON THE TWO BOOLEANS rather than built inline, because `Speech` is
   * itself a memo and an object literal here would be a fresh identity on every
   * render — which would make every consumer of `Speech` re-render on every one
   * of the reading's own state changes, several a second while the voice runs. */
  const canBack = paging.chapter?.can(-1) ?? false
  const canForward = paging.chapter?.can(1) ?? false
  const chapters = useMemo(() => ({ back: canBack, forward: canForward }), [canBack, canForward])

  return useMemo<Speech>(
    () => ({
      available,
      speaking,
      paused,
      chapters,
      followsWords,
      start,
      stop,
      pause,
      resume,
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
      start,
      stop,
      pause,
      resume,
      stepSentence,
      stepParagraph,
      stepChapter,
    ],
  )
}

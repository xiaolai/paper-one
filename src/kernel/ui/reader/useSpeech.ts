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
   * Whether `stepChapter` can actually go anywhere.
   *
   * ⚠️ **PUBLISHED SO THE TRANSPORT CAN LEAVE THE BUTTON OUT RATHER THAN DRAW A
   * DEAD ONE.** Without it the control would have to guess, and the honest answer
   * is known only here — see `SpeechPaging.chapter`, which a book that cannot
   * place the reader in its own contents does not supply.
   */
  readonly chapters: boolean
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
   */
  chapter?: ((by: -1 | 1) => void) | undefined
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
  const speakSentenceRef = useRef<(at: number) => boolean>(() => false)
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

  const clearContinuation = useCallback(() => {
    if (continuing.current !== null) {
      clearTimeout(continuing.current)
      continuing.current = null
    }
  }, [])

  const speaker = useMemo(() => {
    if (!available) return null

    /** The reading is over: the controls go quiet and nothing is pending. */
    const finish = () => {
      readingRef.current = false
      clearContinuation()
      setSpeaking(false)
      removeSpokenWord(docRef.current)
    }

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
        if (reason === 'error' || reason === 'taken' || !readingRef.current) {
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
        if (speakSentenceRef.current(cursorRef.current + 1)) return
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
  }, [available, clearContinuation])

  /**
   * Speak one document, and say whether anything was queued.
   *
   * A section with no readable text — a plate, a full-page image — reports
   * `onDone('empty')` SYNCHRONOUSLY from inside `speak`, before this returns.
   * Mid-reading that is the continuation walking on past it, which is right;
   * on the reader's own Listen it is the reading never having begun, which is
   * why `start` marks the reading as under way only once this has answered.
   */
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
      return speaker.speak(
        current.spoken.text.slice(sentence.start, sentence.end),
        current.lang,
        prefsRef.current,
      )
    },
    [speaker],
  )

  const speakDocument = useCallback(
    (target: Document, from = 0): boolean => {
      if (!speaker) return false
      const spoken = collectText(target)
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
    speakSentenceRef.current = speakSentence
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

  const stop = useCallback(() => {
    readingRef.current = false
    clearContinuation()
    speaker?.stop()
    setSpeaking(false)
    setPaused(false)
    removeSpokenWord(docRef.current)
  }, [speaker, clearContinuation])

  const pause = useCallback(() => {
    if (!readingRef.current) return
    speaker?.pause()
    setPaused(true)
  }, [speaker])

  const resume = useCallback(() => {
    if (!readingRef.current) return
    speaker?.resume()
    setPaused(false)
  }, [speaker])

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
      clearContinuation()
      speakSentence(next)
      setSpeaking(true)
    },
    [speakSentence, clearContinuation],
  )

  const stepSentence = useCallback(
    (by: -1 | 1) => {
      const current = spokenRef.current
      if (!current) return
      const next = sentenceStep(current.plan, cursorRef.current, by)
      moveTo(next ?? (by === -1 ? cursorRef.current : null))
    },
    [moveTo],
  )

  const stepParagraph = useCallback(
    (by: -1 | 1) => {
      const current = spokenRef.current
      if (!current) return
      const next = paragraphStep(current.plan, cursorRef.current, by)
      moveTo(next ?? (by === -1 ? cursorRef.current : null))
    },
    [moveTo],
  )

  /**
   * A whole chapter away.
   *
   * The reading is not restarted here and the cursor is not moved: navigating
   * changes the spine document, and the document effect below is what speaks the
   * new one — the same path a reader taking a chapter from the contents already
   * goes down while listening. Nothing to do but ask.
   */
  const stepChapter = useCallback((by: -1 | 1) => {
    if (!readingRef.current) return
    clearContinuation()
    pagingRef.current.chapter?.(by)
  }, [clearContinuation])

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
    clearContinuation()
    if (!doc) {
      readingRef.current = false
      speaker?.stop()
      setSpeaking(false)
      return
    }
    const queued = speakDocument(doc)
    if (queued) setSpeaking(true)
  }, [speaker, doc, speakDocument, clearContinuation])

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
      readingRef.current = false
      clearContinuation()
      speaker?.stop()
    },
    [speaker, clearContinuation],
  )

  /* READ FROM THE PROP, not from `pagingRef`: this decides what is RENDERED, so
   * it has to be a value the render sees change. The ref exists for callbacks
   * that need the value as of now, which is the opposite problem. */
  const chapters = paging.chapter !== undefined

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

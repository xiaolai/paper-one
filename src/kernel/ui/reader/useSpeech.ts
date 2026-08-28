import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Speaker,
  collectText,
  documentLang,
  placeOfRange,
  rangeAt,
  speechAvailable,
  type DoneReason,
  type SpokenText,
} from './speech'
import { placeSpokenWord, removeSpokenWord } from './rulerBand'

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
  /** False once the engine has shown it does not report word boundaries. */
  readonly followsWords: boolean
  start: () => void
  stop: () => void
}

/* NO pause HERE, deliberately (audit round 1, #845). The hook published
 * `paused`/`pause`/`resume` that no control consumed — state, callbacks and
 * re-renders behind a surface nothing reached — and this codebase grows a
 * public surface in the change that mounts it, not ahead of one. `Speaker`
 * keeps its engine-level pair for the control that will want them. */

/**
 * What the reading needs from the reader: one page forward, in READING
 * order — `next`, not `goRight`, because the voice is always ahead of where
 * it was, and in a right-to-left book ahead is to the left. The session's own
 * `next` is exactly this and is what the arrow key runs.
 */
export interface SpeechPaging {
  next: () => void
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

export function useSpeech(doc: Document | null, paging: SpeechPaging): Speech {
  const [speaking, setSpeaking] = useState(false)
  const [followsWords, setFollowsWords] = useState(true)

  const docRef = useRef<Document | null>(doc)
  const pagingRef = useRef(paging)
  /* The collected text AND the document it was collected from, together.
   *
   * Kept as one value on purpose. Held apart, `docRef` is reassigned during
   * render the moment the spine item changes, while `spokenRef` still holds the
   * previous section's node index — and a boundary event arriving in that gap
   * resolves offsets from the OLD chapter against the NEW document, which is
   * how the highlight ends up on an unrelated word. Pairing them makes that
   * state unrepresentable: the handler uses the document the text came from,
   * and does nothing once that is no longer the document on screen. */
  const spokenRef = useRef<{ doc: Document; spoken: SpokenText } | null>(null)
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
        const range = rangeAt(current.spoken, target, index, length)
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
        if (reason === 'error' || !readingRef.current) {
          finish()
          return
        }
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
  const speakDocument = useCallback(
    (target: Document): boolean => {
      if (!speaker) return false
      const spoken = collectText(target)
      spokenRef.current = { doc: target, spoken }
      turnedAt.current = null
      return speaker.speak(spoken.text, documentLang(target))
    },
    [speaker],
  )

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
    removeSpokenWord(docRef.current)
  }, [speaker, clearContinuation])

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

  return useMemo<Speech>(
    () => ({ available, speaking, followsWords, start, stop }),
    [available, speaking, followsWords, start, stop],
  )
}

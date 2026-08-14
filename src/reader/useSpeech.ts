import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Speaker, collectText, rangeAt, speechAvailable, type SpokenText } from './speech'
import { placeSpokenWord, removeSpokenWord } from './rulerBand'

/**
 * Reading the open section aloud, with the spoken word followed on the page.
 *
 * The highlight goes into the book document for the same reason the ruler's
 * band does: it has to sit on the text, in the text's own coordinate space, and
 * the host cannot draw there. It reuses the band's placement helpers rather
 * than growing a second way to put a rectangle behind a line.
 */

export interface Speech {
  readonly available: boolean
  readonly speaking: boolean
  readonly paused: boolean
  /** False once the engine has shown it does not report word boundaries. */
  readonly followsWords: boolean
  start: () => void
  pause: () => void
  resume: () => void
  stop: () => void
}

export function useSpeech(doc: Document | null): Speech {
  const [speaking, setSpeaking] = useState(false)
  const [paused, setPaused] = useState(false)
  const [followsWords, setFollowsWords] = useState(true)

  const docRef = useRef<Document | null>(doc)
  docRef.current = doc
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
  followsRef.current = followsWords

  const available = useMemo(() => speechAvailable(), [])

  const speaker = useMemo(() => {
    if (!available) return null
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
        const rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return
        // Viewport coordinates, unadjusted: `placeSpokenWord` converts into
        // body's space, which is invariant under scrolling.
        placeSpokenWord(target, {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        })
      },
      onDone: () => {
        setSpeaking(false)
        setPaused(false)
        removeSpokenWord(docRef.current)
      },
      onNoBoundaries: () => {
        // Reading continues; only the follow-along is dropped. Leaving the
        // band parked on the first word for the rest of the chapter would be
        // worse than not drawing one.
        setFollowsWords(false)
        removeSpokenWord(docRef.current)
      },
    })
  }, [available])

  const start = useCallback(() => {
    const target = docRef.current
    if (!speaker || !target) return
    const spoken = collectText(target)
    spokenRef.current = { doc: target, spoken }
    setFollowsWords(true)
    /* Only claim to be speaking if something was actually queued.
     *
     * A section with no readable text — a plate, a full-page image — calls
     * `onDone` synchronously from inside `speak`, so setting `speaking` to true
     * afterwards overwrites the done that has already been reported and leaves
     * the Listen control switched on with silence behind it. */
    const queued = speaker.speak(spoken.text)
    setSpeaking(queued)
    setPaused(false)
  }, [speaker])

  /* The flag follows the ENGINE, not the call. `pause()` does nothing unless
   * something is speaking and `resume()` does nothing unless it is paused, so
   * setting the state unconditionally left the controls describing a state the
   * synthesiser was never in — a Resume button over silence, or a Pause button
   * that had already been ignored. */
  const pause = useCallback(() => {
    if (!speaker) return
    speaker.pause()
    setPaused(speaker.paused)
  }, [speaker])

  const resume = useCallback(() => {
    if (!speaker) return
    speaker.resume()
    setPaused(speaker.paused)
  }, [speaker])

  const stop = useCallback(() => {
    speaker?.stop()
    setSpeaking(false)
    setPaused(false)
    removeSpokenWord(docRef.current)
  }, [speaker])

  /* Speech is a property of the window, not of the component: an utterance
   * outlives an unmount and would go on reading a book that has been closed.
   * The spine document changing is the same event — the words being read are
   * no longer on screen. */
  useEffect(() => {
    /* `doc` from the closure, NOT `docRef.current`. The ref has already been
     * reassigned to the incoming document by the time this cleanup runs, so
     * reading it strips the highlight out of the document that just arrived and
     * leaves the real one behind in the document being torn down. */
    const leaving = doc
    return () => {
      speaker?.stop()
      removeSpokenWord(leaving)
      spokenRef.current = null
      /* Set explicitly rather than waited for: `cancel()` is not required to
       * emit `end`, so the controls would otherwise stay switched on with
       * nothing playing. */
      setSpeaking(false)
      setPaused(false)
    }
  }, [speaker, doc])

  return useMemo<Speech>(
    () => ({ available, speaking, paused, followsWords, start, pause, resume, stop }),
    [available, speaking, paused, followsWords, start, pause, resume, stop],
  )
}

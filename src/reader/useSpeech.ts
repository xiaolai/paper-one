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
  const spokenRef = useRef<SpokenText | null>(null)
  /* Read inside the boundary handler, which is created once per utterance —
   * a captured `followsWords` would be the value at the time speech started. */
  const followsRef = useRef(true)
  followsRef.current = followsWords

  const available = useMemo(() => speechAvailable(), [])

  const speaker = useMemo(() => {
    if (!available) return null
    return new Speaker({
      onWord: (index, length) => {
        const target = docRef.current
        const spoken = spokenRef.current
        if (!target || !spoken || !followsRef.current) return
        const range = rangeAt(spoken, target, index, length)
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
    spokenRef.current = spoken
    setFollowsWords(true)
    speaker.speak(spoken.text)
    setSpeaking(true)
    setPaused(false)
  }, [speaker])

  const pause = useCallback(() => {
    speaker?.pause()
    setPaused(true)
  }, [speaker])

  const resume = useCallback(() => {
    speaker?.resume()
    setPaused(false)
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
    return () => {
      speaker?.stop()
      removeSpokenWord(docRef.current)
    }
  }, [speaker, doc])

  return useMemo<Speech>(
    () => ({ available, speaking, paused, followsWords, start, pause, resume, stop }),
    [available, speaking, paused, followsWords, start, pause, resume, stop],
  )
}

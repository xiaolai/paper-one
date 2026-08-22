import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Speaker, wordLengthAt } from './speech'

/**
 * `collectText` and `rangeAt` are NOT unit-tested here, deliberately.
 *
 * Both need a real Document, and this file runs under the default `node`
 * environment. THE REASON IS NO LONGER COST: jsdom is a devDependency, and
 * files in this tree already opt in with `// @vitest-environment jsdom`, so
 * adding it here is one line. The note used to say a DOM meant a new
 * dependency and a lockfile re-resolution blocked under pnpm's release-age
 * policy; that was true when it was written and is not true now.
 *
 * What survives, and is the whole argument: a jsdom test here would assert
 * against jsdom's APPROXIMATION of WebKit's layout rather than against WebKit,
 * and layout is precisely what these two get wrong.
 *
 * They are verified instead against the running app through the MCP bridge, on
 * the actual engine the reader ships on, per the project's own end-to-end note.
 * That is better evidence for exactly the thing that can go wrong here: the
 * highlight landing on the wrong word. What is left below is the part with no
 * DOM in it, which is also the part with the sharp edge.
 */

/**
 * A stand-in for the platform's speech synthesis.
 *
 * Enough of it to drive `Speaker`: utterances are EventTargets, and `cancel`
 * does what the real one does — it stops the audio but still delivers the
 * cancelled utterance's `end`, LATE. That late event is the whole reason the
 * generation counter exists, and it cannot be reproduced any other way.
 */
class FakeUtterance extends EventTarget {
  constructor(readonly text: string) {
    super()
  }
}

class FakeSynth {
  readonly queued: FakeUtterance[] = []
  speaking = false
  paused = false

  speak(utterance: FakeUtterance): void {
    this.queued.push(utterance)
    this.speaking = true
  }

  cancel(): void {
    this.speaking = false
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }
}

describe('Speaker', () => {
  let synth: FakeSynth
  const original = globalThis.SpeechSynthesisUtterance

  beforeEach(() => {
    synth = new FakeSynth()
    globalThis.SpeechSynthesisUtterance =
      FakeUtterance as unknown as typeof SpeechSynthesisUtterance
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.SpeechSynthesisUtterance = original
    vi.useRealTimers()
  })

  const make = () => {
    const onDone = vi.fn()
    const onNoBoundaries = vi.fn()
    const speaker = new Speaker(
      { onWord: vi.fn(), onDone, onNoBoundaries },
      synth as unknown as SpeechSynthesis,
    )
    return { speaker, onDone, onNoBoundaries }
  }

  it('reports nothing was queued for a section with no readable text', () => {
    // A plate or a full-page image. `onDone` fires SYNCHRONOUSLY here, so a
    // caller that sets its own flag afterwards overwrites it — hence the
    // boolean rather than a void return.
    const { speaker, onDone } = make()
    expect(speaker.speak('   ')).toBe(false)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(synth.queued).toHaveLength(0)
  })

  it('ignores the end of an utterance that was already cancelled', () => {
    const { speaker, onDone } = make()
    speaker.speak('first')
    const first = synth.queued[0]
    expect(first).toBeDefined()

    speaker.speak('second')
    // The cancelled utterance's end, arriving after the new one has started.
    first?.dispatchEvent(new Event('end'))
    expect(onDone).not.toHaveBeenCalled()

    synth.queued[1]?.dispatchEvent(new Event('end'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('waits for the voice to start before timing the boundary grace', () => {
    // A cold voice can take seconds to begin. A timer started at queue time
    // spends that wait counting down and then concludes, from silence that has
    // not been given a chance to be broken, that this engine sends no
    // boundaries — dropping the follow-along for the whole chapter.
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first')
    vi.advanceTimersByTime(10_000)
    expect(onNoBoundaries).not.toHaveBeenCalled()

    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(10_000)
    expect(onNoBoundaries).toHaveBeenCalledTimes(1)
  })

  it('does not blame the current utterance for a stale missing boundary', () => {
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first')
    synth.queued[0]?.dispatchEvent(new Event('start'))
    speaker.stop()
    // The first utterance's grace period expiring must not strip the
    // follow-along from a reading that is no longer the same one.
    vi.advanceTimersByTime(10_000)
    expect(onNoBoundaries).not.toHaveBeenCalled()
  })

  it('treats an error as an end, so the controls come back', () => {
    const { speaker, onDone } = make()
    speaker.speak('first')
    synth.queued[0]?.dispatchEvent(new Event('error'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

describe('wordLengthAt', () => {
  it('measures the word when the engine reports no length', () => {
    // WebKit reports charLength 0 on some voices, and a zero-width highlight
    // is invisible — indistinguishable from boundaries not working at all.
    expect(wordLengthAt('Call me Ishmael', 8)).toBe(7)
    expect(wordLengthAt('Call me Ishmael', 0)).toBe(4)
  })

  it('measures a word ending at the end of the text', () => {
    expect(wordLengthAt('Call me', 5)).toBe(2)
  })

  it('never returns zero, so the highlight is never invisible', () => {
    // Pointed at whitespace — which a conforming engine does not do, since
    // charIndex is a word start. The floor is what stops a malformed event
    // producing a zero-width box.
    expect(wordLengthAt('Call me', 4)).toBe(1)
    expect(wordLengthAt('Call ', 4)).toBe(1)
    expect(wordLengthAt('', 0)).toBe(1)
  })
})

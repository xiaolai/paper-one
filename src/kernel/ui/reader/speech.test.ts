import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Speaker, placeOf, wordLengthAt } from './speech'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'
import type { HostRect } from './coordinates'

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
 *
 * The follow-along's page decision IS here, because it is arithmetic over two
 * rects — the measuring of those rects is `coordinates.ts`'s and the hook's,
 * and `useSpeech.test.tsx` mounts the wiring over stubbed rects.
 */

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
    expect(speaker.speak('   ', null)).toBe(false)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('empty')
    expect(synth.queued).toHaveLength(0)
  })

  it('speaks in the language it is given', () => {
    // `ensureLang` puts the book's `dc:language` on the section's root for
    // hyphenation; the voice needs the same word. Without it every French
    // book is read by the English default voice, letter-perfectly wrong.
    const { speaker } = make()
    speaker.speak('Bonjour le monde', 'fr')
    expect(synth.queued[0]?.lang).toBe('fr')
  })

  it('leaves the voice to its default when the document declares no language', () => {
    // An empty `lang` is not "no preference" to every engine: WebKit treats
    // `''` as a language it has no voice for. Unset is the only safe default.
    const { speaker } = make()
    speaker.speak('Hello', null)
    speaker.speak('Hello', '')
    expect(synth.queued[0]).not.toHaveProperty('lang')
    expect(synth.queued[1]).not.toHaveProperty('lang')
  })

  it('ignores the end of an utterance that was already cancelled', () => {
    const { speaker, onDone } = make()
    speaker.speak('first', null)
    const first = synth.queued[0]
    expect(first).toBeDefined()

    speaker.speak('second', null)
    // The cancelled utterance's end, arriving after the new one has started.
    first?.dispatchEvent(new Event('end'))
    expect(onDone).not.toHaveBeenCalled()

    synth.queued[1]?.dispatchEvent(new Event('end'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('says whether it finished the text or broke off', () => {
    // The caller continues into the next section on `ended` and stops on
    // `error`: an engine that fails one section would fail the next, and a
    // reading that walks the whole book erroring is not a reading.
    const { speaker, onDone } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('end'))
    expect(onDone).toHaveBeenLastCalledWith('ended')

    speaker.speak('second', null)
    synth.queued[1]?.dispatchEvent(new Event('error'))
    expect(onDone).toHaveBeenLastCalledWith('error')
  })

  it('waits for the voice to start before timing the boundary grace', () => {
    // A cold voice can take seconds to begin. A timer started at queue time
    // spends that wait counting down and then concludes, from silence that has
    // not been given a chance to be broken, that this engine sends no
    // boundaries — dropping the follow-along for the whole chapter.
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first', null)
    vi.advanceTimersByTime(10_000)
    expect(onNoBoundaries).not.toHaveBeenCalled()

    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(10_000)
    expect(onNoBoundaries).toHaveBeenCalledTimes(1)
  })

  it('does not blame the current utterance for a stale missing boundary', () => {
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('start'))
    speaker.stop()
    // The first utterance's grace period expiring must not strip the
    // follow-along from a reading that is no longer the same one.
    vi.advanceTimersByTime(10_000)
    expect(onNoBoundaries).not.toHaveBeenCalled()
  })

  it('treats an error as an end, so the controls come back', () => {
    const { speaker, onDone } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('error'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('reports one ending for an engine that sends error AND end', () => {
    // One utterance is one ending, but an engine is free to deliver both
    // events for it — WebKit does on some voices. Both handlers held the same
    // live generation, so `onDone` fired twice and the second call cancelled
    // the continuation the first had started (audit round 1, #503).
    const { speaker, onDone } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('error'))
    synth.queued[0]?.dispatchEvent(new Event('end'))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('error')
  })

  it('does not run the boundary grace out over a pause', () => {
    // The grace measures SPEECH. Paused inside the first 2.5 s, the timer
    // used to run out over silence and drop the follow-along for the whole
    // reading on an engine that reports boundaries perfectly well (audit
    // round 1, #502). Cleared on pause, re-armed whole on resume.
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(1000)
    speaker.pause()
    vi.advanceTimersByTime(60_000)
    expect(onNoBoundaries).not.toHaveBeenCalled()
    speaker.resume()
    vi.advanceTimersByTime(2499)
    expect(onNoBoundaries).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(onNoBoundaries).toHaveBeenCalledTimes(1)
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

/**
 * Where a spoken word is, relative to the page on screen.
 *
 * Host-space rects, as `coordinates.ts` hands them over: a paginated section
 * is laid out in columns wider than the stage, so a word four pages on has a
 * perfectly good rect — one the reader cannot see.
 */
describe('placeOf', () => {
  const box = (left: number, top: number, width: number, height: number): HostRect => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  })
  /** A 1000×800 stage. */
  const page = box(0, 0, 1000, 800)

  it('a word on the page is visible, even one only partly on it', () => {
    expect(placeOf(box(100, 100, 60, 20), page, 'ltr')).toBe('visible')
    // Straddling the right edge: the line is on screen, the word is cut. Not
    // a reason to turn — the reader can see where the voice is.
    expect(placeOf(box(980, 100, 60, 20), page, 'ltr')).toBe('visible')
  })

  it('a word in the next column is ahead in a left-to-right book', () => {
    expect(placeOf(box(1200, 100, 60, 20), page, 'ltr')).toBe('ahead')
  })

  it('a word in the previous column is behind, and is never turned to', () => {
    // The reader flipped forward to peek. Turning "to" a word behind the view
    // would mean `prev`, and following the voice backwards would fight the
    // reader's hand; turning forward would run away from it page after page.
    expect(placeOf(box(-500, 100, 60, 20), page, 'ltr')).toBe('behind')
  })

  it('a right-to-left book reads the columns the other way', () => {
    expect(placeOf(box(-500, 100, 60, 20), page, 'rtl')).toBe('ahead')
    expect(placeOf(box(1200, 100, 60, 20), page, 'rtl')).toBe('behind')
  })

  it('in scrolled flow the vertical axis decides, whichever way the text runs', () => {
    expect(placeOf(box(100, 900, 60, 20), page, 'ltr')).toBe('ahead')
    expect(placeOf(box(100, 900, 60, 20), page, 'rtl')).toBe('ahead')
    expect(placeOf(box(100, -100, 60, 20), page, 'ltr')).toBe('behind')
  })
})

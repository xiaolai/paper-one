// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Speaker, collectText, placeOf, speechAvailable, wordLengthAt } from './speech'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'
import type { HostRect } from './coordinates'

/**
 * ⚠️ **THIS FILE RAN IN jsdom FOR MONTHS WITHOUT DECLARING IT, AND THIS COMMENT
 * IS WHAT PUT IT THERE.** Vitest looks for its environment docblock by scanning
 * the WHOLE file, not the first line — so the sentence that used to stand here,
 * explaining which token a file would opt in with, WAS that token. The
 * environment was set by prose about the environment. `document` was therefore
 * available, one case below uses it, and this header spent three paragraphs
 * arguing that the file had no DOM.
 *
 * It is declared on line 1 now, where Vitest's first match is deterministic and
 * where a reader looks; the token is not written out again anywhere below, and
 * `scripts/test-environment.test.mjs` refuses a test file that only mentions it
 * in prose. Same shape as this repository's `Stryker disable` trap — to a grep
 * it is a directive, to the tool it is a sentence — and the same fix: ask the
 * tool, not the text.
 *
 * ## What is asserted here, and what is left to the running app
 *
 * `rangeAt` and the geometry are NOT unit-tested here, and that argument is
 * unchanged: a jsdom case would assert against jsdom's APPROXIMATION of
 * WebKit's layout rather than against WebKit, and layout is precisely what
 * they get wrong. They are verified against the running app through the MCP
 * bridge, on the engine the reader ships on, which is better evidence for the
 * thing that goes wrong — the highlight landing on the wrong word.
 *
 * `collectText`'s WALK is here, because none of it is layout. The computed
 * styles it reads come from the case, through a stub `defaultView` of three
 * properties, so what is under test is what `collectText` does with an answer
 * rather than what jsdom would have answered. A document built with
 * `createHTMLDocument` has no `defaultView` at all, which is the other half:
 * the walk with no styles available is a real case the audiobook meets.
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

  /**
   * ⚠️ **THE VOICE IS CHOSEN, AND FOR MONTHS IT WAS NOT.** `speak` set only
   * `lang`, so WebKit answered with its own default — measured on macOS 27 as
   * `com.apple.voice.super-compact.en-US.Samantha`, the most compressed voice
   * Apple ships, for every book in every language. `voiceChoice.ts` holds the
   * ranking; these cases hold that `Speaker` applies it, and — the half a
   * ranking test cannot see — that it leaves the property ALONE when it has
   * nothing to say.
   */
  describe('choosing a voice', () => {
    const zoe = { name: 'Zoe', lang: 'en-US', voiceURI: 'com.apple.voice.enhanced.en-US.Zoe' }
    const ava = { name: 'Ava', lang: 'en-US', voiceURI: 'com.apple.voice.premium.en-US.Ava' }
    const tingting = { name: 'Tingting', lang: 'zh-CN', voiceURI: 'com.apple.voice.enhanced.zh-CN.Tingting' }
    /* What a Mac's WebView actually offers — measured, see `voiceChoice.ts`. */
    const compact = { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }
    const superCompact = {
      name: 'Samantha',
      lang: 'en-US',
      voiceURI: 'com.apple.voice.super-compact.en-US.Samantha',
    }

    it('takes the best installed voice for the document language', () => {
      synth.voices = [zoe, ava, tingting]
      const { speaker } = make()
      speaker.speak('hello', 'en-US')
      expect(synth.queued[0]?.voice).toBe(ava)
    })

    it('speaks a Chinese section in a Chinese voice', () => {
      // The defect this prevents is the one the reader cannot diagnose: a
      // Chinese book read aloud by an English voice.
      synth.voices = [zoe, ava, tingting]
      const { speaker } = make()
      speaker.speak('你好', 'zh-CN')
      expect(synth.queued[0]?.voice).toBe(tingting)
    })

    it("honours the reader's own choice over the better voice", () => {
      synth.voices = [zoe, ava]
      const { speaker } = make()
      speaker.speak('hello', 'en-US', { voices: { en: zoe.voiceURI } })
      expect(synth.queued[0]?.voice).toBe(zoe)
    })

    it('leaves the voice unset while the engine has no list yet', () => {
      /* `getVoices()` is EMPTY until the engine has loaded it, which is the
       * state at the start of a session — nothing to judge, so nothing is
       * refused. Assigning `null` there is not a no-op on every engine — the
       * same measurement `documentLang` records for an empty `lang` — so the
       * property must be untouched, and "untouched" is what `FakeUtterance`
       * declares rather than initialises so this can be asked at all. */
      synth.voices = []
      const { speaker } = make()
      speaker.speak('hello', 'en-US')
      expect('voice' in (synth.queued[0] as object)).toBe(false)
    })

    it('leaves the voice unset for a section that declares no language, among good voices', () => {
      synth.voices = [zoe]
      const { speaker } = make()
      speaker.speak('hello', null)
      expect('voice' in (synth.queued[0] as object)).toBe(false)
    })

    /**
     * ⚠️ **NO VOICE RATHER THAN A BAD ONE — AND IT USED TO READ THE BOOK
     * ANYWAY.** With nothing above the floor, the utterance was queued with its
     * voice unset, so the platform chose — on a Mac, compact Samantha, the voice
     * the floor had just refused. Now nothing is queued and `onDone` says why,
     * synchronously, the way `empty` does.
     */
    it('speaks nothing, and says why, when no voice above the floor speaks the language', () => {
      synth.voices = [compact, superCompact]
      const { speaker, onDone } = make()
      expect(speaker.speak('hello', 'en-US')).toBe(false)
      expect(synth.queued).toEqual([])
      expect(onDone).toHaveBeenCalledWith('no-voice')
    })

    it('speaks nothing for a section in a language only other languages have good voices for', () => {
      synth.voices = [tingting]
      const { speaker, onDone } = make()
      expect(speaker.speak('bonjour', 'fr-FR')).toBe(false)
      expect(synth.queued).toEqual([])
      expect(onDone).toHaveBeenCalledWith('no-voice')
    })

    it('speaks nothing for a section with no language when every voice is below the floor', () => {
      synth.voices = [compact, superCompact]
      const { speaker, onDone } = make()
      expect(speaker.speak('hello', null)).toBe(false)
      expect(onDone).toHaveBeenCalledWith('no-voice')
    })
  })

  describe('the reading rate', () => {
    it('applies a rate the reader chose', () => {
      const { speaker } = make()
      speaker.speak('hello', null, { rate: 1.25 })
      expect(synth.queued[0]?.rate).toBe(1.25)
    })

    /* ⚠️ **THIS USED TO ASSERT THE PROPERTY WAS ABSENT, AND THE CLAIM IS THE
       SAME ONE IN THE ONLY SPELLING THE CODE CAN NOW PRODUCE.** An absent
       preference had a branch of its own, and that branch existed only to hold
       two checks the range test made unobservable — see the comment in `speak`.
       `1` is not a speed Paper picked: the spec defines `rate` as a multiplier
       on the voice's own, whose default is exactly 1, so assigning it and
       leaving it alone are one instruction. `lang` and `voice` are NOT like
       this, and both still assert absence above. */
    it('hands the engine its own default when no rate was chosen', () => {
      const { speaker } = make()
      speaker.speak('hello', null)
      expect(synth.queued[0]?.rate).toBe(1)
    })

    /* THE BOUNDS AT THEIR EXACT VALUES, both of them: the spec's range is
       inclusive, and a refusal at either end is a reader's chosen speed
       silently replaced by the engine's. The numbers are written out rather
       than imported so that moving `MIN_ENGINE_RATE` fails here. */
    it.each([
      ['the slowest speed the spec allows', 0.1],
      ['the fastest speed the spec allows', 10],
    ])('applies %s', (_name, rate) => {
      const { speaker } = make()
      speaker.speak('hello', null, { rate })
      expect(synth.queued[0]?.rate).toBe(rate)
    })

    it.each([
      ['a hair below the floor', 0.09],
      ['a hair above the ceiling', 10.1],
      ['a hand-edited 100', 100],
    ])('refuses %s, leaving the engine its own speed', (_name, rate) => {
      const { speaker } = make()
      speaker.speak('hello', null, { rate })
      expect('rate' in (synth.queued[0] as object)).toBe(false)
    })

    it('refuses a rate that would throw, rather than passing it on', () => {
      /* The stored value arrives from a settings file a reader can hand-edit,
       * and `rate = NaN` throws on some engines — which would take the whole
       * reading down for a bad character in a preference. */
      const { speaker } = make()
      speaker.speak('hello', null, { rate: Number.NaN })
      expect('rate' in (synth.queued[0] as object)).toBe(false)
      speaker.speak('hello', null, { rate: 0 })
      expect('rate' in (synth.queued[1] as object)).toBe(false)
    })
  })

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

  /**
   * ⚠️ **TWO SPEAKERS OVER ONE ENGINE, WHICH IS WHAT THE APP NOW HAS.** The
   * reading owns one and the lookup popup's pronunciation owns another, and
   * `speak` begins with `stop()` — so the second one to speak cancels the
   * first's utterance, and a cancelled utterance still delivers its `end`. With
   * the first speaker's own generation still current, its `#finish` read that
   * `end` as "the section finished" and `useSpeech` walked the pages forward
   * hunting the next section while the reader listened to one word being
   * pronounced. `taken` is what separates "my utterance ended" from "somebody
   * took the engine".
   */
  it('does not report a section finished when another speaker took the engine', () => {
    const reading = make()
    const pronouncing = make()
    reading.speaker.speak('a whole section', null)
    const section = synth.queued[0]

    pronouncing.speaker.speak('gam', null)
    section?.dispatchEvent(new Event('end'))

    expect(reading.onDone).toHaveBeenCalledTimes(1)
    expect(reading.onDone).toHaveBeenCalledWith('taken')
  })

  /* AND THE ONE THAT TOOK IT STILL REPORTS ITS OWN ENDING — the guard is about
     whose engine it is, not about there having been two speakers. */
  it('still reports its own ending for the speaker holding the engine', () => {
    const reading = make()
    const pronouncing = make()
    reading.speaker.speak('a whole section', null)
    pronouncing.speaker.speak('gam', null)

    synth.queued[1]?.dispatchEvent(new Event('end'))

    expect(pronouncing.onDone).toHaveBeenCalledWith('ended')
  })

  /*
   * ⚠️ **AND THE CLAIM IS MADE BEFORE THE CANCEL, WHICH A SYNCHRONOUS ENGINE IS
   * WHAT DISTINGUISHES.** `speak` calls `stop()` — the cancel — on its second
   * line, and an engine free to deliver the cancelled utterance's `end` from
   * inside `cancel()` would find the previous holder still recorded and be told
   * its section had finished. Driven with a synth that does exactly that.
   */
  it('claims the engine before cancelling, so even a synchronous end is taken', () => {
    const reading = make()
    reading.speaker.speak('a whole section', null)
    const section = synth.queued[0]
    /* An engine that ends the cancelled utterance from inside `cancel()`. */
    synth.cancel = () => {
      synth.cancelled += 1
      synth.speaking = false
      section?.dispatchEvent(new Event('end'))
    }

    const pronouncing = new Speaker(
      { onWord: vi.fn(), onDone: vi.fn(), onNoBoundaries: vi.fn() },
      synth as unknown as SpeechSynthesis,
    )
    pronouncing.speak('gam', null)

    expect(reading.onDone).toHaveBeenCalledWith('taken')
  })

  /**
   * ⚠️ **AND `stop()` MAY NOT CANCEL AN ENGINE IT DOES NOT HOLD.** It was
   * unconditional, on the ground that "cancel() on an idle synth is harmless" —
   * true of an idle engine and false of one somebody else is using. The lookup
   * popup calls `Voice.stop` on EVERY selection change, so a reader listening to
   * the book who merely opened and dismissed a lookup had the reading cancelled,
   * by a speaker whose own utterance was long finished.
   */
  it('does not cancel an engine another speaker is holding', () => {
    const reading = make()
    const pronouncing = make()
    pronouncing.speaker.speak('gam', null)
    synth.queued[0]?.dispatchEvent(new Event('end'))
    reading.speaker.speak('a whole section', null)
    const cancels = synth.cancelled

    /* The popup going away, which is a `stop` on a speaker that finished long
       ago and does not hold the engine. */
    pronouncing.speaker.stop()

    expect(synth.cancelled).toBe(cancels)
    expect(reading.onDone).not.toHaveBeenCalled()
  })

  /* AND IT STILL CANCELS ITS OWN, which is the behaviour the unconditional
     version existed for — including an utterance queued for a previous
     section, because `speak` claims the engine before stopping. */
  it('cancels its own utterance when it is the one holding the engine', () => {
    const { speaker } = make()
    speaker.speak('first', null)
    const before = synth.cancelled

    speaker.stop()

    expect(synth.cancelled).toBe(before + 1)
  })

  /* ONE SPEAKER ON ONE ENGINE IS UNAFFECTED: its own second utterance retires
     the first by generation, exactly as it always did, and nothing is reported
     as taken. */
  it('says nothing about a speaker replacing its own utterance', () => {
    const { speaker, onDone } = make()
    speaker.speak('first', null)
    const first = synth.queued[0]

    speaker.speak('second', null)
    first?.dispatchEvent(new Event('end'))

    expect(onDone).not.toHaveBeenCalled()
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

  /**
   * ⚠️ **THE INVARIANT THE TIMER USED TO CHECK FOR ITSELF, ASSERTED ONCE PER
   * PATH.** It captured the reading's generation and compared it on firing —
   * unreachable, because a pending timer always belongs to the current reading:
   * every one of the three writes to the generation clears it within a line.
   * The comparison could therefore never come back false, no test could kill
   * it, and the guard said nothing that these three do not say better. A fourth
   * path that bumps the generation and forgets the clear fails HERE.
   *
   * The case above is the same assertion for `stop()`, kept where it was
   * because it names the defect it came from.
   */
  it.each([
    ['a new reading starts', (speaker: Speaker) => void speaker.speak('second', null)],
    ['the utterance ends', () => synth.queued[0]?.dispatchEvent(new Event('end'))],
    ['the utterance fails', () => synth.queued[0]?.dispatchEvent(new Event('error'))],
  ])('drops the pending grace when %s', (_name, retire) => {
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(1000)

    retire(speaker)
    vi.advanceTimersByTime(60_000)
    expect(onNoBoundaries, 'a retired reading reports nothing').not.toHaveBeenCalled()
  })

  /* AND THE OTHER END OF THE SAME INVARIANT: a cancelled utterance still
     delivers its events, LATE — that is what the testkit exists to reproduce —
     so a `start` can arrive for a reading that is over. Arming on it would
     measure the new reading's silence from an event belonging to the old one,
     and take the follow-along away from a sentence that had not begun. */
  it('does not arm a grace on a cancelled utterance starting late', () => {
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first', null)
    speaker.speak('second', null)

    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(60_000)
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

  /**
   * ⚠️ **"CALLED ONCE" WAS THE CONTRACT AND NOTHING KEPT COUNT.** After the grace
   * ran out the first time, every pause and resume armed a fresh timer, and
   * `resume` armed it without clearing the one before — so the callback came
   * back on every cycle, and two resumes left two timers running. The consumer's
   * `setFollowsWords(false)` is idempotent, which is exactly why no test noticed.
   */
  it('reports a missing boundary once per reading, however often it is paused', () => {
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(10_000)
    expect(onNoBoundaries).toHaveBeenCalledTimes(1)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      speaker.pause()
      speaker.resume()
      speaker.resume()
      vi.advanceTimersByTime(10_000)
    }
    expect(onNoBoundaries, 'still once, and no doubled timer either').toHaveBeenCalledTimes(1)
  })

  /* AND THE NEXT READING MEASURES AGAIN. One Speaker serves every reading and the
     hook resets `followsWords` to true at each start — so a flag held for the
     Speaker's life would let the highlight return and park on its first word with
     nothing left to correct it. */
  it('measures the engine afresh once a reading has stopped', () => {
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(10_000)
    speaker.stop()

    speaker.speak('second', null)
    synth.queued[synth.queued.length - 1]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(10_000)
    expect(onNoBoundaries, 'once for each reading').toHaveBeenCalledTimes(2)
  })

  /* A BOUNDARY INSIDE THE GRACE IS THE ANSWER THE GRACE IS WAITING FOR, and the
     timer fires anyway — it is not cancelled, it asks. Without that question a
     reading whose first word arrives at 1 s would have its follow-along switched
     off at 2.5 s by an engine that had just proved it reports boundaries. */
  it('keeps the follow-along when a boundary arrives inside the grace', () => {
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first words here', null)
    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(1000)
    synth.queued[0]?.dispatchEvent(
      Object.assign(new Event('boundary'), { charIndex: 0, charLength: 5, name: 'word' }),
    )
    vi.advanceTimersByTime(60_000)
    expect(onNoBoundaries).not.toHaveBeenCalled()
  })

  /* ⚠️ **AND THE MEASUREMENT RESTARTS AT THE LATEST START, NOT THE FIRST.** An
     engine is free to say `start` again — an utterance that restarts does — and
     a grace left running from the first one expires 2.5 s after speech that has
     since begun again, which is the same false negative the pause case records.
     `#armGrace` clears before it arms, every time, and this is what says so. */
  it('measures the grace from the most recent start', () => {
    const { speaker, onNoBoundaries } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('start'))
    vi.advanceTimersByTime(2000)
    synth.queued[0]?.dispatchEvent(new Event('start'))

    vi.advanceTimersByTime(600)
    expect(onNoBoundaries, 'the first start no longer decides anything').not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(onNoBoundaries, 'and the second one does, 2.5 s after itself').toHaveBeenCalledTimes(1)
  })

  /**
   * The three commands on the shared engine, each refused to a speaker that is
   * not holding it.
   *
   * ⚠️ **`stop()`'s RULE, WHICH `pause` AND `resume` DID NOT FOLLOW.** One engine
   * serves every speaker, so an unguarded `pause` holds somebody else's
   * utterance and an unguarded `resume` releases one mid-word. Each case drives
   * the refused command and then the same command from the holder, so that "the
   * engine did not move" is told apart from "the fake cannot move".
   */
  describe('the engine it is not holding', () => {
    const other = () =>
      new Speaker(
        { onWord: vi.fn(), onDone: vi.fn(), onNoBoundaries: vi.fn() },
        synth as unknown as SpeechSynthesis,
      )

    it('is not paused by a speaker that has lost it', () => {
      const { speaker } = make()
      speaker.speak('first', null)
      const taker = other()
      taker.speak('second', null)

      speaker.pause()
      expect(synth.paused, 'the holder is still speaking').toBe(false)
      taker.pause()
      expect(synth.paused, 'and the holder can pause it').toBe(true)
    })

    it('is not resumed by a speaker that has lost it', () => {
      const { speaker } = make()
      speaker.speak('first', null)
      const taker = other()
      taker.speak('second', null)
      taker.pause()
      expect(synth.paused).toBe(true)

      speaker.resume()
      expect(synth.paused, "the holder's pause stands").toBe(true)
      taker.resume()
      expect(synth.paused, 'and the holder can release it').toBe(false)
    })
  })

  /* ⚠️ **`cancel()` LEAVES THE PAUSE FLAG SET, so `stop()` releases the pause it
     set itself — and ONLY that one.** The flag belongs to the engine, not to an
     utterance: a reading stopped while paused used to leave the shared engine
     paused, and the next `speak` was queued behind it with every control
     reporting playback over silence. Resuming an engine that is not paused is a
     no-op by the spec, which is exactly why the count is what this asserts: a
     command issued on a shared engine for no reason is invisible in `paused`. */
  it('releases the pause it set, and issues no other resume', () => {
    const { speaker } = make()
    speaker.speak('first', null)
    speaker.stop()
    expect(synth.paused).toBe(false)
    expect(synth.resumed, 'nothing was paused, so nothing was resumed').toBe(0)

    speaker.speak('second', null)
    speaker.pause()
    expect(synth.paused).toBe(true)
    speaker.stop()
    expect(synth.paused, 'stopped while paused, and the engine is free').toBe(false)
    expect(synth.resumed).toBe(1)
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

/**
 * ⚠️ **A PROPERTY'S NAME IS NOT A WORKING ENGINE.** `speechAvailable` answered
 * `'speechSynthesis' in window`, so a webview that declared the property and
 * left it null — or had the engine and no `SpeechSynthesisUtterance` — drew the
 * Listen control, and the first press threw far from any reason a reader could
 * act on. It checks what `Speaker` actually calls.
 */
describe('speechAvailable', () => {
  const originalSynth = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis')
  const originalUtterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance')

  afterEach(() => {
    /* The window goes back before the properties do: one case takes it away,
       and every other case in this file needs it. */
    vi.unstubAllGlobals()
    for (const [name, original] of [
      ['speechSynthesis', originalSynth],
      ['SpeechSynthesisUtterance', originalUtterance],
    ] as const) {
      if (original) Object.defineProperty(globalThis, name, original)
      else delete (globalThis as Record<string, unknown>)[name]
    }
  })

  const install = (synth: unknown, utterance: unknown) => {
    Object.defineProperty(globalThis, 'speechSynthesis', { value: synth, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      value: utterance,
      configurable: true,
      writable: true,
    })
  }

  it('answers yes for an engine it can actually drive', () => {
    install(new FakeSynth(), FakeUtterance)
    expect(speechAvailable()).toBe(true)
  })

  /* ⚠️ **A BUILD WITH NO `window` AT ALL ANSWERS NO RATHER THAN THROWING**, and
     the engine is installed on `globalThis` here so that the window is the only
     thing under test. `speech.ts` is reached from the CLI's import graph and by
     anything that renders a section without a DOM — an audiobook export's text
     walk, a worker — where `window` is not declared and touching it is a
     ReferenceError rather than an undefined. The reading's question has to be
     answerable there. */
  it('answers no where there is no window at all', () => {
    install(new FakeSynth(), FakeUtterance)
    vi.stubGlobal('window', undefined)
    expect(speechAvailable()).toBe(false)
  })

  it.each([
    ['the property is there and null', null, FakeUtterance],
    ['the engine has no speak', { cancel: () => {} }, FakeUtterance],
    ['the engine has no cancel', { speak: () => {} }, FakeUtterance],
    ['there is no utterance constructor', { speak: () => {}, cancel: () => {} }, undefined],
  ])('answers no when %s', (_name, synth, utterance) => {
    install(synth, utterance)
    expect(speechAvailable()).toBe(false)
  })
})

/* A document with no `<body>` — an XML document that is not XHTML, a section
   whose parse produced none — made `createTreeWalker(null, …)` throw, so one
   such section ended an audiobook export as a crash instead of a chapter with
   nothing in it. */
describe('collectText without a body', () => {
  it('answers no text, rather than throwing', () => {
    const doc = document.implementation.createDocument(null, 'root', null)
    expect(doc.body).toBeNull()
    expect(collectText(doc)).toEqual({ text: '', segments: [], blocks: [] })
  })
})

/**
 * The walk, which is where the audible defects have been.
 *
 * ⚠️ **NOT A LAYOUT TEST, AND THAT IS THE WHOLE REASON IT CAN LIVE HERE.** Every
 * computed style `collectText` reads is supplied by the case, so nothing below
 * depends on what jsdom would answer — only on what the walk does with an
 * answer. A document from `createHTMLDocument` has NO `defaultView`, which is
 * the second half: with no window there are no styles to ask for, and
 * `blockAncestor` falls back to the parent element. Both states are real — the
 * reader has a window, the audiobook's section walk does not.
 *
 * The three things being pinned are the three that have been wrong and audible:
 * one space between blocks and never two, no space inside a word an inline
 * element divides, and a block index for text that lays out inside no block at
 * all.
 */
describe('collectText', () => {
  /** A body, with the computed `display` of every element decided by the case. */
  const bodyOf = (html: string, display?: (el: Element) => string): Document => {
    const doc = document.implementation.createHTMLDocument('')
    doc.body.innerHTML = html
    if (display) {
      Object.defineProperty(doc, 'defaultView', {
        configurable: true,
        value: {
          getComputedStyle: (el: Element) => ({
            display: display(el),
            visibility: 'visible',
            contentVisibility: 'visible',
          }),
        },
      })
    }
    return doc
  }

  /* ⚠️ **ONE SPACE BETWEEN TWO PARAGRAPHS, WHATEVER THE INDENTATION AROUND
     THEM.** A pretty-printed chapter has a whitespace node between nearly every
     pair of elements, and each one that adds a separator shifts every boundary
     offset after it — the follow-along highlight then drifts for the rest of the
     section. A leading one must add nothing at all: there is no word in front of
     it to separate. */
  it('separates blocks with a single space, and never opens with one', () => {
    const collected = collectText(bodyOf(' <p>One</p> <span> </span> <p>Two</p>'))
    expect(collected.text).toBe('One Two')
    expect(collected.blocks, 'where each paragraph begins').toEqual([0, 4])
    expect(collected.segments.map(({ start, end }) => [start, end])).toEqual([
      [0, 3],
      [4, 7],
    ])
  })

  /* AND NO SPACE INSIDE A WORD AN INLINE ELEMENT DIVIDES. `co<em>operate</em>`
     is two text nodes in one line of prose; a separator between them makes the
     voice say "co operate", and a block index for the second makes a paragraph
     step land in the middle of a word. */
  it('does not open a block for an inline element inside one', () => {
    const collected = collectText(
      bodyOf('<p>co<em>operate</em></p>', (el) => (el.tagName === 'EM' ? 'inline' : 'block')),
    )
    expect(collected.text).toBe('cooperate')
    expect(collected.blocks, 'one paragraph, one block').toEqual([0])
  })

  /* ⚠️ **AND TEXT THAT LAYS OUT INSIDE NO BLOCK AT ALL STILL BELONGS TO ONE.**
     `blockAncestor` answers null when every ancestor is inline, and `null !==
     null` is false — so without the first-node guard the section would have text
     in no paragraph, and every paragraph step in it would find nowhere to go. */
  it('records a first block for text with no block ancestor', () => {
    const collected = collectText(bodyOf('<span>Hello</span><span> there</span>', () => 'inline'))
    expect(collected.text).toBe('Hello there')
    expect(collected.blocks).toEqual([0])
  })

  /* A note marker is dropped WITH a gap, because it sits between words — and a
     gap in front of the first word is not a gap, it is an indent the voice reads
     as a pause and every offset after it carries. */
  it('leaves a gap where a note marker was, but not before the first word', () => {
    const between = collectText(bodyOf('<p>He left.<a epub:type="noteref">1</a>Then she stayed.</p>'))
    expect(between.text).toBe('He left. Then she stayed.')

    const leading = collectText(bodyOf('<p><a epub:type="noteref">1</a>Hello.</p>'))
    expect(leading.text).toBe('Hello.')
    expect(leading.blocks).toEqual([0])
  })
})

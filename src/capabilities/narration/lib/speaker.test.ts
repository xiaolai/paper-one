// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Speaker, speechAvailable, wordLengthAt } from './speaker'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'

/**
 * The Web Speech reading: `Speaker`, the word it reports, and whether there is
 * an engine to drive at all. Split from the kernel's `speech.test.ts` when the
 * reading moved into this capability; the walk it reads from, and the page
 * decision the follow-along makes, stayed with the kernel and are tested there.
 *
 * A DOM environment, declared on line 1, because `speechAvailable` asks the
 * window — and one case takes the window away to prove it answers no.
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
    const onWord = vi.fn()
    const onDone = vi.fn()
    const onNoBoundaries = vi.fn()
    const speaker = new Speaker(
      { onWord, onDone, onNoBoundaries },
      synth as unknown as SpeechSynthesis,
    )
    return { speaker, onWord, onDone, onNoBoundaries }
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

  describe('the reading volume', () => {
    it('sets the volume it was given', () => {
      const { speaker } = make()
      speaker.speak('hello', null, { volume: 0.4 })
      expect(synth.queued[0]?.volume).toBe(0.4)
    })

    it('sets 0 as 0, rather than taking it for nothing chosen', () => {
      const { speaker } = make()
      speaker.speak('hello', null, { volume: 0 })
      expect(synth.queued[0]?.volume).toBe(0)
    })

    it('sets the platform default of 1 where nothing was chosen', () => {
      const { speaker } = make()
      speaker.speak('hello', null)
      expect(synth.queued[0]?.volume).toBe(1)
    })

    it('reads the same at 0: the utterance still goes to the engine and still ends', () => {
      /* ⚠️ **NO "MUTED SO SKIP" BRANCH.** A reading depends on the utterance's
         own events for its pace, so 0 must queue one exactly as 1 does. */
      const { speaker, onDone } = make()
      expect(speaker.speak('hello', null, { volume: 0 })).toBe(true)
      expect(synth.queued).toHaveLength(1)
      synth.queued[0]?.dispatchEvent(new Event('end'))
      expect(onDone).toHaveBeenCalledWith('ended')
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

  describe('the word it reports', () => {
    const boundary = (index: number, fields: { charIndex: number; charLength?: number; name?: string }) =>
      synth.queued[index]?.dispatchEvent(Object.assign(new Event('boundary'), fields))

    /* A boundary is reported with the engine's length when that length is
       usable, and with the word's own span in the text when it is absent, zero
       or negative — an engine that reports `charLength: 0` must not draw an
       empty highlight. */
    it("uses the engine's length when it is positive, and the word's span otherwise", () => {
      const { speaker, onWord } = make()
      speaker.speak('Call me Ishmael', null)
      boundary(0, { charIndex: 8, charLength: 3, name: 'word' })
      boundary(0, { charIndex: 8, charLength: 0, name: 'word' })
      boundary(0, { charIndex: 8, charLength: -1, name: 'word' })
      boundary(0, { charIndex: 8, name: 'word' })
      expect(onWord.mock.calls).toEqual([[8, 3], [8, 7], [8, 7], [8, 7]])
    })

    /* Sentence boundaries share the event in some engines; the highlight is per
       word. An engine that names nothing is reporting words. */
    it('ignores a boundary named anything but a word, and takes one named nothing', () => {
      const { speaker, onWord } = make()
      speaker.speak('Call me Ishmael', null)
      boundary(0, { charIndex: 0, charLength: 15, name: 'sentence' })
      expect(onWord).not.toHaveBeenCalled()
      boundary(0, { charIndex: 5, charLength: 2 })
      expect(onWord.mock.calls).toEqual([[5, 2]])
    })

    /* A replaced utterance can still deliver a late boundary; reported, it
       would move the highlight to a word in text no longer being read. */
    it('reports nothing from an utterance a newer one replaced', () => {
      const { speaker, onWord } = make()
      speaker.speak('first sentence', null)
      speaker.speak('second', null)
      boundary(0, { charIndex: 0, charLength: 5, name: 'word' })
      expect(onWord).not.toHaveBeenCalled()
    })
  })

  /* A pause or resume issued in the wrong state is still a command on the one
     shared engine. Pausing an engine that is not speaking leaves it paused for
     whatever comes next; resuming one that is not paused re-arms a grace over
     no speech. */
  it('pauses only what is speaking, and resumes only what is paused', () => {
    const { speaker } = make()
    speaker.speak('first', null)
    synth.speaking = false
    speaker.pause()
    expect(synth.paused, 'nothing was speaking, so nothing was paused').toBe(false)

    speaker.resume()
    expect(synth.resumed, 'nothing was paused, so nothing was resumed').toBe(0)
  })

  /* `#finish` retires the generation FORWARD. Stepped back instead, the very
     next retirement — a `stop()` after the reading ended — hands the finished
     utterance its own number again, and its late duplicate (WebKit sends
     `error` and `end` for one utterance on some voices) reports a second end. */
  it('reports an utterance finished once, even when a stop comes between its two endings', () => {
    const { speaker, onDone } = make()
    speaker.speak('first', null)
    synth.queued[0]?.dispatchEvent(new Event('end'))
    speaker.stop()
    synth.queued[0]?.dispatchEvent(new Event('error'))
    expect(onDone.mock.calls).toEqual([['ended']])
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

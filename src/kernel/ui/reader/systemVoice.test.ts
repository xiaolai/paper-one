import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSystemVoice, systemVoice } from './systemVoice'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'

/**
 * The `Voice` port over the machine's own speech engine.
 *
 * ⚠️ **THIS IS THE KERNEL'S DEFAULT NOW, AND IT USED TO BE `NO_VOICE`** — so
 * every case here is about something that did not exist before: a reader with
 * no neural model, no runtime and no download hearing a looked-up word. It is
 * the only voice now — `core/voice.ts` says why the neural one was deleted.
 *
 * The engine is a `FakeSynth`, which is the SAME fake `Speaker`'s own suite
 * drives — deliberately, for the reason that testkit's header gives: two fakes
 * had begun to disagree about what `cancel` does, and that is the one behaviour
 * both suites turn on.
 *
 * `node`, not jsdom: nothing here touches a document. What it does touch is
 * `SpeechSynthesisUtterance`, which `Speaker` constructs, so the global is
 * stood in for exactly as the speaker's own suite stands it in.
 */
describe('the machine’s own voice', () => {
  let synth: FakeSynth
  const original = globalThis.SpeechSynthesisUtterance

  beforeEach(() => {
    synth = new FakeSynth()
    globalThis.SpeechSynthesisUtterance =
      FakeUtterance as unknown as typeof SpeechSynthesisUtterance
  })

  afterEach(() => {
    globalThis.SpeechSynthesisUtterance = original
  })

  const voiceOver = (over: FakeSynth = synth) =>
    createSystemVoice(over as unknown as SpeechSynthesis)

  describe('and whether it can say a word at all', () => {
    /*
     * ⚠️ **AN EMPTY VOICE LIST IS `UNKNOWN`, NOT `NO`.** `getVoices()` answers
     * `[]` until the engine has loaded its list and fired `voiceschanged`, so
     * reading emptiness as "no voices" removes the control for the first moments
     * of every session. A false positive costs one press; a false negative costs
     * the feature.
     */
    it('allows a press while the voice list has not loaded', () => {
      expect(voiceOver().canSay('zh-Hant')).toBe(true)
      expect(voiceOver().canSay(null)).toBe(true)
    })

    /*
     * ⚠️ **AND A POPULATED LIST IS AUTHORITATIVE, WHICH IS THE OTHER HALF.** An
     * English-only machine draws no control for a Chinese term: a word said in
     * a voice for the wrong language is a wrong answer the reader has no way to
     * check, which is the same objection `core/voice.ts` raises against invented
     * IPA. This is the absent-versus-unreadable rule applied to a voice list.
     */
    it('refuses a language the loaded list has no voice for', () => {
      synth.voices = [{ lang: 'en-GB' }, { lang: 'en-US' }]

      expect(voiceOver().canSay('zh-Hant')).toBe(false)
    })

    /*
     * THE PRIMARY SUBTAG, NOT THE WHOLE TAG. A region is an accent, not another
     * language: a `zh-CN` voice should say a word from a `zh-Hant` book rather
     * than nothing, and `en-GB` should serve an `en-US` book. What the subtag
     * does not do is cross languages, which is the whole point of the check.
     */
    it.each([
      ['a script variant', 'zh-CN', 'zh-Hant'],
      ['a region', 'en-GB', 'en-US'],
      ['a POSIX locale', 'zh-CN', 'zh_TW.UTF-8'],
      ['a bare subtag', 'fr', 'fr-CA'],
      ['case', 'PT-br', 'pt-PT'],
    ])('matches on the primary subtag, across %s', (_what, installed, wanted) => {
      synth.voices = [{ lang: installed }]

      expect(voiceOver().canSay(wanted)).toBe(true)
    })

    /* NOTHING DECLARED IS A REAL ANSWER, not a gap: `say` leaves the utterance's
       own `lang` unset and the platform uses the reader's default voice, so any
       voice at all will do. */
    it.each([[null], [''], ['   '], ['-']])(
      'serves a passage that declared no language (%s)',
      (lang) => {
        synth.voices = [{ lang: 'ja-JP' }]

        expect(voiceOver().canSay(lang)).toBe(true)
      },
    )

    /*
     * ⚠️ **AN ANSWER GIVEN AGAINST AN UNKNOWN LIST MUST CORRECT ITSELF.** The
     * optimistic yes above is only defensible because the engine says when its
     * list arrives — without this, a control allowed on an empty list stays
     * allowed for the whole session, in the wrong language.
     */
    it('tells its subscribers when the engine’s voice list arrives', () => {
      const voice = voiceOver()
      let told = 0
      voice.subscribe(() => void (told += 1))
      expect(voice.canSay('zh-Hant')).toBe(true)

      synth.voices = [{ lang: 'en-GB' }]
      synth.dispatchEvent(new Event('voiceschanged'))

      expect(told).toBe(1)
      expect(voice.canSay('zh-Hant')).toBe(false)
    })

    /* AND THE LISTENER GOES WITH THE LAST SUBSCRIBER. The engine outlives every
       popup that subscribed to it, so a listener left behind is one nobody
       reads. */
    it('stops listening to the engine once nothing is subscribed', () => {
      const voice = voiceOver()
      let told = 0
      const first = voice.subscribe(() => void (told += 1))
      const second = voice.subscribe(() => void (told += 1))

      first()
      synth.dispatchEvent(new Event('voiceschanged'))
      expect(told).toBe(1)

      second()
      synth.dispatchEvent(new Event('voiceschanged'))
      expect(told).toBe(1)
    })
  })

  describe('and saying a word', () => {
    it('hands the word and its language to the engine', () => {
      const voice = voiceOver()

      voice.say('漢字', 'zh-Hant')

      expect(synth.queued).toHaveLength(1)
      expect(synth.queued[0]?.text).toBe('漢字')
      expect(synth.queued[0]?.lang).toBe('zh-Hant')
      expect(voice.state()).toBe('speaking')
    })

    /* ⚠️ **UNSET, NOT `''`.** WebKit reads an empty `lang` on an utterance as a
       language it has no voice for, where unset leaves the reader's own default
       alone — `documentLang` records the measurement, and `Speaker` is what
       keeps it. Held here because this port is the one that receives a `null`
       from a passage that declared nothing. */
    it.each([[null], [undefined]])(
      'leaves the language unset when the passage declared none (%s)',
      (lang) => {
        voiceOver().say('gam', lang)

        expect(synth.queued[0]).not.toHaveProperty('lang')
      },
    )

    /* IT ENDS ON ITS OWN, and the port is a store precisely because nothing
       presses anything for that. */
    it('goes back to idle when the utterance ends', () => {
      const voice = voiceOver()
      let told = 0
      voice.subscribe(() => void (told += 1))
      voice.say('gam', null)
      told = 0

      synth.queued[0]?.dispatchEvent(new Event('end'))

      expect(voice.state()).toBe('idle')
      expect(told).toBe(1)
    })

    /* AND AN ENGINE THAT GIVES UP IS A FAILURE THE POPUP DRAWS — said, not
       swallowed: a press that made no sound and no sentence is
       indistinguishable from a broken button. */
    it('reports a failure when the engine gives up', () => {
      const voice = voiceOver()
      voice.say('gam', null)

      synth.queued[0]?.dispatchEvent(new Event('error'))

      expect(voice.state()).toBe('failed')
    })

    /*
     * ⚠️ **AND `taken` IS NOT A FAILURE.** The reading uses the same single
     * engine, so a reader who presses Listen while a word is being pronounced
     * cancels this utterance — and drawing "Paper couldn't say that aloud" for
     * something the reader just asked for would be the app blaming itself for
     * obeying. `DoneReason.taken` is what separates the two.
     */
    it('is simply idle when something else takes the engine', () => {
      const voice = voiceOver()
      voice.say('gam', null)
      const mine = synth.queued[0]

      /* Another `Speaker` over the same engine, which is what the reading is. */
      const reading = createSystemVoice(synth as unknown as SpeechSynthesis)
      reading.say('a whole chapter', 'en')
      mine?.dispatchEvent(new Event('end'))

      expect(voice.state()).toBe('idle')
    })

    /* NOTHING TO SAY IT WITH IS NOT A FAILURE — and a throw here would be a
       crash inside a control nobody can see. */
    it('says nothing, and does not throw, where there is no engine', () => {
      const none = createSystemVoice(undefined)

      expect(none.canSay(null)).toBe(false)
      expect(() => none.say('gam', 'en')).not.toThrow()
      expect(() => none.stop()).not.toThrow()
      expect(none.state()).toBe('idle')
    })

    /* A press with nothing in it settles SYNCHRONOUSLY, and the state must be
       the done rather than the `speaking` written just before it — `Speaker`'s
       own note, and the bug it names is a control saying Stop over silence. */
    it('does not claim to be speaking an empty term', () => {
      const voice = voiceOver()

      voice.say('   ', null)

      expect(voice.state()).toBe('idle')
      expect(synth.queued).toHaveLength(0)
    })

    /* STOP CLEARS A FAILURE TOO, which is what stops one press's failure being
       drawn over the NEXT word the reader looks up — the popup stops the voice
       as it goes away. */
    it('clears a failure when it is stopped', () => {
      const voice = voiceOver()
      voice.say('gam', null)
      synth.queued[0]?.dispatchEvent(new Event('error'))
      expect(voice.state()).toBe('failed')

      voice.stop()

      expect(voice.state()).toBe('idle')
      expect(synth.cancelled).toBeGreaterThan(0)
    })
  })

  /*
   * ⚠️ **ONE ENGINE, SO ONE VOICE OVER IT.** `window.speechSynthesis` serves one
   * utterance at a time, so two `Voice` objects over it would each believe they
   * owned what the other was saying — and each one's `say` would silently cancel
   * the other's. The shared instance is also what lets `inference` take the port
   * already in the slot as its fallback rather than building a second.
   */
  it('is one shared instance', () => {
    expect(systemVoice()).toBe(systemVoice())
  })

  /* AND ON A MACHINE WITH NO ENGINE IT IS HONEST ABOUT IT — which is every
     suite in this repository, all of which build the kernel's services and so
     construct this. It must be free to exist where it cannot speak. */
  it('answers no on a build with no speech engine, without having been asked to speak', () => {
    expect(systemVoice().canSay(null)).toBe(false)
    expect(systemVoice().state()).toBe('idle')
  })
})

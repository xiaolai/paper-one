/**
 * Reading aloud on a downloaded voice, to the same contract as `Speaker`.
 *
 * `useSpeech` drives one or the other and is not told which: same four methods,
 * same three callbacks, same promises about when each fires. What differs is
 * everything underneath — there is no platform engine here, only a render that
 * takes seconds and a buffer that has to be played.
 *
 * # What this has to get right that Web Speech does for you
 *
 * ⚠️ **A RENDER IS SLOW AND ITS ANSWER ARRIVES AFTER THE READER HAS MOVED ON.**
 * Web Speech starts speaking within a couple of hundred milliseconds; an engine
 * render is seconds, and a reader who presses stop, turns a page or picks
 * another voice in that window gets the old sentence played over the new one
 * unless every answer is checked against the generation that asked for it. This
 * is `Speaker`'s late-`end` problem moved earlier in the story, and it is why
 * `#generation` is the first thing every continuation reads.
 *
 * ⚠️ **AN ENGINE THAT REPORTS NO WORDS SAYS SO, AND DRAWS NOTHING.** Kokoro
 * answers word timings; Qwen answers none, and this reports `onNoBoundaries`
 * once, exactly as `Speaker` does for a platform voice that cannot say.
 *
 * ⚠️ **THIS PARAGRAPH PROMISED A SENTENCE HIGHLIGHT UNTIL 2026-09-23, AND THE
 * CODE UNDER IT DID THE OPPOSITE.** It called `onWord(0, text.length)` and
 * then `onNoBoundaries()`, and `useSpeech` answers that second callback by
 * REMOVING the band and refusing every later `onWord` — so the highlight was
 * drawn and revoked in one tick and nothing was ever shown. The band's
 * geometry is a word's: `placeSpokenWord` takes one box, so a sentence over
 * two lines would draw a rectangle across both and cover the text between
 * them. Saying nothing finer is coming is the honest answer until there is a
 * band shaped like a sentence. Found by an audit, not by a test — the unit
 * test asserted both callbacks and never traced what the pair does together.
 */

import { playPcm, type AudioHost, type Playing } from './enginePlayer'
import type { EngineVoice } from './engineVoice'
import { audible } from './pcm'
import type { DoneReason, SpeakPrefs, SpeakerCallbacks } from './speech'
import type { SpeechRequest, SpokenAudio } from '../../core/ports'

/** A reading in progress: the sound, its words, and how many have been said. */
interface Reading {
  readonly playing: Playing
  readonly words: SpokenAudio['words']
  said: number
}

/** Which pack and voice read a given language, or nothing if none can. */
export type VoiceChoosing = (lang: string | null, prefs: SpeakPrefs) => { packId: string; voiceId: string } | null

/** What the speaker needs from outside. */
export interface EngineSpeakerDeps {
  /** Render a passage. The port's, or a fake. */
  render: (request: SpeechRequest) => Promise<SpokenAudio>
  /** Somewhere to play it. Made lazily, because a context costs a device. */
  host: () => AudioHost | null
  /** Which voice reads this language. */
  choose: VoiceChoosing
}

/**
 * How long a render may take before the reading gives up on it.
 *
 * Generous, because a first render loads a model: the Chinese pack takes about
 * five seconds to load and a few more for a long sentence. What this bounds is
 * a render that never answers at all, which would otherwise leave the Listen
 * control lit for ever with nothing coming.
 */
export const RENDER_TIMEOUT_MS = 120_000

export class EngineSpeaker {
  #cb: SpeakerCallbacks
  #deps: EngineSpeakerDeps
  /**
   * Which utterance is current. Every async continuation checks it.
   *
   * ⚠️ **AN IDENTITY, NOT A COUNTER.** It was a number, incremented on every
   * `speak`, `stop` and ending — and whether two of those steps could ever
   * bring it back to a value some continuation still held was an argument
   * rather than a fact. A fresh object cannot collide with anything, ever, so
   * the question does not arise; it also leaves no arithmetic for a mutation
   * to change without changing the answer.
   */
  #current: object = {}
  /**
   * The reading in progress: the sound, the words it is made of, and how many
   * of them have been reported.
   *
   * ⚠️ **ONE VALUE, WHERE THERE WERE THREE.** A `#playing`, a `#words` and a
   * `#said` were cleared separately on each of the two roads out, and only the
   * first of the three decided anything — so the other two were assignments no
   * test could tell from not making them. They belong to one reading and they
   * go together.
   *
   * ⚠️ **`said` IS A COUNT, NOT A COMPARISON AGAINST THE CLOCK.** The rebuild
   * after a pause first skipped every word at or before the player's position,
   * which assumes such a word was already reported — and one at `startMs` 0, on
   * a render held at its first sample by a pause that arrived before it landed,
   * never had been. It was dropped silently. Counting what was said leaves
   * nothing to assume.
   */
  #reading: Reading | null = null
  /**
   * The word timers in flight.
   *
   * ⚠️ **NEVER REPLACED, ONLY EMPTIED.** Assigning a fresh `[]` on each clear
   * carried a mutant nothing could kill: the list's only reader hands each
   * entry to `clearTimeout`, which ignores a value that is not a handle, so an
   * emptiness no code reads is an emptiness no test can assert.
   */
  // Stryker disable next-line ArrayDeclaration: the list's only reader hands each entry to clearTimeout, which ignores anything that is not a handle — so what is in it at the start cannot be observed.
  readonly #timers: ReturnType<typeof setTimeout>[] = []
  #reportedNoBoundaries = false
  /**
   * Paused, whether or not there is anything playing YET.
   *
   * ⚠️ **`pause()` WAS `this.#playing?.pause()` AND A RENDER IS NOT A PLAYER.**
   * Between `speak` and the first sample there is no player at all — 450 ms for
   * English and about five seconds for Chinese, longer on the first sentence
   * because that loads the model — so a reader who pressed Pause in that window
   * was not heard, the render landed, and the voice began speaking while the
   * control said paused. The flag is what a pause means; the player is only
   * where it lands once there is one.
   */
  /* Stryker disable next-line BooleanLiteral: nothing reads this before it has
     been written. `speak` calls `stop` first and `stop` sets it false, and the
     only other reader — `resume` — answers the same way on a speaker with no
     reading either way. Hand-applied 2026-09-24: the whole suite passes with
     `true` here, which is what an unobservable initial value looks like. */
  #paused = false
  /** A render done ahead of time, by `prepare`. */
  #ready: { key: string; audio: SpokenAudio } | null = null
  /**
   * The look-ahead still in flight, if there is one.
   *
   * ⚠️ **THE PROMISE, NOT JUST ITS KEY.** It was a key alone, so `speak` could
   * only reuse a render that had FINISHED — and the moment `useSpeech` began
   * asking for the look-ahead, a sentence whose render outlived the one before
   * it was rendered twice. The engine serialises renders, so that is slower
   * than not preparing at all: the second request waits behind the first for
   * the same audio.
   */
  #preparing: { key: string; work: Promise<SpokenAudio> } | null = null

  constructor(callbacks: SpeakerCallbacks, deps: EngineSpeakerDeps) {
    this.#cb = callbacks
    this.#deps = deps
  }

  /**
   * Read a passage. Answers whether a reading began — `false` means it did not
   * and `onDone` has ALREADY been called with the reason, which is the same
   * promise `Speaker.speak` makes.
   */
  speak(text: string, lang: string | null, prefs: SpeakPrefs = {}): boolean {
    this.stop()
    const token = (this.#current = {})
    if (!text.trim()) {
      this.#cb.onDone('empty')
      return false
    }
    const voice = this.#deps.choose(lang, prefs)
    if (!voice) {
      /* The same answer `Speaker` gives when the floor refuses every voice:
       * no voice rather than a bad one. Here it means no pack for this
       * language is installed. */
      this.#cb.onDone('no-voice')
      return false
    }
    const request = requestFor(voice, text, prefs)
    const rendering = this.#renderOrJoin(request)

    void rendering
      .then(
        (audio) => this.#play(token, audio),
        (cause: unknown) => this.#ended(token, 'error', cause),
      )
      /* ⚠️ **A HANDLER PASSED TO `then` DOES NOT CATCH THE OTHER HANDLER'S
       * THROW.** `#play` builds an audio buffer and a source node, and a host
       * that refuses either throws from inside the fulfilled branch — where
       * the rejection handler beside it cannot see it. The reading then sat
       * lit for ever with an unhandled rejection in the console and no
       * `onDone` anywhere. */
      .catch((cause: unknown) => this.#ended(token, 'error', cause))
    return true
  }

  /**
   * Render the next passage while this one is being read, so the gap between
   * them is a gap and not a wait.
   *
   * Does nothing on a speaker that has no engine behind it — `Speaker` has no
   * such method and `useSpeech` calls it optionally, so an engine that cannot
   * render ahead simply does not.
   */
  prepare(text: string, lang: string | null, prefs: SpeakPrefs = {}): void {
    if (!text.trim()) return
    const voice = this.#deps.choose(lang, prefs)
    if (!voice) return
    const request = requestFor(voice, text, prefs)
    const key = keyOf(request)
    /* Already have it, or already asking for it. Rendering the same sentence
     * twice costs the whole of a render and loads the machine the reader is
     * listening on. */
    if (this.#ready?.key === key || this.#preparing?.key === key) return
    const work = this.#render(request)
    this.#preparing = { key, work }
    void work.then(
      (audio) => {
        /* Only if this is still the look-ahead in flight. A `speak` for the
         * same sentence takes the promise over, and a `prepare` for a later
         * one replaces it — in both cases this render has an owner already,
         * and storing it as ready would hand it out a second time. */
        if (this.#preparing?.key === key) {
          this.#preparing = null
          this.#ready = { key, audio }
        }
      },
      () => {
        /* A failed look-ahead is not an error the reader hears about: the
         * sentence has not been asked for yet, and `speak` will render it
         * again and report properly if it fails then. */
        if (this.#preparing?.key === key) this.#preparing = null
      },
    )
  }

  pause(): void {
    this.#paused = true
    this.#reading?.playing.pause()
    /* ⚠️ **THE WORD TIMERS ARE THE OTHER HALF, AND THEY RAN ON.** They were
     * scheduled once, at `word.startMs` from the moment the audio started, so a
     * pause stopped the SOUND and left the highlight walking through the
     * sentence — and off the page, which turns it. Cleared here and rebuilt on
     * resume against the player's own position, which is also what makes them
     * right at a speed other than 1. */
    this.#clearTimers()
  }

  resume(): void {
    if (!this.#paused) return
    this.#paused = false
    const reading = this.#reading
    if (!reading) return
    reading.playing.resume()
    /* Against the PLAYER's position rather than the wall clock, so a pause of
     * any length lands the next word where the sound does — and so does a
     * reading at a speed other than 1, which `positionMs` already accounts for
     * and a wall clock never could. From the first word NOT YET SAID, so
     * nothing is repeated and nothing is skipped. */
    this.#scheduleFrom(reading, reading.said, reading.playing.positionMs())
  }

  /** End the reading. `onDone` is NOT called: the caller already knows. */
  stop(): void {
    /* The token moves FIRST, so a render already in flight cannot play when it
     * lands. Stopping the player alone would leave that render to start a
     * sound nobody asked for, seconds later. */
    this.#current = {}
    this.#paused = false
    this.#clearTimers()
    this.#reading?.playing.stop()
    this.#reading = null
  }

  /**
   * The render for this request: the one already done, the one already in
   * flight, or a fresh one.
   *
   * ⚠️ **THE IN-FLIGHT CASE IS THE WHOLE POINT.** Reusing only a FINISHED
   * look-ahead means a sentence whose render outlives the sentence before it
   * is rendered twice — and the engine serialises renders, so the second
   * request waits behind the first for the same audio. Preparing would then be
   * slower than not preparing, which is the opposite of what it is for.
   */
  #renderOrJoin(request: SpeechRequest): Promise<SpokenAudio> {
    const key = keyOf(request)
    if (this.#ready?.key === key) {
      const audio = this.#ready.audio
      this.#ready = null
      return Promise.resolve(audio)
    }
    const preparing = this.#preparing
    if (preparing?.key === key) {
      this.#preparing = null
      return preparing.work
    }
    return this.#render(request)
  }

  async #render(request: SpeechRequest): Promise<SpokenAudio> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the voice did not answer')), RENDER_TIMEOUT_MS)
    })
    try {
      return await Promise.race([this.#deps.render(request), limit])
    } finally {
      /* No `timer !== undefined` in front of this: the executor above runs
         synchronously, so by here it always has one — and `clearTimeout` takes
         `undefined` without complaint anyway. Left unclear, a two-minute timer
         outlives every sentence that renders normally. */
      clearTimeout(timer)
    }
  }

  /** Play a render, if it is still the one the reader is waiting for. */
  #play(token: object, audio: SpokenAudio): void {
    if (token !== this.#current) return
    const host = this.#deps.host()
    if (!host) {
      /* No cause: a build with nowhere to play is not a render that failed,
         and a line about one would be a line nobody can act on. */
      this.#ended(token, 'error')
      return
    }
    /* ⚠️ SILENCE OF THE RIGHT LENGTH IS THE FAILURE NOBODY HEARS UNTIL THEY
     * PLAY IT. The engines refuse an empty render on their side; this is the
     * other end of the wire, where a transfer that dropped its payload
     * arrives with correct-looking timings. Reported as an error rather than
     * played, so the reader is told instead of sitting through nothing. */
    if (!audible(audio.pcm)) {
      this.#ended(token, 'error')
      return
    }

    const playing = playPcm(host, audio.pcm, audio.sampleRate, () => {
      this.#ended(token, 'ended')
    })
    this.#reading = { playing, words: audio.words, said: 0 }
    /* ⚠️ **A RENDER THAT LANDS DURING A PAUSE MUST NOT SPEAK.** The reader
     * pressed Pause while this was still rendering; there was no player then to
     * take it, and there is one now. Paused at its first sample rather than
     * never started, so `resume` is the ordinary path and not a special case. */
    if (this.#paused) {
      playing.pause()
      /* No timers either — `resume` builds them from the player's position.
         The engine still has to say it reports no words, though: a reader who
         paused during the very first render would otherwise be left with a
         band that never arrives and nothing saying it is not coming. */
      if (audio.words.length === 0) this.#noWordBoundaries()
      return
    }
    if (audio.words.length === 0) {
      this.#noWordBoundaries()
      return
    }
    this.#scheduleFrom(this.#reading, 0, 0)
  }

  /**
   * Fire `onWord` for each word from `first` onwards, offset by where the
   * audio has got to.
   *
   * The timings are known before a sound is made, so these are SCHEDULED
   * rather than polled: a timer per word costs nothing and lands where the
   * engine said the word does, while polling lands wherever the frame did.
   *
   * One routine for the first schedule and for every rebuild after a pause, so
   * the two cannot report a different set.
   *
   * ⚠️ **NO STALENESS CHECK INSIDE THE TIMER, AND THAT IS THE INVARIANT RATHER
   * THAN AN OVERSIGHT.** Every road that ends or interrupts a reading —
   * `pause`, `stop`, `#endIfCurrent` — clears these timers before anything
   * else can happen, so a timer that fires belongs to the reading that
   * scheduled it. A check as well would be a branch no test could reach; the
   * cases below prove the clearing instead, one per road, which is what fails
   * loudly if a fourth road forgets.
   */
  #scheduleFrom(reading: Reading, first: number, positionMs: number): void {
    for (let index = first; index < reading.words.length; index += 1) {
      const word = reading.words[index]!
      const at = setTimeout(() => {
        reading.said = index + 1
        this.#cb.onWord(word.start, word.length)
      }, Math.max(0, word.startMs - positionMs))
      this.#timers.push(at)
    }
  }

  /**
   * Say, once, that this engine reports no word boundaries — Qwen.
   *
   * ⚠️ **IT USED TO HIGHLIGHT THE SENTENCE AND THEN REVOKE IT IN THE SAME
   * TICK.** The code called `onWord(0, text.length)` and then
   * `onNoBoundaries()`, under a comment saying the sentence *"is highlighted
   * whole rather than not at all"*. Read through the integration, that is the
   * opposite of what happens: `useSpeech`'s `onNoBoundaries` REMOVES the
   * spoken-word band and sets `followsWords` false, so the band this drew was
   * wiped immediately and every later one was ignored. Nothing was highlighted
   * at all, and the comment said otherwise. Found by the 2026-09-23 audit.
   *
   * ⚠️ **AND THE SENTENCE BAND IS NOT REINSTATED, DELIBERATELY.** The band's
   * geometry is a WORD's — `placeSpokenWord` takes one box — so a sentence
   * running over two lines would draw a rectangle across both, covering the
   * text between them. Telling the reading that nothing finer is coming is the
   * honest answer until there is a band shaped like a sentence.
   */
  #noWordBoundaries(): void {
    if (this.#reportedNoBoundaries) return
    this.#reportedNoBoundaries = true
    this.#cb.onNoBoundaries()
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.length = 0
  }

  /**
   * Report an ending, once, and only for the utterance that is current.
   *
   * ⚠️ **ONE GUARD, AND IT IS THIS ONE.** A `#failed` beside it checked the
   * token too and then came straight here to have it checked again — so
   * whichever of the two ran second could never answer, and a branch that
   * cannot come back false is a branch no test can reach. Every road out of a
   * reading passes through here, and `stop()` below is what it does: the token
   * moves first, so a render still in flight cannot report a second time.
   *
   * ⚠️ **AND THE REASON IS SAID, WHERE IT USED TO BE DROPPED.**
   * `onDone('error')` is all the reading needs, and it is all the READER gets
   * — so the two-minute deadline's own words, and whatever the plugin refused
   * with, reached nobody at all. A chapter that stops part way with no reason
   * anywhere is the shape this repository keeps having to debug from outside.
   */
  #ended(token: object, reason: DoneReason, cause?: unknown): void {
    if (token !== this.#current) return
    if (cause !== undefined) console.error('Paper: the reading could not be rendered', cause)
    this.stop()
    this.#cb.onDone(reason)
  }
}

/**
 * The request for a passage, built once for both roads to it.
 *
 * ⚠️ **`speak` AND `prepare` EACH BUILT THEIR OWN, INCLUDING THE OPTIONAL
 * RATE.** Two spellings of one request is two spellings of `keyOf`'s input, and
 * the failure is silent: a prepared render whose key differs from the spoken
 * one is simply never reused, so the look-ahead costs a whole render and saves
 * nothing, with everything looking right.
 */
function requestFor(voice: EngineVoice, text: string, prefs: SpeakPrefs): SpeechRequest {
  return {
    packId: voice.packId,
    voiceId: voice.voiceId,
    text,
    ...(prefs.rate === undefined ? {} : { rate: prefs.rate }),
  }
}

/** What makes two render requests the same request. */
function keyOf(request: SpeechRequest): string {
  return `${request.packId}\u0000${request.voiceId}\u0000${request.rate ?? 1}\u0000${request.text}`
}

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
 * ⚠️ **AND AN ENGINE THAT REPORTS NO WORDS MUST NOT LOSE THE HIGHLIGHT.**
 * Kokoro answers word timings; Qwen answers none. `Speaker` reports
 * `onNoBoundaries` and the reading drops the follow-along entirely, which is
 * right for a platform voice that simply cannot say. Here the sentence IS
 * known — it is what was asked for — so the honest unit is the sentence, and
 * `onWord(0, text.length)` is how that is said without inventing a second
 * callback the other speaker would never call.
 */

import { playPcm, type AudioHost, type Playing } from './enginePlayer'
import type { EngineVoice } from './engineVoice'
import { audible } from './pcm'
import type { DoneReason, SpeakPrefs, SpeakerCallbacks } from './speech'
import type { SpeechRequest, SpokenAudio } from '../../core/ports'

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
  /** Which utterance is current. Every async continuation checks it. */
  #generation = 0
  #playing: Playing | null = null
  #timers: ReturnType<typeof setTimeout>[] = []
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
  #paused = false
  /** The words of the passage being read, for rescheduling across a pause. */
  #words: SpokenAudio['words'] = []
  /** A render done ahead of time, by `prepare`. */
  #ready: { key: string; audio: SpokenAudio } | null = null
  #preparing: string | null = null

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
    const generation = ++this.#generation
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
    const prepared = this.#takePrepared(keyOf(request))
    const rendering = prepared ? Promise.resolve(prepared) : this.#render(request)

    void rendering
      .then(
        (audio) => this.#play(generation, audio),
        () => this.#endIfCurrent(generation, 'error'),
      )
      /* ⚠️ **A HANDLER PASSED TO `then` DOES NOT CATCH THE OTHER HANDLER'S
       * THROW.** `#play` builds an audio buffer and a source node, and a host
       * that refuses either throws from inside the fulfilled branch — where
       * the rejection handler beside it cannot see it. The reading then sat
       * lit for ever with an unhandled rejection in the console and no
       * `onDone` anywhere. */
      .catch(() => this.#endIfCurrent(generation, 'error'))
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
    if (this.#ready?.key === key || this.#preparing === key) return
    this.#preparing = key
    void this.#render(request).then(
      (audio) => {
        if (this.#preparing === key) {
          this.#preparing = null
          this.#ready = { key, audio }
        }
      },
      () => {
        /* A failed look-ahead is not an error the reader hears about: the
         * sentence has not been asked for yet, and `speak` will render it
         * again and report properly if it fails then. */
        if (this.#preparing === key) this.#preparing = null
      },
    )
  }

  pause(): void {
    this.#paused = true
    this.#playing?.pause()
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
    const playing = this.#playing
    if (!playing) return
    playing.resume()
    this.#scheduleRemainingWords(this.#generation, playing)
  }

  /** End the reading. `onDone` is NOT called: the caller already knows. */
  stop(): void {
    /* The generation moves FIRST, so a render already in flight cannot play
     * when it lands. Stopping the player alone would leave that render to
     * start a sound nobody asked for, seconds later. */
    this.#generation += 1
    this.#paused = false
    this.#words = []
    this.#clearTimers()
    this.#playing?.stop()
    this.#playing = null
  }

  /** Take a prepared render if it is the one being asked for. */
  #takePrepared(key: string): SpokenAudio | null {
    if (this.#ready?.key !== key) return null
    const audio = this.#ready.audio
    this.#ready = null
    return audio
  }

  async #render(request: SpeechRequest): Promise<SpokenAudio> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the voice did not answer')), RENDER_TIMEOUT_MS)
    })
    try {
      return await Promise.race([this.#deps.render(request), limit])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Play a render, if it is still the one the reader is waiting for. */
  #play(generation: number, audio: SpokenAudio): void {
    if (generation !== this.#generation) return
    const host = this.#deps.host()
    if (!host) {
      this.#endIfCurrent(generation, 'error')
      return
    }
    /* ⚠️ SILENCE OF THE RIGHT LENGTH IS THE FAILURE NOBODY HEARS UNTIL THEY
     * PLAY IT. The engines refuse an empty render on their side; this is the
     * other end of the wire, where a transfer that dropped its payload
     * arrives with correct-looking timings. Reported as an error rather than
     * played, so the reader is told instead of sitting through nothing. */
    if (!audible(audio.pcm)) {
      this.#endIfCurrent(generation, 'error')
      return
    }

    const playing = playPcm(host, audio.pcm, audio.sampleRate, () => {
      this.#endIfCurrent(generation, 'ended')
    })
    this.#playing = playing
    this.#words = audio.words
    /* ⚠️ **A RENDER THAT LANDS DURING A PAUSE MUST NOT SPEAK.** The reader
     * pressed Pause while this was still rendering; there was no player then to
     * take it, and there is one now. Paused at its first sample rather than
     * never started, so `resume` is the ordinary path and not a special case. */
    if (this.#paused) {
      playing.pause()
      /* No timers either — `resume` builds them from the player's position. */
      if (audio.words.length === 0) this.#noWordBoundaries()
      return
    }
    this.#scheduleWords(generation, audio)
  }

  /**
   * Fire `onWord` for each word at the moment it is spoken.
   *
   * The timings are known before a sound is made, so these are SCHEDULED
   * rather than polled: a timer per word costs nothing and lands where the
   * engine said the word does, while polling lands wherever the frame did.
   */
  #scheduleWords(generation: number, audio: SpokenAudio): void {
    if (audio.words.length === 0) {
      this.#noWordBoundaries()
      return
    }
    for (const word of audio.words) {
      const at = setTimeout(() => {
        if (generation !== this.#generation) return
        this.#cb.onWord(word.start, word.length)
      }, word.startMs)
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

  /**
   * Rebuild the word timers from where the audio actually is.
   *
   * Against the PLAYER's position rather than the wall clock, so a pause of
   * any length lands the next word where the sound does — and so does a
   * reading at a speed other than 1, which `positionMs` already accounts for
   * and a wall clock never could.
   */
  #scheduleRemainingWords(generation: number, playing: Playing): void {
    const at = playing.positionMs()
    for (const word of this.#words) {
      if (word.startMs <= at) continue
      const timer = setTimeout(() => {
        if (generation !== this.#generation) return
        this.#cb.onWord(word.start, word.length)
      }, word.startMs - at)
      this.#timers.push(timer)
    }
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers = []
  }

  /** Report an ending, once, and only for the utterance that is current. */
  #endIfCurrent(generation: number, reason: DoneReason): void {
    if (generation !== this.#generation) return
    /* Moved on before reporting, so a second ending — a late `onended` beside
     * a timeout, say — cannot report twice. `Speaker` does the same thing for
     * the same reason. */
    this.#generation += 1
    this.#paused = false
    this.#words = []
    this.#clearTimers()
    this.#playing = null
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

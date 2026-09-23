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

    const request: SpeechRequest = {
      packId: voice.packId,
      voiceId: voice.voiceId,
      text,
      ...(prefs.rate === undefined ? {} : { rate: prefs.rate }),
    }
    const prepared = this.#takePrepared(keyOf(request))
    const rendering = prepared ? Promise.resolve(prepared) : this.#render(request)

    void rendering.then(
      (audio) => this.#play(generation, text, audio),
      () => this.#endIfCurrent(generation, 'error'),
    )
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
    const request: SpeechRequest = {
      packId: voice.packId,
      voiceId: voice.voiceId,
      text,
      ...(prefs.rate === undefined ? {} : { rate: prefs.rate }),
    }
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
    this.#playing?.pause()
  }

  resume(): void {
    this.#playing?.resume()
  }

  /** End the reading. `onDone` is NOT called: the caller already knows. */
  stop(): void {
    /* The generation moves FIRST, so a render already in flight cannot play
     * when it lands. Stopping the player alone would leave that render to
     * start a sound nobody asked for, seconds later. */
    this.#generation += 1
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
  #play(generation: number, text: string, audio: SpokenAudio): void {
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

    this.#playing = playPcm(host, audio.pcm, audio.sampleRate, () => {
      this.#endIfCurrent(generation, 'ended')
    })
    this.#scheduleWords(generation, text, audio)
  }

  /**
   * Fire `onWord` for each word at the moment it is spoken.
   *
   * The timings are known before a sound is made, so these are SCHEDULED
   * rather than polled: a timer per word costs nothing and lands where the
   * engine said the word does, while polling lands wherever the frame did.
   */
  #scheduleWords(generation: number, text: string, audio: SpokenAudio): void {
    if (audio.words.length === 0) {
      /* An engine with no word timings — Qwen. The SENTENCE is still known, so
       * it is highlighted whole rather than not at all; `onNoBoundaries` is
       * what tells the reading that nothing finer is coming. */
      this.#cb.onWord(0, text.length)
      if (!this.#reportedNoBoundaries) {
        this.#reportedNoBoundaries = true
        this.#cb.onNoBoundaries()
      }
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
    this.#clearTimers()
    this.#playing = null
    this.#cb.onDone(reason)
  }
}

/** What makes two render requests the same request. */
function keyOf(request: SpeechRequest): string {
  return `${request.packId}\u0000${request.voiceId}\u0000${request.rate ?? 1}\u0000${request.text}`
}

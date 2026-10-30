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
 * # WI-34.2: THIS IS A PLAYER NOW, AND THE SCHEDULER HAS GONE
 *
 * It used to be handed one SENTENCE at a time, with a look-ahead (`prepare`), a
 * prepared-render cache (`#ready`), an in-flight join (`#preparing`) and a
 * `keyOf` that matched the three together. All of that is deleted. A section is
 * rendered ONCE — WI-34.0 measured 315 s for a real 48-minute one — kept on
 * disk by `tauri-plugin-voices`'s clip store, and played as **one buffer with one
 * `words` array**.
 *
 * ⚠️ **THE OWNER REFUSED RENDER-AHEAD ON 2026-09-30, WITH THE NUMBERS IN
 * HAND.** Offered a smaller unit with a look-ahead, the choice was the whole
 * section and no look-ahead — the bar knowingly missed rather than the machinery
 * kept in a smaller place. So there is nothing here that renders anything the
 * reader has not asked for, and `prepare` is not to come back: the store is the
 * cache, and a cache with a second cache in front of it is what needed `keyOf`.
 *
 * What that buys is SEEKING, which is the reason for all of it. One buffer and
 * one `words` array make a seek a search in an array rather than a position in a
 * stream — see [`EngineSpeaker.seekToMs`] and [`EngineSpeaker.seekToOffset`].
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
import type { ClipKey, SpeechRequest, SpokenAudio } from '../../core/ports'

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
  /**
   * Which section is being read — see `SpeechRequest.clip`.
   *
   * ⚠️ **A FUNCTION READ AT `speak` TIME, NOT AN ARGUMENT TO `speak`.**
   * `SpeakerLike.speak` is shared with the platform speaker, which has no use
   * for a clip key at all, and a parameter one implementer drops on the floor is
   * the shape `SpeechEnginePort.render`'s `AbortSignal` had — declared, never
   * honoured, TypeScript silent. A dep is also what makes the key impossible to
   * get stale: `useSpeech` derives it from the same value the text comes from, so
   * the two cannot disagree about which section this is.
   */
  clip: () => ClipKey
}

/**
 * How long the MODEL may take to load before a render has begun at all.
 *
 * The Chinese pack takes about five seconds cold and holds 8.9 GB while it
 * works; 120 s is the generosity that was here before and it is unchanged. What
 * is new is that it is now a FLOOR rather than the whole deadline.
 */
export const RENDER_FLOOR_MS = 120_000

/**
 * How much longer a render is given per character of the passage.
 *
 * ⚠️ **A FLAT 120 s DEADLINE KILLED EVERY REAL SECTION, AND THE CLIP LANDED
 * ANYWAY — MEASURED IN THE RUNNING APP, 2026-09-30.** Section 8 of a real book
 * rendered **74.8 minutes of audio in about 7 minutes**, and the reading gave up
 * at two with *"the voice did not answer"* — while the render completed, was
 * checkpointed, and 205 MB of correct audio sat on disk that nothing would play.
 * The old bound was sized for a SENTENCE, and its own comment said so; phase 34
 * hands the engine a whole section.
 *
 * **60 ms per character, derived from the measurements rather than guessed:**
 *
 * | measured | render-seconds per character |
 * |---|---|
 * | Kokoro, mbp16 idle (WI-34.0) | 0.0066 |
 * | Kokoro, M5 under load average 47–73 | ~0.030 |
 * | Qwen, warm | ~0.065 |
 * | Qwen, cold including the model load | ~0.233 |
 *
 * So 0.060 is nine times the fastest and roughly the Qwen-warm rate. On the
 * character-weighted median section of this shelf — 48 043 characters — that is
 * 120 s + 48 min against a measured 5 min 15 s: a margin of about seven. At the
 * p99 section it is 2.4 hours against a measured ~15 min.
 *
 * ⚠️ **IT IS A BACKSTOP AGAINST A RENDER THAT NEVER ANSWERS, NOT A PERFORMANCE
 * BOUND — AND THAT DISTINCTION IS WHY IT IS THIS LOOSE.** The failure it exists
 * to prevent is the Listen control lit for ever over silence. The failure it
 * caused was worse: a correct render discarded and the reader told it had
 * failed. Where the two trade off, a deadline that is too loose costs a wait the
 * reader can stop; one that is too tight costs the chapter.
 */
export const RENDER_PER_CHAR_MS = 60

/**
 * How long this passage's render may take.
 *
 * ⚠️ **BOUNDED ABOVE AS WELL, BECAUSE `Number.MAX_SAFE_INTEGER` MILLISECONDS IS
 * NOT A TIMER.** `setTimeout` clamps a delay past 2 147 483 647 ms to ZERO — a
 * deadline of 25 days fires immediately — so a `MAX_SECTION_CHARS`-sized passage
 * (2 000 000 characters, 33 hours by the rate above) would have refused every
 * render on the first tick. The cap is a day, which is longer than any section
 * this shelf holds and safely inside what a timer can express.
 */
export function deadlineFor(text: string): number {
  const scaled = RENDER_FLOOR_MS + text.length * RENDER_PER_CHAR_MS
  return Math.min(scaled, MAX_DEADLINE_MS)
}

/** A day. See {@link deadlineFor} for why there is a ceiling at all. */
export const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000

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
    const request = requestFor(voice, text, this.#deps.clip(), prefs)
    const rendering = this.#render(request)

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
    /* ⚠️ **`resume()` CAN END THE READING BEFORE IT RETURNS — FOUND BY AN
     * INDEPENDENT AUDIT, 2026-09-30.** A player resumed past the end of its
     * buffer calls `onEnded` SYNCHRONOUSLY, which reaches `#ended` and `stop()`,
     * which clears the timers and the reading. Scheduling afterwards therefore
     * armed timers for a reading that had just finished, and `onWord` fired after
     * `onDone('ended')`. A seek makes that position reachable, so the case is not
     * theoretical. Re-reading the field is the check: `stop()` nulls it. */
    if (this.#reading !== reading) return
    /* Against the PLAYER's position rather than the wall clock, so a pause of
     * any length lands the next word where the sound does — and so does a
     * reading at a speed other than 1, which `positionMs` already accounts for
     * and a wall clock never could. From the first word NOT YET SAID, so
     * nothing is repeated and nothing is skipped. */
    this.#scheduleFrom(reading, reading.said, reading.playing.positionMs())
  }

  /**
   * Where the reading has got to, and how long it is — or `null` before the
   * render lands.
   *
   * ⚠️ **PUBLISHED BECAUSE SOMETHING HAS TO DRAW A POSITION NOW.** A reading used
   * to be a queue of sentences with no meaningful whole, so there was no such
   * number to publish; one buffer has one. `null` rather than zeros while a
   * render is in flight, because *"nothing is playing yet"* and *"the reading is
   * at the start"* are two different things and a transport that showed 0:00 for
   * both would be lying during the longest wait the app has.
   */
  at(): { readonly positionMs: number; readonly durationMs: number } | null {
    const reading = this.#reading
    if (reading === null) return null
    return { positionMs: reading.playing.positionMs(), durationMs: reading.playing.durationMs }
  }

  /**
   * Where in the section's text the reading is, in characters — or `null` where
   * there is no reading, or no word timings to answer with.
   *
   * ⚠️ **THIS EXISTS SO A SEEK CAN SET THE CURSOR IMMEDIATELY — FOUND BY AN
   * INDEPENDENT AUDIT, 2026-09-30.** A scrub moves the sound and nothing else; the
   * sentence cursor was then set by the next word BOUNDARY, a few hundred
   * milliseconds later, so a reader who scrubbed from sentence 2 to sentence 20
   * and pressed Next Sentence inside that window stepped from 2 to 3. Small, real,
   * and self-correcting — which is why it was worth a reader rather than a second
   * calculation: the speaker already knows which word it landed on.
   *
   * `null` on a Chinese reading, where there are no word timings at all. The
   * caller leaves the cursor alone there, which is the same answer it had before
   * and is correct: sentence stepping is unavailable on that voice anyway.
   */
  spokenOffset(): number | null {
    const reading = this.#reading
    if (reading === null) return null
    /* `said` COUNTS what has been said, so the word at that index is the next one
       — which is where the reading now IS after a seek, and what the band draws. */
    return reading.words[reading.said]?.start ?? reading.words.at(-1)?.start ?? null
  }

  /**
   * Go to a millisecond in the reading.
   *
   * ⚠️ **THE WORD TIMERS ARE REBUILT, NOT LEFT.** They are scheduled once per
   * run, at `word.startMs` from the moment the sound started, so a seek that
   * moved only the sound would leave the highlight walking through the passage
   * the reader has just left — and off the page, which turns it. Same repair
   * `pause`/`resume` needed, for the same reason.
   *
   * Answers whether there was a reading to move. A caller that asks before the
   * render lands is told, rather than left to assume it worked.
   */
  seekToMs(ms: number): boolean {
    const reading = this.#reading
    if (reading === null) return false
    this.#clearTimers()
    reading.playing.seekToMs(ms)
    /* ⚠️ **THE TARGET, NOT A LIVE SAMPLE — FOUND BY AN INDEPENDENT AUDIT.** This
     * read `positionMs()` back AFTER restarting the source, and the context clock
     * can advance between the two: a seek to a word's exact start then reported a
     * position a millisecond past it, `firstWordFrom` counted that word as said,
     * and the word the reader asked for was never highlighted. Reproduced with a
     * 3 ms advance. The CLAMPED target is where the reader asked to be; the live
     * position is only right for the timer delays below, which must be measured
     * from where the sound actually is. */
    const target = Math.min(Math.max(0, Number.isFinite(ms) ? ms : 0), reading.playing.durationMs)
    const at = reading.playing.positionMs()
    /* ⚠️ **`said` IS RE-DERIVED FROM THE POSITION, WHICH IS THE ONE PLACE THIS
     * CLASS COMPARES A WORD AGAINST THE CLOCK.** Everywhere else it COUNTS what
     * has been reported, deliberately — a word at `startMs` 0 on a render held by
     * a pause had never been reported and was dropped silently. A seek is
     * different in kind: the reader has said *start again from there*, so what
     * was reported before is not the question. The first word AT OR AFTER the new
     * position is where the highlight belongs. */
    /* ⚠️ **A SEEK INTO THE MIDDLE OF A WORD HIGHLIGHTS THAT WORD, AND IT USED TO
     * SKIP IT — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `firstWordFrom`
     * answers the first word starting AT OR AFTER the target, which is right when
     * the target is a word's own start and wrong everywhere between two: the
     * sound plays the word the reader landed inside while the band sits on the
     * one before, for as long as that word lasts. A scrubber makes landing
     * mid-word the ORDINARY case rather than an edge — 1 000 steps over a
     * forty-eight-minute section is a step of nearly three seconds, and words are
     * a fraction of that.
     *
     * The word before is the covering one exactly when it has not ENDED yet, and
     * `#scheduleFrom` clamps its delay to zero, so backing up by one both draws it
     * at once and leaves the rest of the schedule alone. */
    const after = firstWordFrom(reading.words, target)
    const before = reading.words[after - 1]
    reading.said = before !== undefined && before.endMs > target ? after - 1 : after
    /* ⚠️ **NO `words.length === 0` BRANCH HERE, AND THERE WAS ONE — FOUND BY THE
       MUTATION SWEEP.** It called `#noWordBoundaries` and returned early, and it
       could never be the first to do either: `#play` reports it the moment a
       render with no words lands, so by the time a seek is possible the flag is
       already set and the call is a no-op. `#scheduleFrom` over an empty list
       schedules nothing, which is the same answer the early return gave. */
    /* Only when there is a sound to follow. Paused, `resume` builds them. */
    if (!this.#paused) this.#scheduleFrom(reading, reading.said, at)
    return true
  }

  /**
   * Go to the word that covers a character offset in the section's text.
   *
   * ⚠️ **THIS IS THE DIRECTION THAT WAS NOT EXPRESSIBLE BEFORE.** The spoken-word
   * band already lives in the book's own document (`#paper-spoken-word`), so the
   * reader tapping a word has always had an offset to give — what was missing was
   * anywhere to put it, because an utterance was one sentence and a position
   * inside another one meant nothing. One buffer for the section makes the
   * reverse direction a search in `words`.
   *
   * Answers whether it moved. `false` means either no reading or no word timings
   * at all, which on a Chinese pack is the ordinary case — Qwen answers none, so
   * a Chinese reading cannot be seeked by word and says so rather than guessing.
   */
  seekToOffset(offset: number): boolean {
    const reading = this.#reading
    /* ⚠️ **NO `words.length === 0` HERE, AND THERE WAS ONE — FOUND BY THE MUTATION
       SWEEP.** `wordAtOffset` answers `null` for an empty list, which this already
       turns into `false`, so the clause could never be the thing that refused. A
       guard in front of a lookup that answers the same way is the shape this
       repository removes rather than keeps. */
    if (reading === null) return false
    const at = wordAtOffset(reading.words, offset)
    if (at === null) return false
    return this.seekToMs(reading.words[at]!.startMs)
  }

  /**
   * Go to a fraction of the way through the reading — 0 is the start, 1 the end.
   *
   * Works with no word timings at all, which is why it is separate from
   * `seekToOffset`: a Chinese reading can be scrubbed even though it cannot be
   * followed.
   */
  seekToFraction(fraction: number): boolean {
    const reading = this.#reading
    if (reading === null) return false
    const share = Number.isFinite(fraction) ? Math.min(Math.max(0, fraction), 1) : 0
    return this.seekToMs(share * reading.playing.durationMs)
  }

  /** End the reading. `onDone` is NOT called: the caller already knows. */
  stop(): void {
    /* The token moves FIRST, so a render already in flight cannot play when it
     * lands. Stopping the player alone would leave that render to start a
     * sound nobody asked for, seconds later. */
    this.#current = {}
    this.#paused = false
    /* ⚠️ **IT NEVER RESET, SO THE SECOND BOUNDARYLESS READING SAID NOTHING —
     * FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `onNoBoundaries` is the
     * engine telling the reading that no highlight is coming, and `useSpeech`
     * answers it by setting `followsWords` false. `start()` sets that flag back
     * to TRUE for every new reading — so a second Chinese chapter reported
     * nothing, and the hook went on publishing `followsWords: true` over a
     * reading that has no words at all. Once per READING, not once per speaker.
     *
     * ⚠️ **AND THE FLAG THAT USED TO BE RESET HERE IS GONE — FOUND BY THE MUTATION
     * SWEEP.** `#noWordBoundaries` guarded itself against a second call within one
     * reading, and once the seek stopped making one there was no second call left
     * to guard: both callers are mutually exclusive branches of `#play`, which
     * runs once per reading. The guard, the flag and this reset were three lines
     * saying what the control flow already said, and every mutant of them
     * survived. Once per reading is now a property of where it is CALLED. */
    this.#clearTimers()
    this.#reading?.playing.stop()
    this.#reading = null
  }

  async #render(request: SpeechRequest): Promise<SpokenAudio> {
    let timer: ReturnType<typeof setTimeout> | undefined
    /* SCALED TO THE PASSAGE — see `RENDER_PER_CHAR_MS`, which records what a flat
       two minutes cost once a section became the unit. */
    const deadline = deadlineFor(request.text)
    const limit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the voice did not answer')), deadline)
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
 * The request for a section.
 *
 * ⚠️ **ONE CALLER NOW, AND THAT IS THE POINT OF IT.** There were two — `speak`
 * and `prepare` — each building its own, and two spellings of one request were
 * two spellings of the cache key `keyOf` derived from it. The failure was silent:
 * a prepared render whose key differed from the spoken one was simply never
 * reused, so the look-ahead cost a whole render and saved nothing while
 * everything looked right. `prepare` and `keyOf` are both deleted; the store's
 * own key is the only one there is now, and the plugin computes it.
 */
function requestFor(
  voice: EngineVoice,
  text: string,
  clip: ClipKey,
  prefs: SpeakPrefs,
): SpeechRequest {
  return {
    packId: voice.packId,
    voiceId: voice.voiceId,
    text,
    clip,
    ...(prefs.rate === undefined ? {} : { rate: prefs.rate }),
  }
}

/**
 * How many words are entirely before `positionMs` — which is what `said` counts.
 *
 * A BINARY SEARCH rather than a walk, because a section is thousands of words and
 * a seek may be a drag on a scrubber: the character-weighted median section of
 * this shelf answered 7 899 words in WI-34.0, and a linear scan per frame of a
 * drag is 7 899 comparisons a frame for an answer eleven get.
 *
 * ⚠️ **THE WORDS ARE IN ORDER, AND WI-34.0 IS WHAT SAYS SO** — monotonic on
 * `startMs` AND on `endMs`, measured over a real 48-minute section. A binary
 * search over an unordered array answers confidently and wrongly, so that
 * measurement is this function's precondition rather than an assumption.
 */
export function firstWordFrom(words: readonly SpokenAudio['words'][number][], positionMs: number): number {
  let low = 0
  let high = words.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (words[middle]!.startMs < positionMs) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * The word whose text covers `offset`, or the first one after it — `null` when
 * the offset is past every word.
 *
 * ⚠️ **`start` AND `length` ARE UTF-16 CODE UNITS**, which is what the engines
 * answer in and what a web front end counts in. So an offset taken from a DOM
 * range is in the same unit with no conversion, which is the whole reason the
 * plugin reports them that way.
 */
export function wordAtOffset(
  words: readonly SpokenAudio['words'][number][],
  offset: number,
): number | null {
  /* ⚠️ **NO `words.length === 0` CLAUSE, AND THERE WAS ONE — FOUND BY THE MUTATION
     SWEEP.** The search below starts at `low = 0` and `high = 0` for an empty
     list, so it falls straight through to the `low < words.length` test and
     answers `null` anyway. Two ways to say one thing, and only one of them
     observable. */
  if (!Number.isFinite(offset)) return null
  const wanted = Math.max(0, offset)
  /* The same binary search, on the other axis: the first word that has not
     ENDED before the offset. A word that contains it is that word; an offset in
     the whitespace between two is the later one, which is where a reader who
     tapped a gap most plausibly meant. */
  let low = 0
  let high = words.length
  while (low < high) {
    const middle = (low + high) >> 1
    const word = words[middle]!
    if (word.start + word.length <= wanted) low = middle + 1
    else high = middle
  }
  return low < words.length ? low : null
}
